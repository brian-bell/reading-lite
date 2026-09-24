// `ops corpus refresh-neighbours` — tier-1 corpus refresh: re-measure the ready
// readings this pass's scope selects (the default is what moved since the run
// marker; --full is every one of them) and emit the staleness report that later
// judgement slices consume.
//
// Zero LLM / embedding spend: each reading is measured from the vector it
// already owns, through the exact pgvector cosine scan over the tenant's rows —
// the same scan the Worker serves `/api/readings/similar` from, so an operator
// pass and the product cannot disagree about a neighbourhood. Plan-first: a
// mode-less run reads, scores, prints the inventory, and writes
// refresh-report.json; --execute also writes the drifted `similarity`
// snapshots.
//
// Before reading-lite-gh347.4.1 the snapshot lived in a manifest and a list
// row, which had to be kept in lockstep: the pass wrote manifest.similarity,
// then merged the same value onto index/list.json, and carried a resumability
// rule for the window between them. The list row IS the reading row now, so one
// UPDATE of one column does both and that whole apparatus is gone.
//
// What the pass measures is a separate decision from how it measures it.
// The default (--since-last-run, and its absence) narrows to the readings whose
// neighbourhood could have moved since the run marker, which this command reads
// from `corpus_refresh_state`, hands to the pure planner in
// corpus-lib/refresh-scope.ts along with one reverse-neighbour query per
// changed reading, and advances only after a complete --execute pass. --full is
// every ready reading: the explicit weekly sweep the narrowed scope defers work
// to.

import path from "node:path";
import { ZodError } from "zod";
import {
  REFRESH_CANDIDATE_TOP_K,
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
  REFRESH_STATE_VERSION,
  REVERSE_TOP_K,
  buildRefreshState,
  changedSince,
  describeScope,
  incrementalScope,
  scopeCostTally,
  parseRefreshState,
  type RefreshScope,
  type RefreshState,
  type ReverseMatches,
} from "../../corpus-lib/refresh-scope";
import { snapshotFor } from "../../corpus-lib/backfill-similarity";
import { operatorTenantSelector, type OperatorTenant } from "../../corpus-lib/tenant";
import { soleWriterGuard } from "../../corpus-lib/sole-writer";
import { DATABASE_URL_ENV_FLAG_HELP, openOperatorSql, type OpenOperatorSql } from "../../pg-lib/operator-db";
import {
  listItems,
  neighboursOf,
  readRefreshState,
  setSimilarity,
  withOperatorCorpus,
  writeRefreshState,
} from "../../pg-lib/operator-corpus";
import type { SimilaritySnapshot } from "../../../src/schemas/manifest";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";
import {
  createRefreshTimer,
  printTiming,
  timedNeighboursStore,
  type RefreshTimer,
} from "../refresh-timing";

/**
 * The tenant's corpus, as this pass reads and writes it.
 *
 * Named as a seam rather than reached for directly so the command's own tests
 * drive every branch without a database, exactly as they drove it without an
 * R2 bucket. Everything behind it is one direct PostgreSQL session.
 */
export interface CorpusRefreshNeighboursStore {
  /** Every reading in the corpus, the rows the planner ranks over. */
  listItems: () => Promise<RefreshRow[]>;
  /** The stored run marker, unparsed; `null` only when confirmed absent. */
  readRefreshState: () => Promise<unknown | null>;
  writeRefreshState: (state: RefreshState, now: string) => Promise<void>;
  /**
   * One reading's full manifest, for the neighbourhood diff. The list row
   * carries no connections, tensions or judged-candidate ids — those live on
   * the revision — so the diff needs the whole reading.
   */
  readManifest: (id: string) => Promise<Record<string, unknown> | null>;
  /**
   * The reading's neighbours by its own stored vector, self included. `null`
   * when it owns no vector, which is not the same as owning no neighbours.
   */
  queryByVectorId: (id: string, topK: number) => Promise<RefreshNeighbour[] | null>;
  /** Writes the measured snapshot, and nothing else about the reading. */
  setSimilarity: (id: string, similarity: SimilaritySnapshot) => Promise<boolean>;
}

/** Which corpus a pass opens: the bucket names the database, the tenant the rows. */
export interface StoreTarget {
  bucket: string;
  local: boolean;
  databaseUrlEnv?: string;
  tenant: OperatorTenant;
}

export interface CorpusRefreshNeighboursDeps extends BaseDeps {
  /**
   * Opens the corpus for one pass and closes it afterwards, on every exit path.
   * One function rather than a store handed in already open, so nothing can
   * return without closing the session — invisible in a one-shot CLI run, fatal
   * in a test suite.
   */
  withStore: <T>(
    target: StoreTarget,
    work: (store: CorpusRefreshNeighboursStore) => Promise<T>,
  ) => Promise<T>;
  now: () => number;
  mkdir: (dir: string) => Promise<void>;
  writeFile: (filePath: string, body: string) => Promise<void>;
}

interface Opts {
  tenant?: string;
  databaseUrlEnv?: string;
  only: string[];
  bucket: string;
  local: boolean;
  execute: boolean;
  soleWriter: boolean;
  /**
   * True only under an explicit --full. The default is the marker-scoped pass:
   * the staging proof recorded in docs/operations.md ("Scope", 2026-09-02)
   * measured identical flags between the two and 12–14x less wall clock.
   */
  full: boolean;
  limit?: number;
  out: string;
}

function parseRefreshArgs(argv: string[]): Opts {
  const opts: Opts = {
    only: [],
    bucket: process.env.READING_LITE_BUCKET ?? "reading-lite",
    local: false,
    execute: false,
    soleWriter: false,
    full: false,
    out: "refresh-report.json",
  };
  let sinceLastRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--execute") opts.execute = true;
    else if (a === "--sole-writer") opts.soleWriter = true;
    else if (a === "--full") opts.full = true;
    else if (a === "--since-last-run") sinceLastRun = true;
    else if (a === "--local") opts.local = true;
    else if (a === "--bucket") opts.bucket = requireValue(argv[++i], a);
    else if (a === "--tenant") opts.tenant = requireValue(argv[++i], a);
    else if (a === "--database-url-env") opts.databaseUrlEnv = requireValue(argv[++i], a);
    else if (a === "--out") opts.out = requireValue(argv[++i], a);
    else if (a === "--limit") opts.limit = parsePositiveInt(requireValue(argv[++i], a));
    else if (a.startsWith("--")) throw new UsageError(`unknown flag: ${a}`);
    else opts.only.push(a);
  }
  // The two scope flags say opposite things; picking one silently would let a
  // nightly cron think it ran incrementally while it swept.
  // --since-last-run is the default, so the flag only ever says out loud what
  // the absence of --full already means, and it is parsed for that conflict
  // check alone. It stays accepted because every recorded invocation and
  // runbook example spells it, and because a schedule that names its scope
  // does not change meaning under a later default.
  if (sinceLastRun && opts.full) {
    throw new UsageError("--since-last-run cannot be combined with --full");
  }
  // Behaviour-identical while incremental is the default, and written anyway so
  // the flag SELECTS its scope rather than merely agreeing with the current
  // default. A schedule that spells it must not start sweeping if the default
  // is ever flipped back.
  if (sinceLastRun) opts.full = false;
  return opts;
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

function mergeReading(item: RefreshRow, manifest: Record<string, unknown>): RefreshRow {
  return { ...item, ...(manifest as unknown as RefreshRow), key_prefix: item.key_prefix, id: item.id, url: item.url };
}

/**
 * Consecutive failed reverse queries after which the pass stops scoping and
 * sweeps. Small: a run of failures is a connection or a dropped session, not
 * luck.
 */
const REVERSE_QUERY_FAILURE_BUDGET = 3;

/**
 * The exit-code contract this command answers on, documented in
 * docs/operations.md. It splits the one thing an operator has to decide from
 * the exit status alone: whether the next action is theirs (re-run the pass, or
 * fix the connection behind it) or a reading's.
 *
 * 0 — nothing outstanding.
 * 1 — real work left undone: a whole-sweep configuration failure, or a failed
 *     query or snapshot write. The operator re-runs or repairs infrastructure,
 *     and the marker did not move past whatever was missed.
 * 3 — the pass itself completed, but specific readings need a human: no stored
 *     vector, or a reading whose rows do not parse. Re-running changes nothing
 *     until they are repaired. Where the pass was eligible to advance the
 *     marker it did, carrying their ids for retry.
 *
 * 2 stays the CLI's usage code (scripts/ops-lib/cli.ts) and is not used here.
 */
const EXIT_OK = 0;
const EXIT_INCOMPLETE = 1;
const EXIT_NEEDS_ATTENTION = 3;

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
 * is the safe direction — the alternative, aborting, turns a transient failure
 * into a night with no refresh at all.
 */
async function readMarker(
  store: CorpusRefreshNeighboursStore,
  stderr: (line: string) => void,
): Promise<RefreshState | null> {
  let raw: unknown;
  try {
    raw = await store.readRefreshState();
  } catch (e) {
    stderr(`  ! run marker unreadable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (raw === null) return null;
  const state = parseRefreshState(raw);
  // An older marker and a damaged one are the same null and very different
  // instructions to the operator: one needs looking at, the other is answered
  // by this pass rewriting it.
  if (state === null) stderr(markerRejectionReason(raw));
  return state;
}

function markerRejectionReason(raw: unknown): string {
  const version =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { version?: unknown }).version
      : undefined;
  return typeof version === "number" && version < REFRESH_STATE_VERSION
    ? `  ! run marker is version ${version}, which predates the current format ` +
      `(version ${REFRESH_STATE_VERSION}) — this pass sweeps, and the next ` +
      "complete --execute pass replaces it"
    : "  ! run marker is not a usable refresh state";
}

/**
 * The incremental scope: which readings this pass has to measure. The reverse
 * queries are made here and handed to the pure planner as data, so every scope
 * rule stays unit-testable without a database.
 *
 * A reverse query that fails leaves its id out of the map, which the planner
 * reads as "the scope cannot be trusted" and escalates. Nothing about a failed
 * scoping query is allowed to shrink the pass.
 */
async function resolveScope(args: {
  store: CorpusRefreshNeighboursStore;
  io: CommandIo;
  items: RefreshRow[];
  marker: RefreshState | null;
}): Promise<RefreshScope> {
  const { store, io, items, marker } = args;
  const base = changedSince(items, marker);
  if (base.kind === "full") return base;

  const reverse = new Map<string, ReverseMatches>();
  const statusById = new Map(items.map((row) => [row.id, row.status]));
  // Checked before every query, the first included: a bulk ingest that already
  // outweighs the sweep escalates without making any, and one that grows past
  // it partway through stops making them there.
  const cost = scopeCostTally(items, base.changed, marker);
  let consecutiveFailures = 0;
  let attempted = 0;
  for (const id of base.changed) {
    const cheaper = cost.check(attempted);
    if (cheaper !== null) return cheaper;
    attempted++;
    // Every changed reading is queried, whatever its status says. Status is not
    // a statement about vector ownership — a reprocess-in-flight `pending` row
    // and a `failed` row over a previously-ready reading can both still have a
    // stored vector, and that vector's neighbours are exactly who needs
    // re-measuring. `queryByVectorId` answers null for a genuinely absent
    // vector, which is the honest version of the same shortcut.
    try {
      const matches = await store.queryByVectorId(id, REVERSE_TOP_K);
      // An empty reverse set is meaningless — a vector that exists matches
      // itself — so it is the same null as a vector that is not there.
      const parsed =
        matches === null || matches.length === 0
          ? null
          : matches.map((match) => ({ id: match.id, score: match.score }));
      // Only worth a line when it changes the outcome. A pending or failed
      // reading owning no vector is an ordinary night — saying so once per
      // ingested reading would make stderr useless as an alerting signal.
      if (parsed === null && statusById.get(id) === "ready") {
        io.stderr(`  ! no reverse neighbourhood for ready reading ${id}`);
      }
      reverse.set(id, parsed);
      cost.add(parsed);
    } catch (e) {
      // One failure does not end the loop, because the reason is meant to carry
      // how many changed readings saturated, and abandoning it would report
      // every remaining id as unanswered and no saturations at all.
      //
      // A run of them does. A session the server tore down mid-pass fails every
      // query after it, and without a stop that costs one failing query per
      // changed reading before the sweep, which then pays another per ready
      // reading: more than the full pass this flag exists to avoid.
      io.stderr(
        `  ! reverse-neighbour query failed for ${id}: ${e instanceof Error ? e.message : String(e)}`,
      );
      consecutiveFailures++;
      if (consecutiveFailures >= REVERSE_QUERY_FAILURE_BUDGET) {
        // Answered here rather than by the planner: it counts an id with no
        // entry as an unanswered query, and the ids after this point were never
        // asked. Reporting them as failures would inflate the very rate the
        // reason exists to make trustworthy.
        return {
          kind: "full",
          reason:
            `${consecutiveFailures} reverse-neighbour queries failed in a row ` +
            `after ${attempted} of ${base.changed.length} changed reading(s)`,
        };
      }
      continue;
    }
    consecutiveFailures = 0;
  }
  return incrementalScope(items, marker, reverse);
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

/**
 * The default store: one direct PostgreSQL session for the whole pass, closed
 * on every exit path.
 *
 * `requireTenantRows` refuses `--tenant global` here, as it does for every
 * command that reads rows: the pre-tenant layout has no rows, and resolving it
 * to zero of them would report an empty corpus rather than a wrong question.
 */
export function openStore(
  open: OpenOperatorSql,
  env: Record<string, string | undefined>,
): CorpusRefreshNeighboursDeps["withStore"] {
  return (target, work) =>
    withOperatorCorpus(target, env, open, ({ sql, tenant, tenantId, store: rows }) =>
      work({
        listItems: () => listItems(rows) as Promise<RefreshRow[]>,
        readRefreshState: () => readRefreshState(sql, tenantId),
        writeRefreshState: (state, now) => writeRefreshState(sql, tenantId, state, now),
        readManifest: async (id) => {
          const found = await rows.loadReadingById(id);
          return found ? (found.manifest as unknown as Record<string, unknown>) : null;
        },
        queryByVectorId: (id, topK) => neighboursOf(sql, tenant, id, topK),
        setSimilarity: (id, similarity) => setSimilarity(sql, tenantId, id, similarity),
      }),
    );
}

async function refreshNeighbours(
  opts: Opts,
  deps: CorpusRefreshNeighboursDeps,
  timer: RefreshTimer,
): Promise<number> {
  const { io } = deps;
  const tenant = requireOperatorTenant(opts.tenant);
  // These are paid-adjacent passes over the whole corpus, and --sole-writer is
  // the corpus-wide assertion the runbook and the batch commands share. The
  // storage reasons it used to carry — an unguarded index/list.json
  // read-merge-write, and a manifest ETag CAS — are gone with the documents
  // that had them; the row lock replaces both. What remains is the reason it
  // was always asked for: a pass that measures the corpus while other writers
  // change it reports a corpus that never existed.
  const soleWriter = soleWriterGuard({
    execute: opts.execute,
    acknowledged: opts.soleWriter,
    tool: "ops corpus refresh-neighbours",
  });
  if (soleWriter.message) io.stderr(soleWriter.message);
  if (!soleWriter.proceed) throw new UsageError("--execute requires --sole-writer");
  const tenantSelector = operatorTenantSelector(tenant);

  const target: StoreTarget = {
    bucket: opts.bucket,
    local: opts.local,
    ...(opts.databaseUrlEnv === undefined ? {} : { databaseUrlEnv: opts.databaseUrlEnv }),
    tenant,
  };
  return deps.withStore(target, async (raw) => {
    const store = timedNeighboursStore(raw, timer);
    // Before the list read, not after: the marker this pass may store has to be
    // no newer than the data it describes. A reading activated between the two
    // would otherwise carry an `updated_at` older than the marker and never
    // enter the next incremental scope.
    const now = new Date(deps.now()).toISOString();
    // Read on both paths. A full pass does not scope against it, but it does
    // overwrite it, and a marker built from `previous: null` can only ever
    // re-derive the fields this pass happens to compute — the next forward-only
    // field added here would be dropped by every sweep.
    const marker = await readMarker(store, io.stderr);
    const sweepWarning = fullSweepWarning(marker, now);
    if (!opts.full && sweepWarning !== null) {
      // Scheduled jobs often capture only stderr, so the command to run has to
      // live on this warning, before the prose so copying it cannot pick up
      // diagnostic text or punctuation as shell arguments.
      io.stderr(
        `  ! Full sweep overdue: ${sweepWarning}. ` +
        `Run npm run ops -- corpus refresh-neighbours --tenant "${tenantSelector}" ` +
        "--full --execute --sole-writer --out ./refresh-report-full.json " +
        `--bucket ${shellArg(opts.bucket)}` +
        (opts.local ? " --local" : ""),
      );
    }
    const items = await store.listItems();
    // Named ids override the scope (planRefresh), so resolving one would spend a
    // reverse query per changed reading on an answer that cannot change which
    // readings are measured. `full` here means the same thing it means under
    // --limit: not narrowed by the marker.
    const scope: RefreshScope =
      opts.full || opts.only.length > 0
        ? { kind: "full", reason: opts.full ? "--full" : `--only names ${opts.only.length} reading(s)` }
        : await resolveScope({ store, io, items, marker });
    const plan = planRefresh(items, {
      only: opts.only,
      limit: opts.limit,
      ...(scope.kind === "incremental" ? { scope: new Set(scope.ids) } : {}),
    });
    const reportPath = path.resolve(opts.out);

    io.stdout(`Bucket: ${opts.bucket}${opts.local ? " (local)" : ""}`);
    io.stdout(`Tenant: ${tenantSelector}`);
    io.stdout(describeScope(scope));
    io.stdout(`Corpus: ${items.length} readings`);
    // In-scope rows only — a subset whenever the marker scope or --only narrowed
    // this pass (not --limit, which planRefresh applies after counting these);
    // `Corpus` above is the whole list.
    io.stdout(`Not ready (skipped, own no vector): ${plan.skippedNotReady}`);
    io.stdout(`To measure: ${plan.targets.length}`);
    io.stdout(`Mode: ${opts.execute ? "EXECUTE" : "PLAN"}`);
    io.stdout(`Report: ${reportPath}\n`);

    const flagged: RefreshReportReading[] = [];
    let measured = 0;
    let written = 0;
    let drifted = 0;
    let noVector = 0;
    let errored = 0;
    let invalid = 0;
    // Readings the pass looked at and could not measure at all. Recorded on the
    // marker so every later pass retries them: nothing about their own row moves
    // when the vector is restored or the rows repaired, so an incremental
    // scope built from timestamps would never look at them again.
    const unmeasurableIds: string[] = [];

    // The measurement loop threw, so the targets after the throw were never
    // attempted. Only relevant to the diagnosis: a pass that stopped early did
    // not sweep, whatever its scope said it would do.
    let aborted = false;
    try {
      for (const t of plan.targets) {
        let matches: RefreshNeighbour[] | null;
        try {
          matches = await store.queryByVectorId(t.id, REFRESH_CANDIDATE_TOP_K);
        } catch (e) {
          errored++;
          io.stderr(`  ! similarity query failed for ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        if (matches === null) {
          noVector++;
          unmeasurableIds.push(t.id);
          io.stderr(`  ! no vector stored for ${t.id}  ${t.url}`);
          continue;
        }
        const snap = snapshotFor(t.id, matches, now);

        // Connections and tensions live on the revision, not the list row, so
        // the diff needs the whole reading. A reading whose rows do not parse
        // is a failed measurement rather than an empty one: diffing a list row
        // alone would invent an empty cited set and drop stale_connection.
        let manifest: Record<string, unknown> | null = null;
        try {
          manifest = await store.readManifest(t.id);
        } catch (e) {
          // Only validation errors identify rows that need repair. Database
          // failures leave work unfinished and must keep the marker in place.
          if (e instanceof ZodError) {
            invalid++;
            unmeasurableIds.push(t.id);
            io.stderr(`  ! reading does not parse for ${t.id}: ${e.message}`);
          } else {
            errored++;
            io.stderr(`  ! reading read failed for ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
          continue;
        }
        if (manifest === null) {
          // Purged between the list read and now. Nothing to measure and
          // nothing to repair, so it is neither error nor unmeasurable.
          io.stderr(`  ! ${t.id} was removed while this pass ran`);
          continue;
        }

        measured++;
        const reading = mergeReading(t, manifest);
        const judged = resolveJudgedAt(reading);
        const reasons = diffNeighbourhood(reading, matches, items, judged.judged_at);
        const snapshotDrifted = snapshotChanged(reading.similarity, snap);
        if (snapshotDrifted) drifted++;

        const score = snap.max === undefined ? "none" : snap.max.toFixed(3);
        const reasonText = reasons.length === 0 ? "fresh" : reasons.join(",");
        const driftLabel = snapshotDrifted ? "snapshot-drift" : "snapshot-ok";
        io.stdout(
          `  ${t.id}  neighbours=${snap.count} nearest=${score}  ${driftLabel}  ${reasonText}  ${t.url}`,
        );

        if (reasons.length > 0) {
          flagged.push(buildReportReading(reading, matches, items, reasons, judged));
        }

        if (!opts.execute || !snapshotDrifted) continue;
        try {
          // One column, one statement: the list row and the manifest were two
          // documents to keep in lockstep and are one row now, so there is no
          // second write to resume from and nothing to heal.
          if (await store.setSimilarity(t.id, snap)) written++;
          else io.stderr(`  ! ${t.id} was removed before its snapshot could be written`);
        } catch (e) {
          errored++;
          io.stderr(`  ! snapshot write failed for ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      errored++;
      aborted = true;
      io.stderr(`  ! refresh pass aborted: ${e instanceof Error ? e.message : String(e)}`);
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

    io.stdout(`\nMeasured: ${measured}${opts.execute ? `, snapshots written: ${written}` : ""}`);
    io.stdout(`Snapshot drift: ${drifted}`);
    io.stdout(`Flagged for judgement: ${flagged.length}`);
    io.stdout(`Wrote ${reportPath} (${flagged.length} reading(s)).`);
    if (noVector > 0) {
      io.stdout(
        `No vector stored: ${noVector} — these are ready readings whose embedding was ` +
        `never written or has been removed. They cannot be scored without re-embedding.`,
      );
    }
    if (errored > 0) {
      io.stdout(`Failed measurements: ${errored} — these readings were not ${opts.execute ? "refreshed" : "measured"}.`);
    }
    if (invalid > 0) {
      io.stdout(
        `Readings that do not parse: ${invalid} — skipped rather than rewritten, ` +
        `so they stay visible to a later repair.`,
      );
    }

    // Readings the pass finished with and cannot measure until someone repairs
    // them, as against `errored`, which is work this pass still owes the corpus.
    const unmeasurable = noVector + invalid;
    // A pass the operator narrowed by hand covers neither the corpus nor its
    // scope — the same condition under which `advanceMarker` stands down — so
    // "nothing was measured" there says nothing about the configuration. Naming
    // one broken reading with --only is not a misconfigured connection.
    const handNarrowed = opts.only.length > 0 || plan.truncated;
    // A sweep whose every ready reading came back unmeasurable is not a corpus
    // full of broken readings; it is a pass that could not read the corpus at
    // all. A connection string for the wrong environment, a tenant with no rows
    // and a database failing every query all look exactly like this, and
    // advancing the marker on one would silently declare the whole corpus
    // refreshed on the strength of zero measurements.
    //
    // Only a sweep, because only a sweep's scope is large enough to say so. An
    // incremental scope is routinely one or two readings — often exactly the
    // unmeasurable ones the last pass carried forward for retry — and calling
    // that a configuration failure would freeze the marker on a single broken
    // reading, grow the scope every night, and page for it forever. It also
    // needs no bootstrap: a sweep's scope comes from the rows, not the marker,
    // so it reaches the same verdict whether or not a marker was ever written.
    // A misconfiguration does not escape by hiding in incremental passes: a
    // changed ready reading whose vector cannot be found escalates the scope to
    // a sweep, which is this rule's input.
    // An aborted pass is excluded for the same reason a narrowed one is: the
    // targets after the throw were never attempted, so "measured none of them" is
    // not the corpus answering. It exits 1 through `errored` regardless.
    const configurationFailure =
      !handNarrowed &&
      !aborted &&
      scope.kind === "full" &&
      plan.targets.length > 0 &&
      measured === 0;

    // What stops the marker is an unfinished pass, not an unmeasurable reading.
    // A failed query or a failed write leaves work this pass owed the corpus
    // undone, so the next one must sweep to find it. A reading with no vector
    // or rows that do not parse is different: the pass did everything it could
    // for it, the answer will not change until someone repairs it, and pinning
    // the marker on it would hold the whole scope at an ever-older timestamp.
    // Those are carried on the marker instead, and the run exits 3 so they stay
    // visible. Unless there were only those: a whole scope nothing could be
    // measured in is a failure of the pass, not of its readings, and it stops
    // the marker like any other unfinished one.
    let markerAdvanced = false;
    if (errored === 0 && !configurationFailure) {
      markerAdvanced = await advanceMarker({
        opts,
        store,
        io,
        marker,
        scope,
        items,
        unmeasurableIds,
        truncated: plan.truncated,
        runAt: now,
      });
    }

    // An unfinished pass owes the corpus another one; an unmeasurable reading
    // owes a repair. Only the first is the operator's to re-run — and a pass that
    // measured nothing at all owes one too, whatever its readings answered.
    const incomplete = errored > 0 || configurationFailure;
    if (errored + unmeasurable > 0) {
      io.stderr(
        `\n${errored + unmeasurable} of ${plan.targets.length} attempted reading(s) were not ` +
          `${opts.execute ? "refreshed" : "measured"} — ` +
          (incomplete
            ? "run incomplete."
            : "the pass finished; these readings need repair before they can be measured."),
      );
    }

    // Printed on every plan path, not only the clean one: it is the line that
    // tells an operator nothing was written, and a plan pass that found broken
    // readings needs it more than a quiet one does.
    if (!opts.execute) {
      io.stdout("\nPLAN — corpus unchanged. Re-run with --execute to refresh drifted snapshots.");
    }

    if (configurationFailure) {
      io.stderr(
        `\nConfiguration failure: this pass swept the corpus and measured 0 of ` +
          `${plan.targets.length} ready reading(s) (no vector: ${noVector}, failed: ${errored}, ` +
          `unparseable: ${invalid}). A whole sweep that answers this way is an ` +
          "infrastructure fault — a connection string for the wrong environment, a tenant " +
          "with no rows, or a database failing every call (the breakdown above says which " +
          "side) — far more often than it is a corpus of broken readings, so " +
          (opts.execute
            ? "the run marker did not advance and the next pass measures the same scope"
            : "an --execute pass would not have advanced the run marker") +
          ". Exit 1.",
      );
      return EXIT_INCOMPLETE;
    }
    if (incomplete) return EXIT_INCOMPLETE;
    if (unmeasurable > 0) {
      // Only claim the marker moved when it did: a plan pass, --only, a
      // truncating --limit, an invalidation arriving mid-pass and a failed marker
      // write all reach here having left it alone.
      io.stderr(
        `Exit 3: the pass completed${markerAdvanced ? " and its marker advanced" : ""}; ` +
          `${unmeasurable} reading(s) need human attention before they can be measured.`,
      );
      return EXIT_NEEDS_ATTENTION;
    }

    return EXIT_OK;
  });
}

const FULL_SWEEP_MAX_AGE_DAYS = 7;

/** Read-only cadence check, shared by plan and execute before resolving scope. */
function fullSweepWarning(marker: RefreshState | null, runAt: string): string | null {
  const lastFull = marker?.last_full_run_at;
  if (lastFull === undefined) {
    return `last_full_run_at missing or unusable (age unknown; threshold ${FULL_SWEEP_MAX_AGE_DAYS} days)`;
  }
  const ageDays = (Date.parse(runAt) - Date.parse(lastFull)) / (24 * 60 * 60 * 1000);
  if (ageDays <= FULL_SWEEP_MAX_AGE_DAYS) return null;
  return `last_full_run_at ${lastFull} (age ${ageDays.toFixed(1)} days; threshold ${FULL_SWEEP_MAX_AGE_DAYS} days)`;
}

/** Keep the suggested command copyable even for unusual operator arguments. */
function shellArg(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

/**
 * Stores the run marker the next incremental pass scopes against.
 *
 * Only a complete --execute pass may advance it, because the marker asserts
 * something stronger than "we looked": every reading in scope was measured — or
 * recorded as unmeasurable — AND whatever drifted was written. A plan pass
 * writes no snapshot, --only names a subset, and --limit leaves the marker
 * alone only when it actually cut the plan short — a limit used as a
 * runaway-cost valve and never reached has measured its whole scope. Passes
 * with an unfinished measurement never reach here.
 *
 * `last_full_run_at` moves only on a full sweep — it is what a weekly-sweep
 * policy is judged against.
 *
 * Returns whether the marker actually moved, so the caller's exit line can say
 * so without repeating the several reasons this function stands down.
 */
async function advanceMarker(args: {
  opts: Opts;
  store: CorpusRefreshNeighboursStore;
  io: CommandIo;
  marker: RefreshState | null;
  scope: RefreshScope;
  items: RefreshRow[];
  /** In-scope ids this pass could not measure, carried for retry. */
  unmeasurableIds: string[];
  /** True when --limit actually cut the plan short. */
  truncated: boolean;
  runAt: string;
}): Promise<boolean> {
  const { opts, io } = args;
  if (!opts.execute) return false;
  if (opts.only.length > 0 || args.truncated) {
    io.stdout("Run marker unchanged: this pass measured a subset of its scope.");
    return false;
  }
  // The marker this pass read is minutes old — a full pass over the production
  // corpus takes sixteen — and the row carries no lock between the read and
  // this write. A writer that stamped `invalidated_by` meanwhile is asking for
  // a sweep this pass did not do, and overwriting the stamp would silently lose
  // that request: the one failure the stamp exists to prevent. Re-read, and
  // stand down rather than advance.
  const invalidatedSince = await invalidationArrivedDuringPass(args);
  if (invalidatedSince === "unknown") {
    io.stderr(
      "  ! could not re-read the run marker before advancing it — leaving it alone, " +
      "so the next incremental run will sweep.",
    );
    return false;
  }
  if (invalidatedSince !== null) {
    io.stdout(
      `Run marker unchanged: invalidated by ${invalidatedSince} while this pass ran, ` +
      "so the next pass still owes the corpus a sweep.",
    );
    return false;
  }
  const state = buildRefreshState({
    previous: args.marker,
    runAt: args.runAt,
    full: args.scope.kind === "full",
    // Every id, not just the ready ones: status is not a statement about vector
    // ownership, so a non-ready row leaving the corpus can still take a stored
    // vector — and a neighbourhood — with it.
    listIds: args.items.map((row) => row.id),
    ...(args.unmeasurableIds.length === 0 ? {} : { unmeasurableIds: args.unmeasurableIds }),
  });
  try {
    await args.store.writeRefreshState(state, args.runAt);
    io.stdout(`Run marker updated (${state.last_run_at}).`);
    if (state.unmeasurable_ids !== undefined) {
      io.stdout(
        `Carried on the run marker for retry: ${state.unmeasurable_ids.length} unmeasurable reading(s).`,
      );
    }
    return true;
  } catch (e) {
    // Not a failed run: every snapshot this pass owed the corpus is written.
    // The cost of a lost marker is the next pass sweeping instead of scoping.
    io.stderr(
      `  ! run marker write failed: ${e instanceof Error ? e.message : String(e)} — ` +
      "the next incremental run will sweep.",
    );
    return false;
  }
}

/**
 * The invalidation stamped on the run marker while this pass ran, `null` when
 * there is none, or `"unknown"` when the re-read failed. An invalidation that
 * was already there when the pass started is not one: it is what made this pass
 * a sweep, and this pass answered it.
 */
async function invalidationArrivedDuringPass(args: {
  store: CorpusRefreshNeighboursStore;
  marker: RefreshState | null;
}): Promise<string | null | "unknown"> {
  let live: RefreshState | null;
  try {
    const raw = await args.store.readRefreshState();
    live = raw === null ? null : parseRefreshState(raw);
    // A marker that is there but does not parse — damaged, or a newer format —
    // may be carrying a stamp this pass cannot read, and overwriting it would
    // discard an owed sweep. Unless this pass ALREADY found it unusable, in
    // which case it is the same unusable marker, and refusing to replace it
    // would leave the corpus on an old-format marker forever.
    if (raw !== null && live === null && args.marker !== null) return "unknown";
  } catch {
    return "unknown";
  }
  const now = live?.invalidated_by;
  if (now === undefined) return null;
  return now === args.marker?.invalidated_by ? null : now;
}

export const corpusRefreshNeighboursCommand: CommandDefinition<CorpusRefreshNeighboursDeps> = {
  group: "corpus",
  name: "refresh-neighbours",
  summary: "Re-measure similarity snapshots and emit the staleness report (no LLM)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus refresh-neighbours [rd_ID...] [options]

Measures each ready reading in scope (no embedding calls; see Scope below for
which those are, and --full for all of them) against the stored vectors of the
tenant's other readings — the exact cosine scan the Worker serves similarity
from — and diffs the current floored ready-neighbourhood against stored
connections and novelty_verdict. The report distinguishes missing or non-ready
citations, ready citations below the floor, new uncited neighbours, and uncited
candidate-set drift against the latest judged neighbourhood (an older reading
entering, or a rejected candidate later leaving). Prints the staleness
inventory and always writes refresh-report.json — the input contract for later
judgement slices.

--execute --sole-writer rewrites only drifted similarity snapshots (count change
or |Δmax|/|Δmean| ≥ 0.02), one column of one row, touching nothing else — not
updated_at, status, vectors, title, tldr, tags, keywords, entities, or
summary_markdown, and it does not re-roll a summary. A second immediate
--execute writes nothing.

Plan by default. The report is written in both modes.

--sole-writer asserts that every other corpus writer is paused. The pass reads
the whole corpus and reports on it, and a corpus being changed underneath it is
reported as one that never existed.

Scope. --since-last-run is the default: it measures only the readings whose
floored neighbourhood could have moved since the run marker in
corpus_refresh_state — those created or reprocessed since it, and the reverse
neighbourhood of each changed vector (a topK-${REVERSE_TOP_K} query).
That scope escalates to a full sweep whenever that reasoning runs out — no
marker, a marker carrying an invalidation, a reading of any status the marker
saw that has since left the corpus, a failed reverse query, a changed ready
reading with no vector to scope from, or a reverse neighbourhood that came back
full at topK with no match below the bound. Purges are caught by name, not by
row count, so a day that ingests as many readings as it purges still escalates.
It also sweeps once narrowing costs more than sweeping: before each reverse
query, the reverse queries still to run plus the ready readings known to be in
scope are compared with the number of ready readings, and the pass sweeps as
soon as the first is larger (a tie stays incremental). A bulk ingest that
outweighs the corpus therefore sweeps without making any reverse query.
--full measures every ready reading, as this command always did by default. It
is now the explicit weekly sweep, and an incremental report is a statement about
its scope rather than about the corpus: a persistent flag on a reading nobody
touched stays invisible until that sweep.

The bound keeps FLAGS exact, not the stored numbers: a vector added anywhere
enters some stranger's raw topK, and the similarity max/mean the API and the
frontend serve summarise that raw topK, sub-floor scores included. So between sweeps
those numbers are approximate on readings nothing brought into scope —
deterministic, and cleared by the next --full. The scope and its reason are
printed and recorded in the report header, and an escalation names how many
changed readings caused it — a corpus that saturates every night is buying
nothing from the narrowed scope, and is better run as --full outright than
paying the reverse queries first.

Only a complete --execute pass advances the marker: never a plan pass, never
with --only, and not when --limit actually cut the pass short (a limit carried
as a cost valve and never reached has measured its whole scope, and does
advance it). Naming ids overrides the scope: those readings are measured either
way.

A reading with no stored vector, or whose rows no longer parse, is unmeasurable
rather than unfinished: the pass records its id on the marker, measures it again
on every later pass while it stays ready, and exits 3.
(One that stops being ready leaves the marker; it returns through its own
timestamps when it is ready again, or through the weekly sweep.)
A failed query or a failed snapshot write does hold the marker back, because the
next pass has to sweep to find what this one left undone.

Exit codes:
  0  Nothing outstanding.
  1  Real work left undone and the marker did not move past it: a failed query
     or write — or a configuration failure, meaning a sweep that measured none
     of its ready readings (a connection string for the wrong environment, or a
     --tenant with no rows, looks exactly like this). Re-run, or fix the
     infrastructure, then re-run.
  2  Usage error (the CLI's, not this command's).
  3  The pass itself completed, but some readings need a human: no stored
     vector, or rows that do not parse. Re-running changes nothing until they
     are repaired. Where the pass was eligible to advance the marker it did,
     carrying their ids for retry; the exit line says which.
The codes apply in plan mode too. Only a sweep can report a configuration
failure: an incremental scope is routinely one or two readings — often the
unmeasurable ones carried for retry — which is too small to tell a broken
connection from a broken reading. A pass narrowed by --only or by a --limit that
truncated it never reports one either: it measured the subset it was told to.

Options:
  --since-last-run    Measure only the readings in scope (see above).
                      The default.
  --full              Measure every ready reading. The weekly sweep.
  --limit <n>         Cap how many readings are measured this pass.
  --out <path>        Report path. Default: ./refresh-report.json
  --bucket <name>     R2 bucket, which names the database this pass reads.
                      Default: READING_LITE_BUCKET / reading-lite.
  --tenant <selector>  REQUIRED: the tenant id (usr_…) whose corpus to measure.
${DATABASE_URL_ENV_FLAG_HELP}
  --local             Use this checkout's own PostgreSQL.
  --execute           Write drifted snapshots. Requires --sole-writer.
  --sole-writer       Required with --execute: assert all corpus writers are paused.
  --help              Show this message.`,
  defaultDeps: (io: CommandIo): CorpusRefreshNeighboursDeps => ({
    io,
    withStore: openStore(openOperatorSql, process.env),
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
