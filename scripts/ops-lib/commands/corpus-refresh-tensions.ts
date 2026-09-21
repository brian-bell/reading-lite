// `ops corpus refresh-tensions` — tier 3 of the corpus refresh: judge
// directional tensions between pairs the tier-1 report brought together.
//
// Plan-first like refresh-connections: the plan reads the report, the corpus,
// and every reading a candidate pair or --pair names, prints each pair with
// its overlap evidence and estimated cost plus every free repair, and writes
// nothing. --execute --sole-writer makes one paid pairwise call per selected
// pair and writes the derived directional entry to BOTH readings.
//
// Both sides in ONE transaction (reading-lite-gh347.4.1). A judged tension is
// one fact about a pair, and two transactions could leave half of it: the
// corpus would then hold a tension one reading cites and the other has never
// heard of. It also fixes the deadlock two passes judging (a,b) and (b,a) at
// once would otherwise hit, because the writer locks both rows in sorted id
// order before reading either. The one-sided REPAIRS below stay: they exist
// for pairs left half-written before this, and for a partner that was deleted.
//
// --pair a,b hand-picks a pair: it bypasses the overlap pre-filter and the
// already-judged skip (operator intent), but both sides must still be live,
// ready, valid manifests. With --pair the report is optional.

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { ListIndexItem } from "../../../src/schemas/api";
import { ManifestSchema } from "../../../src/schemas/manifest";
import {
  buildAnthropicTensionRequestBody,
  buildOpenAITensionRequestBody,
  judgeTension,
  type TensionJudgementInput,
  type TensionJudgementResult,
} from "../../../src/modules/tension-judgement";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_SUMMARIZATION_MODEL,
  parseAnthropicEffort,
  parseReasoningEffort,
  parseSummarizerProvider,
  type SummarizerProvider,
} from "../../../src/modules/summarizer";
import {
  parseRefreshConnectionsReport,
  type RefreshConnectionsReport,
} from "../../corpus-lib/refresh-connections";
import {
  buildTensionJudgementInput,
  deriveTensionSides,
  findOneSided,
  formatOverlapEvidence,
  isPairJudged,
  mergeTensionSide,
  orderPair,
  overlapEvidence,
  pairKey,
  purgeTensionPartner,
  tensionCandidates,
  type RawManifest,
  type RepairAction,
  type TensionCandidate,
} from "../../corpus-lib/refresh-tensions";
import { describeReportScope } from "../../corpus-lib/refresh-neighbours";
import { operatorTenantSelector } from "../../corpus-lib/tenant";
import { soleWriterGuard } from "../../corpus-lib/sole-writer";
import { loadDotVars } from "../../lib/dotvars";
import { DATABASE_URL_ENV_FLAG_HELP, openOperatorSql } from "../../pg-lib/operator-db";
import {
  SUMMARIZER_PRICE_DATE,
  approximateTokens,
  estimateSummarizationCostUsd,
} from "../../summarizer-eval/pricing";
import {
  UsageError,
  type BaseDeps,
  type CommandDefinition,
  type CommandIo,
} from "../contract";
import { requireOperatorTenant } from "../tenant-flag";
import { createPrefetchingReader } from "../planning-reads";
import {
  BILLING_TENANT_FLAG_HELP,
  refuseUnguardedFetch,
  resolveBillingTenant,
  spendEnvironmentForBucket,
  withOperatorPaidFetch,
} from "../operator-spend";
import type { OpenOperatorSpend } from "../../system-lib/spend";
import {
  createRateLimitGate,
  judgeWithRateLimitRetry,
  parseConcurrencyFlag,
  parseMaxBackoffFlag,
  realSleep,
} from "../execute-pool";
import { runKeyedPool } from "../../lib/concurrency";
import {
  addUsage,
  emptyUsageTotals,
  formatUsage,
  formatUsageTotals,
} from "../judgement-usage";
import { judgeRetryDeps } from "../judge-retry";
import {
  PHASE_MANIFEST_READ,
  PHASE_PLANNING_READS,
  PHASE_PROVIDER,
  createRefreshTimer,
  formatSeconds,
  printTiming,
  timedRefreshStorage,
  type RefreshTimer,
} from "../refresh-timing";
import {
  openStore,
  parseProductionWorkerVars,
  type JudgeTransportOverrides,
  type RefreshConnectionsStorage,
  type StoreTarget,
  type StoredManifest,
} from "./corpus-refresh-connections";
import {
  manifestVersion,
  requireTenantRows,
  type PublishedReplacement,
} from "../../pg-lib/operator-corpus";

const ASSUMED_OUTPUT_TOKENS = 128;

interface Args {
  tenant?: string;
  billingTenant?: string;
  databaseUrlEnv?: string;
  local: boolean;
  /** null when --pair was given without an explicit --report. */
  report: string | null;
  reportExplicit: boolean;
  bucket: string;
  execute: boolean;
  soleWriter: boolean;
  limit?: number;
  concurrency: number;
  maxBackoffMs: number;
  pairs: Array<[string, string]>;
}

export type RefreshTensionsStorage = RefreshConnectionsStorage;

export interface TensionProviderPlan {
  provider: SummarizerProvider;
  model: string;
  effort: string;
  estimate(input: TensionJudgementInput): {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  judge(input: TensionJudgementInput): Promise<TensionJudgementResult>;
}

export interface CorpusRefreshTensionsDeps extends BaseDeps {
  /** Resolves to null when the report file does not exist. */
  readReport: (path: string) => Promise<string | null>;
  /** Opens the corpus for one pass and closes the session on every exit path. */
  withStore: <T>(
    target: StoreTarget,
    work: (storage: RefreshTensionsStorage) => Promise<T>,
  ) => Promise<T>;
  // `paidFetch` is the spend-admitted transport, present only under --execute.
  // Without it the provider's judge refuses rather than reach a provider unguarded.
  loadProvider: (execute: boolean, paidFetch?: typeof fetch) => Promise<TensionProviderPlan>;
  /** Execute-only: the session with the central spend authority. */
  openSpend: OpenOperatorSpend;
  /** The provider transport, reached only through the spend wrapper. */
  fetch: typeof fetch;
  now: () => number;
  /** Injected so the rate-limit backoff is instant under a fake clock. */
  sleep: (ms: number) => Promise<void>;
}

type Action =
  | {
      kind: "judge";
      candidate: TensionCandidate;
      input: TensionJudgementInput;
      estimate: ReturnType<TensionProviderPlan["estimate"]>;
    }
  | { kind: "repair"; repair: RepairAction };

/** What one execute action produced, held until its turn in plan order. */
interface ExecuteOutcome {
  stdout: string[];
  stderr: string[];
  /** Manifests this action actually wrote; a CAS loss contributes none. */
  written: number;
  judged?: boolean;
  repaired?: boolean;
  skippedSincePlan?: boolean;
  /** Undispatched because the pass had spent its whole backoff budget. */
  ceilingSkipped?: boolean;
  failed?: boolean;
  /** Present whenever the provider was called and billed. */
  usage?: TensionJudgementResult["usage"];
}

/** How an action names itself when something outside its own handling fails. */
function describeAction(action: Action): string {
  return action.kind === "judge" ? action.candidate.key : describeRepair(action.repair);
}

/**
 * The reading ids an execute action reads and writes, held for its duration.
 *
 * The pool dispatches the first pending action whose keys are all free, so two
 * actions that share a reading run one at a time but NOT necessarily in plan
 * order: a repair on C can be applied before an earlier judge of (B, C) that is
 * waiting on B. Nothing here depends on that order, for three reasons worth
 * naming because they live elsewhere: the planner drops a repair whose pair key
 * is already being judged (`judgedKeys` above), so the two never write the same
 * partner slot; `buildTensionJudgementInput` reads titles and summaries, not
 * the `tensions` array, so a repair landing first cannot change what a
 * judgement is asked about; and a repair's staleness guard compares an
 * `updated_at` against a plan-time timestamp that no write in this command
 * moves (`mergeTensionSide` and `purgeTensionPartner` preserve it verbatim). A
 * repair kind or a judgement input that broke any of those would need the pool
 * to enforce plan order.
 */
function actionKeys(action: Action): string[] {
  if (action.kind === "judge") return [action.candidate.a, action.candidate.b];
  const repair = action.repair;
  return [repair.kind === "drop" ? repair.on : repair.to];
}

function parseRefreshTensionsArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        tenant: { type: "string" },
        "billing-tenant": { type: "string" },
        "database-url-env": { type: "string" },
        local: { type: "boolean", default: false },
        report: { type: "string" },
        bucket: {
          type: "string",
          default: process.env.READING_LITE_BUCKET ?? "reading-lite",
        },
        execute: { type: "boolean", default: false },
        "sole-writer": { type: "boolean", default: false },
        limit: { type: "string" },
        concurrency: { type: "string" },
        "max-backoff": { type: "string" },
        pair: { type: "string", multiple: true },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new UsageError(`--limit ${JSON.stringify(values.limit)} is not a positive integer`);
    }
  }
  const pairs: Array<[string, string]> = [];
  for (const raw of values.pair ?? []) {
    const ids = raw.split(",").map((id) => id.trim());
    if (ids.length !== 2 || ids.some((id) => id.length === 0) || ids[0] === ids[1]) {
      throw new UsageError(`--pair ${JSON.stringify(raw)} must name two distinct reading ids as a,b`);
    }
    pairs.push([ids[0]!, ids[1]!]);
  }
  return {
    ...(values.tenant === undefined ? {} : { tenant: values.tenant }),
    // A hand-picked pair does not implicitly consume a leftover report in cwd.
    report: values.report ?? (pairs.length > 0 ? null : "refresh-report.json"),
    reportExplicit: values.report !== undefined,
    ...(values["billing-tenant"] === undefined ? {} : { billingTenant: values["billing-tenant"] }),
    ...(values["database-url-env"] === undefined
      ? {}
      : { databaseUrlEnv: values["database-url-env"] }),
    local: values.local === true,
    bucket: values.bucket!,
    execute: values.execute === true,
    soleWriter: values["sole-writer"] === true,
    ...(limit === undefined ? {} : { limit }),
    concurrency: parseConcurrencyFlag(values.concurrency),
    maxBackoffMs: parseMaxBackoffFlag(values["max-backoff"]),
    pairs,
  };
}

// The block prints in a finally: the passes worth timing most are the ones
// that end in a thrown stale-report or storage error, having already spent
// minutes of planning reads.
async function runCorpusRefreshTensions(
  argv: string[],
  deps: CorpusRefreshTensionsDeps,
): Promise<number> {
  const args = parseRefreshTensionsArgs(argv);
  const timer = createRefreshTimer(deps.now);
  try {
    const tenant = requireOperatorTenant(args.tenant);
    // As in refresh-connections, and before the spend session opens.
    requireTenantRows(tenant);
    const billingTenant = resolveBillingTenant(args.billingTenant, { tenant, execute: args.execute });
    // An --execute without --sole-writer is refused inside, before any provider
    // is loaded, so it needs no spend session either.
    if (!args.execute || !args.soleWriter) return await refreshTensions(args, deps, timer, undefined);
    return await withOperatorPaidFetch(
      deps,
      { env: spendEnvironmentForBucket(args.bucket), billingTenant, command: "corpus-refresh-tensions" },
      (paidFetch) => refreshTensions(args, deps, timer, paidFetch),
    );
  } finally {
    printTiming(timer, deps.io.stdout);
  }
}

async function refreshTensions(
  args: Args,
  deps: CorpusRefreshTensionsDeps,
  timer: RefreshTimer,
  paidFetch: typeof fetch | undefined,
): Promise<number> {
  // Planning and execute read the same manifests through the same call, so the
  // phase label is what separates the fixed planning cost from the re-reads
  // execute makes of the sides it has already written.
  let manifestReadPhase = PHASE_PLANNING_READS;
  if (args.execute && !args.soleWriter) {
    const verdict = soleWriterGuard({
      execute: true,
      acknowledged: false,
      tool: "ops corpus refresh-tensions",
    });
    if (verdict.message) deps.io.stderr(verdict.message);
    throw new UsageError("--execute requires --sole-writer");
  }

  const tenant = requireOperatorTenant(args.tenant);
  const selector = operatorTenantSelector(tenant);
  const rawReport = args.report === null ? null : await deps.readReport(args.report);
  if (rawReport === null && (args.reportExplicit || args.pairs.length === 0)) {
    throw new Error(
      `report ${args.report} not found; run corpus refresh-neighbours first or pass --pair`,
    );
  }
  const report: RefreshConnectionsReport | null =
    rawReport === null
      ? null
      : parseRefreshConnectionsReport(JSON.parse(rawReport) as unknown, selector);
  const provider = await deps.loadProvider(args.execute, paidFetch);
  return deps.withStore(
    {
      bucket: args.bucket,
      local: args.local,
      ...(args.databaseUrlEnv === undefined ? {} : { databaseUrlEnv: args.databaseUrlEnv }),
      tenant,
    },
    (raw) => judgeTensions(args, deps, timer, { report, provider, selector, storage: raw, setPhase: (phase) => { manifestReadPhase = phase; }, phase: () => manifestReadPhase }),
  );
}

interface TensionContext {
  report: RefreshConnectionsReport | null;
  provider: TensionProviderPlan;
  selector: string;
  storage: RefreshTensionsStorage;
  setPhase: (phase: string) => void;
  phase: () => string;
}

async function judgeTensions(
  args: Args,
  deps: CorpusRefreshTensionsDeps,
  timer: RefreshTimer,
  ctx: TensionContext,
): Promise<number> {
  const { report, provider, selector } = ctx;
  const storage = timedRefreshStorage(ctx.storage, timer, ctx.phase);
  const items = await storage.listItems();
  const byId = new Map(items.map((item) => [item.id, item]));

  // Every reading a report pair or --pair could name. Manifests are read once
  // for planning, ETag included, and execute writes against that ETag. A side
  // an earlier action in the same pass wrote is the one exception: every write
  // path drops its side from the cache first, because that ETag is spent, and
  // `readLive` then reads that side again.
  const reportIds = new Set<string>();
  for (const reading of report?.readings ?? []) {
    reportIds.add(reading.id);
    for (const neighbour of reading.current_neighbours) reportIds.add(neighbour.id);
  }
  const wanted = new Set(reportIds);
  for (const [a, b] of args.pairs) {
    wanted.add(a);
    wanted.add(b);
  }
  const manifestsById = new Map<string, RawManifest>();
  const liveById = new Map<string, StoredManifest>();
  const liveReadyIds = new Set<string>();
  let planningFailed = false;
  const pairIds = new Set(args.pairs.flat());
  const wantedIds = [...wanted].sort();
  const wantedRows = wantedIds
    .map((id) => byId.get(id))
    .filter((row): row is ListIndexItem => row !== undefined && row.status === "ready");
  // The reads are independent, so they overlap; the loop below still walks the
  // ids in sorted order, which is what fixes the order manifests enter
  // `manifestsById` and therefore the plan the candidates are built from.
  const manifests = createPrefetchingReader<StoredManifest | null>((id) =>
    storage.readManifest(id),
  );
  await manifests.prefetch(wantedRows.map((row) => row.id));
  for (const id of wantedIds) {
    const row = byId.get(id);
    if (!row || row.status !== "ready") {
      if (pairIds.has(id)) {
        planningFailed = true;
        deps.io.stderr(`  ! ${id}: no live ready list row`);
      }
      continue;
    }
    let stored: StoredManifest | null;
    try {
      stored = await manifests.read(row.id);
    } catch (error) {
      planningFailed = true;
      deps.io.stderr(`  ! ${id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!stored) {
      if (pairIds.has(id)) planningFailed = true;
      deps.io.stderr(`  ! ${id}: live manifest is missing`);
      continue;
    }
    if (!validLiveManifest(stored.manifest, row)) {
      planningFailed = true;
      deps.io.stderr(`  ! ${id}: live ready manifest is invalid or mismatched`);
      continue;
    }
    if (report && reportIds.has(id) && manifestChangedSinceReport(stored.manifest, report.generated_at)) {
      throw new Error(
        `report is stale: ${id} changed after ${report.generated_at}; regenerate it`,
      );
    }
    manifestsById.set(id, stored.manifest);
    liveById.set(id, stored);
    liveReadyIds.add(id);
  }

  const candidates = new Map<string, TensionCandidate>();
  let filteredOut = 0;
  if (report) {
    const all = tensionCandidates(report, manifestsById, liveReadyIds);
    for (const candidate of all) candidates.set(candidate.key, candidate);
    filteredOut = countReportPairs(report, liveReadyIds) - all.length;
  }
  for (const [x, y] of args.pairs) {
    const pair = orderPair(x, y);
    const a = manifestsById.get(pair.a);
    const b = manifestsById.get(pair.b);
    if (!a || !b) {
      planningFailed = true;
      deps.io.stderr(`  ! skip --pair ${x},${y}: both sides must be live ready manifests`);
      continue;
    }
    candidates.set(pair.key, {
      ...pair,
      evidence: overlapEvidence(a, b, candidates.get(pair.key)?.evidence.score),
      source: "pair",
    });
  }

  // Repairs come first: a fresh one-sided judgement is mirrored for free and
  // must not be paid for again, while a stale one (partner reprocessed) is
  // dropped only when the pair is not about to be re-judged anyway.
  const readyListIds = new Set(
    items.flatMap((item) => (item.status === "ready" ? [item.id] : [])),
  );
  const repairs = findOneSided(manifestsById, readyListIds);
  const mirrorKeys = new Set(
    repairs.flatMap((repair) => (repair.kind === "drop" ? [] : [pairKey(repair.from, repair.to)])),
  );
  const actions: Action[] = [];
  let skippedJudged = 0;
  let skippedRepairPending = 0;
  for (const candidate of [...candidates.values()].sort((x, y) => x.key.localeCompare(y.key))) {
    const a = manifestsById.get(candidate.a)!;
    const b = manifestsById.get(candidate.b)!;
    if (candidate.source === "report") {
      if (isPairJudged(a, b)) {
        skippedJudged++;
        continue;
      }
      if (mirrorKeys.has(candidate.key)) {
        skippedRepairPending++;
        continue;
      }
    }
    let input: TensionJudgementInput;
    try {
      input = buildTensionJudgementInput(a, b);
    } catch (error) {
      planningFailed = true;
      deps.io.stderr(
        `  ! skip ${candidate.key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    actions.push({ kind: "judge", candidate, input, estimate: provider.estimate(input) });
  }
  // --limit caps paid judgements only; repairs are free, and the dangling
  // purges among them are what stop tier 1 from re-flagging holders nightly.
  // A repair yields only to a judge that will actually run this time.
  const selected: Action[] =
    args.limit === undefined ? actions : actions.slice(0, args.limit);
  const judgedKeys = new Set(
    selected.flatMap((action) => (action.kind === "judge" ? [action.candidate.key] : [])),
  );
  for (const repair of repairs) {
    const key = repair.kind === "drop" ? pairKey(repair.on, repair.partner) : pairKey(repair.from, repair.to);
    if (judgedKeys.has(key)) continue;
    selected.push({ kind: "repair", repair });
  }
  deps.io.stdout(`Bucket: ${args.bucket}`);
  deps.io.stdout(`Tenant: ${selector}`);
  deps.io.stdout(
    report
      ? `Report: ${args.report} (${report.readings.length} flagged)`
      : `Report: none (--pair only)`,
  );
  // Only when a report was read: a --pair-only pass has no tier-1 scope to
  // report, and printing one would name a scope nothing here came from.
  if (report) deps.io.stdout(describeReportScope(report.scope));
  deps.io.stdout(`Provider: ${provider.provider} ${provider.model} effort=${provider.effort}`);
  deps.io.stdout(
    `Mode: ${args.execute ? `EXECUTE (concurrency ${args.concurrency})` : "PLAN"}`,
  );
  deps.io.stdout(
    `Selected actions: ${selected.length}; below overlap threshold: ${filteredOut}; ` +
      `already judged: ${skippedJudged}; repair pending: ${skippedRepairPending}\n`,
  );

  let estimatedTotal = 0;
  for (const action of selected) {
    if (action.kind === "repair") {
      deps.io.stdout(`  ${describeRepair(action.repair)}`);
      continue;
    }
    estimatedTotal += action.estimate.costUsd;
    deps.io.stdout(
      `  ${action.candidate.a}<->${action.candidate.b}  judge${action.candidate.source === "pair" ? " (--pair)" : ""} ` +
        `${formatOverlapEvidence(action.candidate.evidence)} ` +
        `input≈${action.estimate.inputTokens} output=${action.estimate.outputTokens} ` +
        `cost≈$${action.estimate.costUsd.toFixed(6)}`,
    );
  }
  deps.io.stdout(
    `\nEstimated synchronous cost: $${estimatedTotal.toFixed(6)} ` +
      `(price table ${SUMMARIZER_PRICE_DATE}; output assumption ${ASSUMED_OUTPUT_TOKENS} tokens)`,
  );

  if (!args.execute) {
    deps.io.stdout("PLAN - no provider call or storage write was made.");
    return planningFailed ? 1 : 0;
  }
  ctx.setPhase(PHASE_MANIFEST_READ);
  const soleWriter = soleWriterGuard({
    execute: true,
    acknowledged: true,
    tool: "ops corpus refresh-tensions",
  });
  if (soleWriter.message) deps.io.stderr(soleWriter.message);

  let judged = 0;
  let written = 0;
  let repaired = 0;
  let failures = 0;
  let skippedSincePlan = 0;
  let ceilingSkipped = 0;
  const usageTotals = emptyUsageTotals();
  const gate = createRateLimitGate({
    now: deps.now,
    sleep: deps.sleep,
    maxBackoffMs: args.maxBackoffMs,
    onPause: (ms) =>
      deps.io.stderr(
        `  ! provider rate limited; pausing new judgements for ${formatSeconds(ms)}`,
      ),
    onCeiling: (totalMs) =>
      deps.io.stderr(
        `  ! the next backoff would pass this pass's ${formatSeconds(args.maxBackoffMs)} ` +
          `rate-limit ceiling (${formatSeconds(totalMs)} of it already spent); ` +
          `not dispatching any more judgements`,
      ),
  });
  // The reading to write against: the one planning read and validated, until
  // a write in this pass supersedes its version. Nothing outside the pass can
  // invalidate it silently — a reading that changed since planning loses the
  // guarded write below, which is what reports it.
  const readLive = async (id: string): Promise<StoredManifest> => {
    const planned = liveById.get(id);
    if (planned) return planned;
    const row = byId.get(id);
    if (!row) throw new Error("no list row");
    const current = await storage.readManifest(row.id);
    if (!current || !validLiveManifest(current.manifest, row)) {
      throw new Error("manifest changed before write");
    }
    return current;
  };
  // One action, start to finish, with nothing recorded outside it: the caller
  // folds the counters and prints the lines in plan order once every earlier
  // action has been folded, so overlapping the calls cannot reorder the run's
  // output or its accounting.
  const runAction = async (action: Action): Promise<ExecuteOutcome> => {
    const outcome: ExecuteOutcome = { stdout: [], stderr: [], written: 0 };
    const fail = (label: string, error: unknown): ExecuteOutcome => {
      outcome.failed = true;
      outcome.stderr.push(
        `  ! ${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return outcome;
    };
    /** One reading's half of a write, guarded on the version planning read. */
    const replacement = (
      id: string,
      manifest: Record<string, unknown>,
      current: StoredManifest,
    ): PublishedReplacement => {
      const next = ManifestSchema.safeParse(manifest);
      // The merge is onto a manifest that already parsed, so this can only
      // fail on what the judgement contributed. Refused rather than written:
      // a reading the Worker would reject at read time must not be stored.
      if (!next.success) throw new Error(`judged manifest is invalid: ${next.error.message}`);
      return {
        id,
        matches: async (live) => (await manifestVersion(live)) === current.version,
        next: next.data,
      };
    };
    const merge = (
      partnerId: string,
      entry: Parameters<typeof mergeTensionSide>[2],
      judgedAt: string | undefined,
      current: StoredManifest,
    ): Record<string, unknown> => {
      const merged = mergeTensionSide(current.manifest, partnerId, entry, judgedAt);
      if (!merged.ok) throw new Error(merged.error);
      return merged.manifest;
    };
    /**
     * Writes one or both sides. A pair goes in a single call, so it is one
     * transaction: both entries are locked in sorted id order before either is
     * read, and a failure leaves neither side written rather than half a
     * judgement the two readings would disagree about.
     */
    const writeSet = async (entries: PublishedReplacement[]): Promise<void> => {
      // The planned version is spent either way: a win supersedes it, a loss
      // proves it was already stale. Whoever reads these next reads them fresh.
      for (const entry of entries) liveById.delete(entry.id);
      const written = await storage.replaceRelationships(entries);
      if (!written.replaced) {
        throw new Error("the reading changed since it was planned; no overwrite performed");
      }
      for (const skipped of written.skippedTargets) {
        outcome.stderr.push(
          `  ! ${skipped.sourceId}: skipped ${skipped.kind} target ${skipped.targetId}: no longer exists`,
        );
      }
      outcome.written += entries.length;
    };
    const writeSide = async (
      id: string,
      partnerId: string,
      entry: Parameters<typeof mergeTensionSide>[2],
      judgedAt: string | undefined,
      current: StoredManifest,
    ): Promise<void> => {
      await writeSet([replacement(id, merge(partnerId, entry, judgedAt, current), current)]);
    };
    const ceilingSkip = (): ExecuteOutcome => {
      outcome.ceilingSkipped = true;
      outcome.stderr.push(
        `  ! skip ${describeAction(action)}: backoff ceiling reached before this action ran`,
      );
      return outcome;
    };

    if (action.kind === "judge") {
      // The ceiling stops the paid work only: the repairs are a separate action
      // kind and run, for the same reason `--limit` caps judgements and never
      // them. It sits ahead of the live re-reads rather than after them so a
      // stopped pass stops paying for R2 too — the free outcome that costs is
      // the judged-since-plan skip below, which under `--sole-writer` means a
      // pair nothing could have judged since the plan was made.
      if (gate.stopped()) return ceilingSkip();
      const { a: aId, b: bId, source, key } = action.candidate;
      let a: StoredManifest;
      let b: StoredManifest;
      try {
        a = await readLive(aId);
        b = await readLive(bId);
      } catch (error) {
        return fail(key, error);
      }
      // Only a side read fresh — one an earlier action in this pass wrote —
      // can say anything the plan did not already know here, so under a real
      // sole writer this stays at zero. It is the report that a manifest was
      // judged out from under the plan, which is worth keeping cheap.
      if (source === "report" && isPairJudged(a.manifest, b.manifest)) {
        outcome.skippedSincePlan = true;
        outcome.stderr.push(`  ! skip ${key}: judged since the plan was made`);
        return outcome;
      }
      try {
        const input = buildTensionJudgementInput(a.manifest, b.manifest);
        // The one place a rate limit is observed for the whole pass: wait for
        // any window another worker opened before adding to it. The wait sits
        // here rather than earlier because it is the paid call it is pacing.
        await gate.wait();
        // Woken by the ceiling rather than by the window expiring: this action
        // never called the provider, so it is skipped, not failed.
        if (gate.stopped()) return ceilingSkip();
        const { value: result, ms: providerMs } = await judgeWithRateLimitRetry(
          gate,
          () => timer.measured(PHASE_PROVIDER, () => provider.judge(input)),
        );
        outcome.judged = true;
        // Carried on the outcome whatever happens next, so the run total covers
        // every call billed, including judgements whose writes later fail.
        outcome.usage = result.usage;
        outcome.stdout.push(`  ${key}  ${formatUsage(result.usage)} ms=${providerMs}`);
        const computedAt = new Date(deps.now()).toISOString();
        const sides = deriveTensionSides(result.judgement, { a: aId, b: bId }, computedAt);
        // One call, one transaction: the judgement is one fact about the pair,
        // and there is no state in which only half of it was written.
        await writeSet([
          replacement(aId, merge(bId, sides.a, computedAt, a), a),
          replacement(bId, merge(aId, sides.b, computedAt, b), b),
        ]);
        outcome.stdout.push(
          `  ${key}  ${result.judgement.verdict}${result.judgement.side ? ` side=${result.judgement.side}` : ""}`,
        );
        return outcome;
      } catch (error) {
        return fail(key, error);
      }
    }

    // The two staleness guards below compare an `updated_at` against the same
    // plan-time timestamp `findOneSided` planned from, and nothing this
    // command writes moves `updated_at`, so on the cached path they cannot
    // fire. What is left for them is the narrow case where a side re-read
    // after an in-pass write comes back bearing a newer `updated_at` than the
    // repair was planned against, which only a writer outside this pass can
    // produce. Everything else that writer could do is caught by the
    // conditional write instead.
    const repair = action.repair;
    try {
      if (repair.kind === "mirror") {
        const target = await readLive(repair.to);
        if (timestamp(target.manifest.updated_at) > timestamp(repair.entry.computed_at)) {
          throw new Error("partner changed since the judgement; rerun to re-plan");
        }
        await writeSide(repair.to, repair.from, repair.entry, repair.entry.computed_at, target);
      } else if (repair.kind === "mirror-judged") {
        const target = await readLive(repair.to);
        if (timestamp(target.manifest.updated_at) > timestamp(repair.judged_at)) {
          throw new Error("partner changed since the judgement; rerun to re-plan");
        }
        await writeSide(repair.to, repair.from, null, repair.judged_at, target);
      } else if (repair.dangling) {
        // The plan-time list snapshot is authoritative under --sole-writer;
        // a partner that later comes back ready is rebuilt without tensions
        // and must be re-judged anyway.
        const target = await readLive(repair.on);
        const merged = purgeTensionPartner(target.manifest, repair.partner);
        if (!merged.ok) throw new Error(merged.error);
        await writeSet([replacement(repair.on, merged.manifest, target)]);
      } else {
        const target = await readLive(repair.on);
        await writeSide(repair.on, repair.partner, null, repair.judged_at, target);
      }
      outcome.repaired = true;
      return outcome;
    } catch (error) {
      return fail(describeRepair(repair), error);
    }
  };

  await runKeyedPool(
    selected,
    args.concurrency,
    // The reading ids an action reads and writes. A reading sits in several
    // pairs, so without this two workers would hold the same manifest at the
    // same ETag, both pay for a judgement, and the second would lose the CAS:
    // failures and spend that a sequential pass never produces. Naming every
    // id an action reads is also what keeps the plan-time ETag cache honest:
    // a write evicts its side, and no one else may be holding it at the time.
    actionKeys,
    // `runAction` reports its own failures, but an unforeseen throw would abort
    // the pass with the results behind it unaccounted for, so the last word on
    // that belongs here rather than to the pool.
    async (action) => {
      try {
        return await runAction(action);
      } catch (error) {
        return {
          stdout: [],
          stderr: [
            `  ! ${describeAction(action)}: ${error instanceof Error ? error.message : String(error)}`,
          ],
          written: 0,
          failed: true,
        };
      }
    },
    (outcome) => {
      for (const line of outcome.stdout) deps.io.stdout(line);
      for (const line of outcome.stderr) deps.io.stderr(line);
      if (outcome.usage) addUsage(usageTotals, outcome.usage);
      if (outcome.judged) judged++;
      if (outcome.repaired) repaired++;
      if (outcome.skippedSincePlan) skippedSincePlan++;
      if (outcome.ceilingSkipped) ceilingSkipped++;
      if (outcome.failed) failures++;
      written += outcome.written;
    },
  );

  deps.io.stdout(
    `\nJudged: ${judged}; readings written: ${written}; repaired: ${repaired}; ` +
      `skipped since plan: ${skippedSincePlan}; failures: ${failures}` +
      (ceilingSkipped > 0 ? `; skipped at the backoff ceiling: ${ceilingSkipped}` : ""),
  );
  deps.io.stdout(formatUsageTotals(usageTotals));
  return planningFailed || failures > 0 || ceilingSkipped > 0 ? 1 : 0;
}

function describeRepair(repair: RepairAction): string {
  switch (repair.kind) {
    case "mirror":
      return `${repair.to}<-${repair.from}  repair mirror ${repair.entry.kind} (no provider call)`;
    case "mirror-judged":
      return `${repair.to}<-${repair.from}  repair mirror judged-at ${repair.judged_at} (no provider call)`;
    case "drop":
      if (repair.dangling) {
        return `${repair.on}  repair drop dangling tension -> ${repair.partner} (partner deleted or not ready)`;
      }
      return repair.judged_at === undefined
        ? `${repair.on}  repair drop stale tension -> ${repair.partner} (partner reprocessed since)`
        : `${repair.on}  repair drop tension -> ${repair.partner} (partner judged none at ${repair.judged_at})`;
  }
}

function countReportPairs(
  report: RefreshConnectionsReport,
  liveReadyIds: ReadonlySet<string>,
): number {
  const keys = new Set<string>();
  for (const reading of report.readings) {
    for (const neighbour of reading.current_neighbours) {
      if (neighbour.id === reading.id) continue;
      if (!liveReadyIds.has(reading.id) || !liveReadyIds.has(neighbour.id)) continue;
      keys.add(orderPair(reading.id, neighbour.id).key);
    }
  }
  return keys.size;
}

function validLiveManifest(manifest: RawManifest, row: ListIndexItem): boolean {
  const parsed = ManifestSchema.safeParse(manifest);
  return (
    parsed.success &&
    manifest.id === row.id &&
    manifest.url === row.url &&
    manifest.status === "ready"
  );
}

function manifestChangedSinceReport(manifest: RawManifest, reportGeneratedAt: string): boolean {
  if (typeof manifest.updated_at !== "string") return true;
  return Date.parse(manifest.updated_at) > Date.parse(reportGeneratedAt);
}

function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

async function defaultProviderVars(): Promise<Record<string, string | undefined>> {
  const productionVars = parseProductionWorkerVars(await readFile("wrangler.toml", "utf8"));
  return {
    ...loadDotVars(".dev.vars"),
    ...productionVars,
    ...loadDotVars(".prd.vars"),
    ...loadDotVars(".corpus.vars"),
    ...process.env,
  };
}

export function tensionProviderFromVars(
  vars: Record<string, string | undefined>,
  execute: boolean,
  transport: JudgeTransportOverrides = {},
): TensionProviderPlan {
  const fetchImpl = transport.fetch ?? refuseUnguardedFetch;
  const retry = transport.retry ?? judgeRetryDeps();
  const provider = parseSummarizerProvider(vars.SUMMARIZER_PROVIDER);
  if (provider === "openai") {
    const model = vars.OPENAI_SUMMARIZATION_MODEL ?? DEFAULT_OPENAI_SUMMARIZATION_MODEL;
    const effort = parseReasoningEffort(vars.OPENAI_SUMMARIZATION_REASONING_EFFORT);
    if (execute && !vars.OPENAI_API_KEY) throw new Error("missing OPENAI_API_KEY");
    return {
      provider,
      model,
      effort,
      estimate: (input) => {
        const inputTokens = approximateTokens(
          JSON.stringify(buildOpenAITensionRequestBody(input, model, effort)),
        );
        const costUsd = estimateSummarizationCostUsd({
          provider: "openai",
          model,
          input_tokens: inputTokens,
          output_tokens: ASSUMED_OUTPUT_TOKENS,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
        }).synchronous;
        return { inputTokens, outputTokens: ASSUMED_OUTPUT_TOKENS, costUsd };
      },
      judge: (input) =>
        judgeTension(input, {
          fetch: fetchImpl,
          retry,
          provider,
          openaiApiKey: vars.OPENAI_API_KEY ?? "",
          openaiModel: model,
          openaiReasoningEffort: effort,
          anthropicModel: vars.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
        }),
    };
  }
  const model = vars.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
  const effort = parseAnthropicEffort(vars.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT, model);
  if (execute && !vars.ANTHROPIC_API_KEY) throw new Error("missing ANTHROPIC_API_KEY");
  return {
    provider,
    model,
    effort,
    estimate: (input) => {
      const inputTokens = approximateTokens(
        JSON.stringify(buildAnthropicTensionRequestBody(input, model, effort)),
      );
      const costUsd = estimateSummarizationCostUsd({
        provider: "anthropic",
        model,
        input_tokens: inputTokens,
        output_tokens: ASSUMED_OUTPUT_TOKENS,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }).synchronous;
      return { inputTokens, outputTokens: ASSUMED_OUTPUT_TOKENS, costUsd };
    },
    judge: (input) =>
      judgeTension(input, {
        fetch: fetchImpl,
        retry,
        provider,
        openaiApiKey: vars.OPENAI_API_KEY ?? "",
        anthropicApiKey: vars.ANTHROPIC_API_KEY,
        anthropicModel: model,
        anthropicReasoningEffort: effort,
      }),
  };
}

async function readReportIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export const corpusRefreshTensionsCommand: CommandDefinition<CorpusRefreshTensionsDeps> = {
  group: "corpus",
  name: "refresh-tensions",
  summary: "Judge directional tensions between report neighbour pairs from refresh-report.json",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus refresh-tensions --tenant <selector> [options]

Pairs every flagged reading in the tier-one refresh-report.json with its live
ready neighbours, keeps the pairs that share a named person or organization,
a fifth of their keywords, or an existing connection, skips pairs both sides
already remember judging, and plans one pairwise provider call per remaining
pair. Plan mode prints each pair with its overlap evidence and estimated
synchronous cost, plus every free one-sided repair, without a provider call or
storage write. It prints the report's scope; a report with no header is
Scope: unstated, not full — pre-header refresh-neighbours already accepted
positional IDs and --limit, so coverage is not known. A --pair-only pass prints
no scope line.

Execute mode writes each side's directional tension (contradicts, supersedes,
superseded_by, qualifies, qualified_by) and a judged-pair record to BOTH
readings, changing nothing else. Both sides go in ONE transaction, which locks
the two rows in sorted id order before reading either, so a failure leaves
neither side written and two passes judging the same pair from opposite ends
cannot deadlock. The one-sided repairs remain, for pairs left half-written
before that was true and for entries naming a deleted partner, and cost no
paid call. It prints the provider token usage of each judgement and a run
total.

Options:
  --report <path>      Tier-one report. Default: ./refresh-report.json, except with --pair,
                       which reads a report only when --report is passed explicitly.
  --pair <a>,<b>       Hand-pick a pair (repeatable); bypasses the overlap filter and judged skip.
  --limit <n>          Cap paid judgement actions; free repairs always run.
  --concurrency <n>    Judgements in flight during --execute. Default: 4.
  --max-backoff <dur>  Cumulative rate-limit backoff this pass will wait out
                       before it stops dispatching judgements; free repairs still
                       run. Default: 10m (bare = seconds); 30s to 30m.
  --bucket <name>      R2 bucket, which names the database this pass writes.
                       Default: READING_LITE_BUCKET / reading-lite.
  --tenant <selector>  REQUIRED: the tenant id (usr_…) whose corpus to judge.
${DATABASE_URL_ENV_FLAG_HELP}
  --local              Use this checkout's own PostgreSQL.
  ${BILLING_TENANT_FLAG_HELP}
                       Default: --tenant. Required to --execute with --tenant global.
  --execute            Make paid provider calls and write results.
  --sole-writer        Required with --execute: assert all corpus writers are paused.
  --help               Show this message.`,
  defaultDeps: (io: CommandIo): CorpusRefreshTensionsDeps => ({
    io,
    readReport: readReportIfPresent,
    // The same session seam as refresh-connections: one corpus, one pairing of
    // bucket to database, defined in one place.
    withStore: openStore(openOperatorSql, process.env),
    loadProvider: async (execute, paidFetch) =>
      tensionProviderFromVars(await defaultProviderVars(), execute, paidFetch ? { fetch: paidFetch } : {}),
    openSpend: async (env) => (await import("../../system-lib/spend")).openRemoteOperatorSpend(env),
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => Date.now(),
    sleep: realSleep,
  }),
  run: runCorpusRefreshTensions,
};
