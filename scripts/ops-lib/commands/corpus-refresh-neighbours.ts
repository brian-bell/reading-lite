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
  readListIndex: (deps: R2Deps) => Promise<RefreshRow[]>;
  readManifest: (keyPrefix: string, deps: R2Deps) => Promise<any | null>;
  queryByVectorId: (
    index: string,
    id: string,
    topK: number,
    namespace?: string,
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
    out: "refresh-report.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--execute") opts.execute = true;
    else if (a === "--sole-writer") opts.soleWriter = true;
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

  const items = await r2.readListIndex(r2Deps);
  const plan = planRefresh(items, { only: opts.only, limit: opts.limit });
  const reportPath = path.resolve(opts.out);
  const now = new Date(deps.now()).toISOString();

  io.stdout(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
  io.stdout(`Vectorize: ${vectorizeIndex}`);
  io.stdout(describeBackend(choice));
  io.stdout(`Corpus: ${items.length} readings`);
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

  if (!opts.execute) {
    io.stdout("\nPLAN — corpus unchanged. Re-run with --execute to refresh drifted snapshots.");
  }
  return 0;
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

Options:
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
        return items as RefreshRow[];
      },
      readManifest: async (kp, d) => (await import("../../corpus-lib/wrangler-r2")).readManifest(kp, d),
      queryByVectorId: async (index, id, topK, namespace) =>
        (await import("../../corpus-lib/wrangler-r2")).queryByVectorId(index, id, topK, { namespace }),
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
        readManifest: async (kp, d) => (await lazy()).readManifest(kp, d),
        queryByVectorId: async (index, id, topK, ns) =>
          (await lazy()).queryByVectorId(index, id, topK, ns),
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
