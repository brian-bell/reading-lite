// `ops corpus refresh-neighbours` — tier-1 corpus refresh: re-measure every
// ready reading against Vectorize and emit the staleness report that later
// judgement slices consume.
//
// Zero LLM / embedding spend: each reading is queried by the vector it already
// owns (`--vector-id`). Plan-first: a mode-less run reads, scores, prints the
// inventory, and writes refresh-report.json; --execute (which requires
// --sole-writer, because the closing index/list.json flush is an unguarded
// read-merge-write on the wrangler fallback, conditional only on the direct path)
// also rewrites drifted `manifest.similarity` snapshots with the same
// one-field discipline as `corpus backfill-similarity`. After a successful putManifest, the list row is
// the resumability marker for index/list.json: a retry that finds a current
// manifest and a stale list row copies manifest.similarity onto the row —
// never the fresh measurement, which can differ within the epsilon. A null,
// unparseable, or ManifestSchema-invalid manifest is a failed measurement in
// both modes — connections are not on the list row, and a schema-drifted
// manifest would skew the diff (storedConnections drops malformed entries,
// inventing new_neighbour or hiding stale_connection).
//
// What the pass measures is a separate decision from how it measures it.
// --full (the default) is every ready reading; --since-last-run narrows to the
// readings whose neighbourhood could have moved since the run marker at
// index/refresh-state.json, which this command reads, hands to the pure planner
// in corpus-lib/refresh-scope.ts along with one reverse-neighbour query per
// changed reading, and advances only after a complete --execute pass.

import path from "node:path";
import { loadDotVars } from "../../lib/dotvars";
import {
  buildRefreshReport,
  buildReportReading,
  diffNeighbourhood,
  planRefresh,
  resolveJudgedAt,
  snapshotChanged,
  type RefreshNeighbour,
  type RefreshReportReading,
  type RefreshRow,
} from "../../corpus-lib/refresh-neighbours";
import {
  REVERSE_TOP_K,
  buildRefreshState,
  changedSince,
  describeScope,
  incrementalScope,
  parseRefreshState,
  type RefreshScope,
  type RefreshState,
  type ReverseMatches,
} from "../../corpus-lib/refresh-scope";
import { snapshotFor, validateBackfillWrite } from "../../corpus-lib/backfill-similarity";
import { SIMILAR_TOP_K, tenantVectorId } from "../../../src/modules/stores/similarity-store";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import { operatorTenantSelector } from "../../corpus-lib/tenant";
import { soleWriterGuard } from "../../corpus-lib/sole-writer";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";
import { mergeListRows as mergeRowPatches, type ListRowPatch } from "../list-index-cas";
import {
  createRefreshTimer,
  printTiming,
  timedNeighboursR2,
  type RefreshTimer,
} from "../refresh-timing";
import {
  chooseNeighboursBackend,
  describeBackend,
  type BackendChoice,
  type NeighboursBackend,
} from "../neighbours-r2";

export interface CorpusRefreshNeighboursR2 {
  /**
   * The live index and, where the backend has one, its ETag — the token an
   * incremental run compares against its marker to recognise an untouched
   * corpus. The wrangler CLI exposes no ETag, so that path returns none and the
   * scope falls back to the row timestamps.
   */
  readListIndex: (deps: R2Deps) => Promise<{ items: RefreshRow[]; etag?: string }>;
  /** The stored run marker, unparsed; `null` only when confirmed absent. */
  readRefreshState: (deps: R2Deps) => Promise<unknown | null>;
  writeRefreshState: (state: RefreshState, deps: R2Deps) => Promise<void>;
  readManifest: (keyPrefix: string, deps: R2Deps) => Promise<any | null>;
  queryByVectorId: (
    index: string,
    id: string,
    topK: number,
    namespace?: string,
    opts?: { metadata?: boolean },
  ) => Promise<RefreshNeighbour[] | null>;
  putManifest: (keyPrefix: string, body: unknown, deps: R2Deps) => Promise<void>;
  /**
   * Applies this run's `similarity` snapshots to index/list.json, merging them
   * onto the live document rather than putting back the rows read at the start
   * of the pass.
   */
  mergeListRows: (patches: ListRowPatch[], deps: R2Deps) => Promise<void>;
}

export interface CorpusRefreshNeighboursDeps extends BaseDeps {
  /** The wrangler-backed storage path. Always present; the fallback. */
  r2: CorpusRefreshNeighboursR2;
  /**
   * The direct (S3/REST) path, built lazily so a wrangler run resolves no
   * credentials and constructs no client. Absent means this environment has no
   * direct path at all, which is how the command's own tests inject one fake.
   */
  directR2?: () => CorpusRefreshNeighboursR2;
  /** Credentials consulted to auto-select a backend. Default: none. */
  storageVars?: () => Record<string, string | undefined>;
  now: () => number;
  mkdir: (dir: string) => Promise<void>;
  writeFile: (filePath: string, body: string) => Promise<void>;
}

interface Opts {
  tenant?: string;
  via?: NeighboursBackend;
  only: string[];
  bucket: string;
  vectorizeIndex?: string;
  remote: boolean;
  execute: boolean;
  soleWriter: boolean;
  /** False only under --since-last-run: full is the default until the proof lands. */
  full: boolean;
  fullExplicit: boolean;
  limit?: number;
  out: string;
}

function parseRefreshArgs(argv: string[]): Opts {
  const opts: Opts = {
    only: [],
    bucket: process.env.READING_LITE_BUCKET ?? "reading-lite",
    remote: true,
    execute: false,
    soleWriter: false,
    full: true,
    fullExplicit: false,
    out: "refresh-report.json",
  };
  let sinceLastRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--execute") opts.execute = true;
    else if (a === "--sole-writer") opts.soleWriter = true;
    else if (a === "--full") opts.fullExplicit = true;
    else if (a === "--since-last-run") sinceLastRun = true;
    else if (a === "--local") opts.remote = false;
    else if (a === "--bucket") opts.bucket = requireValue(argv[++i], a);
    else if (a === "--tenant") opts.tenant = requireValue(argv[++i], a);
    else if (a === "--vectorize") opts.vectorizeIndex = requireValue(argv[++i], a);
    else if (a === "--via") opts.via = parseVia(requireValue(argv[++i], a));
    else if (a === "--out") opts.out = requireValue(argv[++i], a);
    else if (a === "--limit") opts.limit = parsePositiveInt(requireValue(argv[++i], a));
    else if (a.startsWith("--")) throw new UsageError(`unknown flag: ${a}`);
    else opts.only.push(a);
  }
  // The local miniflare bucket exists only inside wrangler, so no direct client
  // can reach it. Fail as usage rather than silently ignoring one of the flags.
  if (opts.via === "direct" && !opts.remote) {
    throw new UsageError("--via direct cannot be combined with --local");
  }
  // The two scope flags say opposite things; picking one silently would let a
  // nightly cron think it ran incrementally while it swept.
  if (sinceLastRun && opts.fullExplicit) {
    throw new UsageError("--since-last-run cannot be combined with --full");
  }
  opts.full = !sinceLastRun;
  return opts;
}

function parseVia(raw: string): NeighboursBackend {
  if (raw === "wrangler" || raw === "direct") return raw;
  throw new UsageError(`--via "${raw}" is not one of: direct, wrangler`);
}

function requireValue(v: string | undefined, flag: string): string {
  if (v === undefined) throw new UsageError(`${flag} requires a value`);
  return v;
}

function parsePositiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--limit "${raw}" is not a positive integer`);
  return n;
}

function normalizeVectorMatchIds(
  matches: RefreshNeighbour[],
  namespace: string | undefined,
): RefreshNeighbour[] {
  if (namespace === undefined) return matches;
  const prefix = `${namespace}:`;
  return matches.map((match) => ({
    ...match,
    id: match.id.startsWith(prefix) ? match.id.slice(prefix.length) : match.id,
  }));
}

function mergeReading(item: RefreshRow, manifest: Record<string, unknown>): RefreshRow {
  return { ...item, ...(manifest as unknown as RefreshRow), key_prefix: item.key_prefix, id: item.id, url: item.url };
}

function isManifestObject(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

/**
 * Resolves the requested backend against what this environment actually has.
 * The header must never name a path the pass did not take, so an environment
 * with no direct client (the command's own tests) reports the fallback it used
 * rather than the one it would have picked.
 */
function selectStorage(
  opts: Opts,
  deps: CorpusRefreshNeighboursDeps,
): { choice: BackendChoice; storage: CorpusRefreshNeighboursR2 } {
  const requested = chooseNeighboursBackend({
    ...(opts.via === undefined ? {} : { via: opts.via }),
    local: !opts.remote,
    vars: deps.storageVars?.() ?? {},
  });
  const direct = deps.directR2;
  if (requested.backend !== "direct") return { choice: requested, storage: deps.r2 };
  if (direct === undefined) {
    return {
      choice: { backend: "wrangler", reason: `${requested.reason}, but no direct client available` },
      storage: deps.r2,
    };
  }
  return { choice: requested, storage: direct() };
}

/**
 * Consecutive failed reverse queries after which the pass stops scoping and
 * sweeps. Small: a run of failures is a credential or an index name, not luck.
 */
const REVERSE_QUERY_FAILURE_BUDGET = 3;

/**
 * How the operator narrowed this pass below its scope, for the report header.
 * A `--limit` that was never reached narrowed nothing, and saying otherwise
 * would have the report call a pass partial while the marker records it as
 * complete.
 */
function narrowedBy(opts: Opts, truncated: boolean): string | undefined {
  const parts: string[] = [];
  if (opts.only.length > 0) parts.push(`--only (${opts.only.length} id(s))`);
  if (truncated && opts.limit !== undefined) parts.push(`--limit ${opts.limit}`);
  return parts.length === 0 ? undefined : parts.join(", ");
}

/**
 * The stored run marker, or `null` for "measure everything". A marker that
 * cannot be read is reported and treated as absent: the pass then sweeps, which
 * is the safe direction — the alternative, aborting, turns a transient R2 blip
 * into a night with no refresh at all.
 */
async function readMarker(
  r2: CorpusRefreshNeighboursR2,
  r2Deps: R2Deps,
  stderr: (line: string) => void,
): Promise<RefreshState | null> {
  let raw: unknown;
  try {
    raw = await r2.readRefreshState(r2Deps);
  } catch (e) {
    stderr(`  ! run marker unreadable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (raw === null) return null;
  const state = parseRefreshState(raw);
  if (state === null) stderr("  ! run marker is not a usable refresh state");
  return state;
}

/**
 * The incremental scope: which readings this pass has to measure. The reverse
 * queries are made here and handed to the pure planner as data, so every scope
 * rule stays unit-testable without an index.
 *
 * A reverse query that fails leaves its id out of the map, which the planner
 * reads as "the scope cannot be trusted" and escalates. Nothing about a failed
 * scoping query is allowed to shrink the pass.
 */
async function resolveScope(args: {
  r2: CorpusRefreshNeighboursR2;
  io: CommandIo;
  items: RefreshRow[];
  marker: RefreshState | null;
  tenant: { namespace?: string };
  vectorizeIndex: string;
  listEtag?: string;
}): Promise<RefreshScope> {
  const { r2, io, items, marker, tenant, vectorizeIndex, listEtag } = args;
  const base = changedSince(items, marker, listEtag);
  if (base.kind === "full") return base;

  const reverse = new Map<string, ReverseMatches>();
  const statusById = new Map(items.map((row) => [row.id, row.status]));
  let consecutiveFailures = 0;
  for (const id of base.changed) {
    // Every changed reading is queried, whatever its status says. Status is not
    // a statement about vector ownership — a reprocess-in-flight `pending` row
    // and a `failed` row over a previously-ready reading can both still have a
    // live indexed vector, and that vector's neighbours are exactly who needs
    // re-measuring. `queryByVectorId` answers null for a genuinely absent
    // vector, which is the honest version of the same shortcut.
    try {
      const matches = await r2.queryByVectorId(
        vectorizeIndex,
        tenantVectorId(tenant.namespace, id),
        REVERSE_TOP_K,
        tenant.namespace,
        { metadata: false },
      );
      // Both storage paths must hand the planner the same thing for the same
      // corpus, or `--via` would decide whether a night sweeps. The wrangler
      // adapter reports a missing vector through its stderr phrase and can
      // still return an empty array; the direct one turns empty into null. An
      // empty reverse set is meaningless either way — a vector that exists
      // matches itself — so both spellings become null here.
      const parsed =
        matches === null || matches.length === 0
          ? null
          : normalizeVectorMatchIds(matches, tenant.namespace).map((match) => ({
              id: match.id,
              score: match.score,
            }));
      // Only worth a line when it changes the outcome. A pending or failed
      // reading owning no vector is an ordinary night — saying so once per
      // ingested reading would make stderr useless as an alerting signal.
      if (parsed === null && statusById.get(id) === "ready") {
        io.stderr(`  ! no reverse neighbourhood for ready reading ${id}`);
      }
      reverse.set(id, parsed);
    } catch (e) {
      // One failure does not end the loop, because the reason is meant to carry
      // how many changed readings saturated, and abandoning it would report
      // every remaining id as unanswered and no saturations at all.
      //
      // A run of them does. The list read and the query use different halves of
      // the credential — R2 for one, the Vectorize token and index name for the
      // other — so an expired token or a mistyped index passes the read and
      // then fails every query. Without a stop that costs one failing query per
      // changed reading before the sweep, which then pays another per ready
      // reading: more than the full pass this flag exists to avoid.
      io.stderr(
        `  ! reverse-neighbour query failed for ${id}: ${e instanceof Error ? e.message : String(e)}`,
      );
      consecutiveFailures++;
      if (consecutiveFailures >= REVERSE_QUERY_FAILURE_BUDGET) {
        io.stderr(
          `  ! ${consecutiveFailures} reverse-neighbour queries failed in a row — sweeping instead`,
        );
        break;
      }
      continue;
    }
    consecutiveFailures = 0;
  }
  return incrementalScope(items, marker, reverse, listEtag);
}

// The block prints in a finally: the passes worth timing most are the ones
// that end in a thrown stale-report or storage error, having already spent
// minutes of reads.
async function runCorpusRefreshNeighbours(
  argv: string[],
  deps: CorpusRefreshNeighboursDeps,
): Promise<number> {
  const opts = parseRefreshArgs(argv);
  const timer = createRefreshTimer(deps.now);
  try {
    return await refreshNeighbours(opts, deps, timer);
  } finally {
    printTiming(timer, deps.io.stdout);
  }
}

async function refreshNeighbours(
  opts: Opts,
  deps: CorpusRefreshNeighboursDeps,
  timer: RefreshTimer,
): Promise<number> {
  const { io } = deps;
  // Which storage path this pass runs over. Selected before any read so the
  // header names the path the numbers below it belong to, and so a credential
  // failure surfaces up front rather than after minutes of reads.
  const { choice, storage } = selectStorage(opts, deps);
  const r2 = timedNeighboursR2(storage, timer);
  const vectorizeIndex = opts.vectorizeIndex ?? opts.bucket;
  const tenant = requireOperatorTenant(opts.tenant);
  // --execute ends in a read-merge-write of index/list.json. The merge no
  // longer reverts rows this pass never measured, and the direct path guards
  // it with If-Match; the wrangler fallback has no conditional put, so a
  // concurrent write landing inside its read→put window is still lost. Same
  // flag the tier-2/3 refresh commands require.
  const soleWriter = soleWriterGuard({
    execute: opts.execute,
    acknowledged: opts.soleWriter,
    tool: "ops corpus refresh-neighbours",
  });
  if (soleWriter.message) io.stderr(soleWriter.message);
  if (!soleWriter.proceed) throw new UsageError("--execute requires --sole-writer");
  const r2Deps: R2Deps = { bucket: opts.bucket, keyRoot: tenant.keyRoot, remote: opts.remote };
  const tenantSelector = operatorTenantSelector(tenant);

  // Before the list read, not after: the marker this pass may store has to be
  // no newer than the data it describes. A reading activated between the two
  // would otherwise carry an `updated_at` older than the marker and never enter
  // the next incremental scope.
  const now = new Date(deps.now()).toISOString();
  // Read on both paths. A full pass does not scope against it, but it does
  // overwrite it, and a marker built from `previous: null` can only ever
  // re-derive the fields this pass happens to compute — the next forward-only
  // field added here would be dropped by every sweep.
  const marker = await readMarker(r2, r2Deps, io.stderr);
  const { items, etag: listEtag } = await r2.readListIndex(r2Deps);
  // Named ids override the scope (planRefresh), so resolving one would spend a
  // reverse query per changed reading on an answer that cannot change which
  // readings are measured. `full` here means the same thing it means under
  // --limit: not narrowed by the marker.
  const scope: RefreshScope =
    opts.full || opts.only.length > 0
      ? { kind: "full", reason: opts.full ? "--full" : `--only names ${opts.only.length} reading(s)` }
      : await resolveScope({ r2, io, items, marker, tenant, vectorizeIndex, listEtag });
  const plan = planRefresh(items, {
    only: opts.only,
    limit: opts.limit,
    ...(scope.kind === "incremental" ? { scope: new Set(scope.ids) } : {}),
  });
  const reportPath = path.resolve(opts.out);

  io.stdout(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
  io.stdout(`Vectorize: ${vectorizeIndex}`);
  for (const line of describeBackend(choice)) io.stdout(line);
  io.stdout(describeScope(scope));
  io.stdout(`Corpus: ${items.length} readings`);
  // In-scope rows only, under --since-last-run; `Corpus` above is the whole list.
  io.stdout(`Not ready (skipped, own no vector): ${plan.skippedNotReady}`);
  io.stdout(`To measure: ${plan.targets.length}`);
  io.stdout(`Mode: ${opts.execute ? "EXECUTE" : "PLAN"}`);
  io.stdout(`Report: ${reportPath}\n`);

  const scored = new Map<string, ReturnType<typeof snapshotFor>>();
  const flagged: RefreshReportReading[] = [];
  let measured = 0;
  let drifted = 0;
  let noVector = 0;
  let errored = 0;
  let invalid = 0;

  const flushIndex = async (): Promise<void> => {
    if (!opts.execute || scored.size === 0) return;
    const patches: ListRowPatch[] = [...scored].map(([id, similarity]) => ({ id, similarity }));
    await r2.mergeListRows(patches, r2Deps);
    io.stdout(`index/list.json updated (${scored.size} row(s) merged).`);
  };

  let flushFailed = false;
  try {
    for (const t of plan.targets) {
      let matches: RefreshNeighbour[] | null;
      try {
        matches = await r2.queryByVectorId(
          vectorizeIndex,
          tenantVectorId(tenant.namespace, t.id),
          SIMILAR_TOP_K + 1,
          tenant.namespace,
        );
      } catch (e) {
        errored++;
        io.stderr(`  ! vectorize query failed for ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (matches === null) {
        noVector++;
        io.stderr(`  ! no vector indexed for ${t.id}  ${t.url}`);
        continue;
      }
      const normalized = normalizeVectorMatchIds(matches, tenant.namespace);
      const snap = snapshotFor(t.id, normalized, now);

      // Connections (and tensions) live on the manifest, not the list row.
      // A null here is either a missing object or a lenient wrangler miss, and
      // a throw is unparseable JSON: both are failed measurements. Diffing the
      // list row would invent an empty cited set and drop stale_connection.
      let manifest: unknown = null;
      try {
        manifest = await r2.readManifest(t.key_prefix, r2Deps);
      } catch (e) {
        errored++;
        io.stderr(`  ! manifest unparseable for ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (!isManifestObject(manifest)) {
        errored++;
        io.stderr(`  ! manifest unreadable for ${t.id}`);
        continue;
      }
      // Manifest reads are always parsed (AGENTS.md): the diff below trusts
      // connections/novelty_verdict, and storedConnections silently drops any
      // malformed entry. Validate the candidate (stored manifest + fresh
      // snapshot) rather than the raw read, so a manifest whose only defect is
      // a malformed similarity is still repaired by this very write.
      const check = validateBackfillWrite(manifest, snap);
      if (!check.ok) {
        invalid++;
        io.stderr(`  ! manifest fails ManifestSchema for ${t.id}: ${check.error}`);
        continue;
      }

      measured++;
      const reading = mergeReading(t, manifest);
      const judged = resolveJudgedAt(reading);
      const reasons = diffNeighbourhood(reading, normalized, items, judged.judged_at);
      // Manifest-wins for whether the stored snapshot needs a rewrite; the list
      // row is the resumability marker for index/list.json. After a successful
      // putManifest and a failed flush, a retry sees a current manifest and a
      // stale list row — queue that row for the flush without rewriting the
      // manifest (the same heal backfill-similarity gets from planBackfill).
      const manifestDrifted = snapshotChanged(reading.similarity, snap);
      const listDrifted = snapshotChanged(t.similarity, snap);
      if (manifestDrifted) drifted++;

      const score = snap.max === undefined ? "none" : snap.max.toFixed(3);
      const reasonText = reasons.length === 0 ? "fresh" : reasons.join(",");
      const driftLabel = manifestDrifted ? "snapshot-drift" : listDrifted ? "list-stale" : "snapshot-ok";
      io.stdout(
        `  ${t.id}  neighbours=${snap.count} nearest=${score}  ${driftLabel}  ${reasonText}  ${t.url}`,
      );

      if (reasons.length > 0) {
        flagged.push(buildReportReading(reading, normalized, items, reasons, judged));
      }

      if (!opts.execute) continue;

      if (manifestDrifted) {
        try {
          await r2.putManifest(t.key_prefix, check.manifest, r2Deps);
        } catch (e) {
          errored++;
          io.stderr(`  ! manifest write failed for ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        scored.set(t.id, snap);
      } else if (listDrifted && reading.similarity !== undefined) {
        // Within the epsilon the fresh measurement can differ from what the
        // manifest stores; the heal restores row/manifest lockstep, so it
        // copies the manifest's snapshot, never the fresh one.
        scored.set(t.id, reading.similarity);
      }
    }
  } catch (e) {
    errored++;
    io.stderr(`  ! refresh pass aborted: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // Catch a failed flush so already-flagged rows still reach refresh-report.json.
    // Re-querying Vectorize just to emit the tier-2 contract is the cost this
    // avoids; list.json heals on the next --execute from the list-row marker.
    try {
      await flushIndex();
    } catch (e) {
      flushFailed = true;
      io.stderr(`  ! index/list.json rewrite failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const report = buildRefreshReport({
    generatedAt: now,
    tenant: tenantSelector,
    // Recorded in the header because an incremental report is a statement about
    // its scope, not about the corpus: a reading absent from it was either
    // measured and found fresh, or never looked at this run.
    scope: {
      kind: scope.kind,
      reason: scope.reason,
      ...(scope.kind === "incremental"
        ? { since: scope.since, readings_in_scope: scope.ids.length }
        : {}),
      // A pass narrowed by hand covers neither the corpus nor its scope, and
      // the report is the only place a later reader can learn that.
      ...(narrowedBy(opts, plan.truncated) === undefined
        ? {}
        : { narrowed_by: narrowedBy(opts, plan.truncated) }),
    },
    readings: flagged,
  });
  await deps.mkdir(path.dirname(reportPath));
  await deps.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");

  io.stdout(`\nMeasured: ${measured}${opts.execute ? `, snapshots written: ${scored.size}` : ""}`);
  io.stdout(`Snapshot drift: ${drifted}`);
  io.stdout(`Flagged for judgement: ${flagged.length}`);
  io.stdout(`Wrote ${reportPath} (${flagged.length} reading(s)).`);
  if (noVector > 0) {
    io.stdout(
      `No vector indexed: ${noVector} — these are ready readings whose vector was ` +
      `never written or has been removed. They cannot be scored without re-embedding.`,
    );
  }
  if (errored > 0) {
    io.stdout(`Failed measurements: ${errored} — these readings were not ${opts.execute ? "refreshed" : "measured"}.`);
  }
  if (invalid > 0) {
    io.stdout(
      `Manifests failing ManifestSchema: ${invalid} — skipped rather than rewritten, ` +
      `so they stay visible to a later repair.`,
    );
  }

  const failed = noVector + errored + invalid;
  if (flushFailed || errored > 0 || invalid > 0 || (opts.execute && failed > 0)) {
    if (flushFailed) {
      io.stderr("\nindex/list.json rewrite failed — run incomplete (report written).");
    }
    if (errored > 0 || invalid > 0 || (opts.execute && failed > 0)) {
      const n = opts.execute ? failed : errored + invalid;
      io.stderr(
        `\n${n} of ${plan.targets.length} attempted reading(s) were not ${opts.execute ? "refreshed" : "measured"} — run incomplete.`,
      );
    }
    return 1;
  }

  await advanceMarker({
    opts,
    r2,
    r2Deps,
    io,
    marker,
    scope,
    items,
    truncated: plan.truncated,
    // The flush rewrote index/list.json, so the ETag this pass read is already
    // superseded. Recording it would be recording a token no future read can
    // ever match; the next run falls back to the row timestamps instead.
    ...(scored.size > 0 || listEtag === undefined ? {} : { listEtag }),
    runAt: now,
  });

  if (!opts.execute) {
    io.stdout("\nPLAN — corpus unchanged. Re-run with --execute to refresh drifted snapshots.");
  }
  return 0;
}

/**
 * Stores the run marker the next incremental pass scopes against.
 *
 * Only a complete --execute pass may advance it, because the marker asserts
 * something stronger than "we looked": every reading in scope was measured AND
 * whatever drifted was written. A plan pass writes no snapshot, --only names a
 * subset, and --limit leaves the marker alone only when it actually cut the
 * plan short — a limit used as a runaway-cost valve and never reached has
 * measured its whole scope. Failures already returned non-zero before this
 * point.
 *
 * `last_full_run_at` moves only on a full sweep — it is what a weekly-sweep
 * policy is judged against.
 */
async function advanceMarker(args: {
  opts: Opts;
  r2: CorpusRefreshNeighboursR2;
  r2Deps: R2Deps;
  io: CommandIo;
  marker: RefreshState | null;
  scope: RefreshScope;
  items: RefreshRow[];
  /** True when --limit actually cut the plan short. */
  truncated: boolean;
  listEtag?: string;
  runAt: string;
}): Promise<void> {
  const { opts, io } = args;
  if (!opts.execute) return;
  if (opts.only.length > 0 || args.truncated) {
    io.stdout("Run marker unchanged: this pass measured a subset of its scope.");
    return;
  }
  const state = buildRefreshState({
    previous: args.marker,
    runAt: args.runAt,
    full: args.scope.kind === "full",
    listRowCount: args.items.length,
    ...(args.listEtag === undefined ? {} : { listEtag: args.listEtag }),
  });
  try {
    await args.r2.writeRefreshState(state, args.r2Deps);
    io.stdout(`Run marker updated (${state.last_run_at}).`);
  } catch (e) {
    // Not a failed run: every snapshot this pass owed the corpus is written.
    // The cost of a lost marker is the next pass sweeping instead of scoping.
    io.stderr(
      `  ! run marker write failed: ${e instanceof Error ? e.message : String(e)} — ` +
      "the next incremental run will sweep.",
    );
  }
}

// Credentials the direct path may use, in the same precedence the tier-2/3
// refresh commands read them with, so one `.corpus.vars` drives all three.
function defaultStorageVars(): Record<string, string | undefined> {
  return {
    ...loadDotVars(".dev.vars"),
    ...loadDotVars(".prd.vars"),
    ...loadDotVars(".corpus.vars"),
    ...process.env,
  };
}

async function buildDirectR2(): Promise<CorpusRefreshNeighboursR2> {
  const { makeVectorizeClient, r2InventoryClientFromVars } = await import("../../lib/cf-clients");
  const { directNeighboursR2 } = await import("../neighbours-r2");
  const vars = defaultStorageVars();
  const required = (names: string[]): string => {
    for (const name of names) {
      const value = vars[name];
      if (value) return value;
    }
    throw new Error(`missing credential: ${names.join(" or ")} (env or .corpus.vars)`);
  };
  return directNeighboursR2({
    r2: (bucket) => r2InventoryClientFromVars(vars, bucket, globalThis.fetch),
    vectorize: (index, namespace) =>
      makeVectorizeClient(
        {
          accountId: required([
            "CORPUS_VECTORIZE_ACCOUNT_ID",
            "CORPUS_R2_ACCOUNT_ID",
            "CLOUDFLARE_ACCOUNT_ID",
          ]),
          apiToken: required(["CORPUS_CF_API_TOKEN", "CLOUDFLARE_API_TOKEN"]),
          index,
          ...(namespace === undefined ? {} : { namespace }),
        },
        globalThis.fetch,
      ),
  });
}

export const corpusRefreshNeighboursCommand: CommandDefinition<CorpusRefreshNeighboursDeps> = {
  group: "corpus",
  name: "refresh-neighbours",
  summary: "Re-measure similarity snapshots and emit the staleness report (no LLM)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus refresh-neighbours [rd_ID...] [options]

Queries Vectorize with each ready reading's stored vector (no embedding calls)
and diffs the current floored ready-neighbourhood against stored connections
and novelty_verdict. The report distinguishes missing or non-ready citations,
ready citations below the floor, new uncited neighbours, and uncited candidate-set
drift against the latest judged neighbourhood (an older reading entering, or a
rejected candidate later leaving). Prints the
staleness inventory and always writes
refresh-report.json — the input contract for later judgement slices.

--execute --sole-writer rewrites only drifted manifest.similarity snapshots (count change or
|Δmax|/|Δmean| ≥ 0.02). It does not change status, vectors, title, tldr, tags,
keywords, entities, or summary_markdown, and it does not re-roll a summary.
A second immediate --execute writes nothing.

Plan by default. The report is written in both modes.

The closing list.json flush merges only the similarity field of the rows this
pass measured onto the live index, so rows written elsewhere while it ran are
kept. The direct path makes that merge an If-Match compare-and-set, retried
with backoff; the wrangler path has no conditional put, so its read-to-put
window is unguarded. Run --execute when nothing is being submitted: it is
refused without --sole-writer for that reason.

The direct path removes the ~0.8s child-process spawn the wrangler path pays on
every Vectorize query and every manifest read, and needs no wrangler at all.

Scope. --full (the default) measures every ready reading, as this command
always has. --since-last-run measures only the readings whose neighbourhood
could have moved since the run marker at index/refresh-state.json: those
created or reprocessed since it, and the reverse neighbourhood of each changed
vector (a topK-${REVERSE_TOP_K} query). It escalates to a
full sweep whenever that reasoning runs out — no marker, rows removed since the
marker, a failed reverse query, or a reverse neighbourhood saturated at topK.
An incremental report is a statement about its scope: a persistent flag on a
reading nobody touched stays invisible until the next full sweep, so run --full
weekly. The scope and its reason are printed and recorded in the report header,
and an escalation names how many changed readings caused it — a corpus that
saturates every night is buying nothing from --since-last-run.

Only a complete --execute pass advances the marker: never a plan pass, never
with --only, and not when --limit actually cut the pass short (a limit carried
as a cost valve and never reached has measured its whole scope, and does
advance it). Naming ids overrides the scope: those readings are measured either
way.

Options:
  --since-last-run    Measure only the readings in scope (see above).
  --full              Measure every ready reading. The default.
  --limit <n>         Cap how many readings are measured this pass.
  --out <path>        Report path. Default: ./refresh-report.json
  --bucket <name>     R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --tenant <selector>  REQUIRED: tenant id (usr_…) or 'global' for the pre-tenant layout.
  --vectorize <idx>   Vectorize index. Default: the bucket name.
  --via <path>        Storage path: 'direct' (Vectorize REST + R2 over S3 or
                      the Cloudflare REST API) or 'wrangler' (a child process
                      per call). Default: direct when CORPUS_R2_* keys or
                      CLOUDFLARE_API_TOKEN are present, wrangler otherwise.
                      --local always uses wrangler; --via direct --local is a
                      usage error. The chosen path is printed in the header.
  --local             Use the local miniflare bucket.
  --execute           Write drifted snapshots and flush the list index.
                      Requires --sole-writer.
  --sole-writer       Required with --execute: assert all corpus writers are paused.
  --help              Show this message.`,
  defaultDeps: (io: CommandIo): CorpusRefreshNeighboursDeps => ({
    io,
    r2: {
      readListIndex: async (d) => {
        const items = await (await import("../../corpus-lib/wrangler-r2")).readListIndex(d);
        // No ETag: `wrangler r2 object get` prints the body and nothing else.
        return { items: items as RefreshRow[] };
      },
      readRefreshState: async (d) =>
        (await import("../../corpus-lib/wrangler-r2")).readRefreshState(d),
      writeRefreshState: async (state, d) =>
        (await import("../../corpus-lib/wrangler-r2")).writeRefreshState(state, d),
      readManifest: async (kp, d) => (await import("../../corpus-lib/wrangler-r2")).readManifest(kp, d),
      queryByVectorId: async (index, id, topK, namespace, opts) =>
        (await import("../../corpus-lib/wrangler-r2")).queryByVectorId(index, id, topK, {
          namespace,
          ...(opts?.metadata === undefined ? {} : { metadata: opts.metadata }),
        }),
      putManifest: async (kp, body, d) => (await import("../../corpus-lib/wrangler-put")).putManifest(kp, body, d),
      // Read-merge-write over wrangler, which offers no conditional put: the
      // merge is against the list index as it stands at flush time, so rows the
      // pass never measured survive, but the window between this read and the
      // put is unguarded. That window is the remaining reason --execute wants a
      // sole-writer window here; the tier-2 flush closes it with If-Match.
      mergeListRows: async (patches, d) => {
        const { readListIndex, writeListIndex } = await import("../../corpus-lib/wrangler-r2");
        const live = (await readListIndex(d)) as RefreshRow[];
        await writeListIndex(mergeRowPatches(live, patches) as never, d);
      },
    },
    // Built on demand: a wrangler pass and `--help` must resolve no credentials
    // and load no client module.
    directR2: () => {
      let built: CorpusRefreshNeighboursR2 | undefined;
      const lazy = async (): Promise<CorpusRefreshNeighboursR2> => {
        if (built === undefined) built = await buildDirectR2();
        return built;
      };
      return {
        readListIndex: async (d) => (await lazy()).readListIndex(d),
        readRefreshState: async (d) => (await lazy()).readRefreshState(d),
        writeRefreshState: async (state, d) => (await lazy()).writeRefreshState(state, d),
        readManifest: async (kp, d) => (await lazy()).readManifest(kp, d),
        queryByVectorId: async (index, id, topK, ns, opts) =>
          (await lazy()).queryByVectorId(index, id, topK, ns, opts),
        putManifest: async (kp, body, d) => (await lazy()).putManifest(kp, body, d),
        mergeListRows: async (patches, d) => (await lazy()).mergeListRows(patches, d),
      };
    },
    storageVars: defaultStorageVars,
    now: () => Date.now(),
    mkdir: async (dir) => {
      const { promises: fs } = await import("node:fs");
      await fs.mkdir(dir, { recursive: true });
    },
    writeFile: async (filePath, body) => {
      const { promises: fs } = await import("node:fs");
      await fs.writeFile(filePath, body);
    },
  }),
  run: runCorpusRefreshNeighbours,
};
