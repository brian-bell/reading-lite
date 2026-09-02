// `ops corpus refresh-tensions` — tier 3 of the corpus refresh: judge
// directional tensions between pairs the tier-1 report brought together.
//
// Plan-first like refresh-connections: the plan reads the report, the list
// index, and every manifest a candidate pair or --pair names, prints each
// pair with its overlap evidence and estimated cost plus every free repair,
// and writes nothing. --execute --sole-writer makes one paid pairwise call per
// selected pair and writes the derived directional entry to BOTH manifests
// with ETag CAS. Tensions never touch index/list.json.
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
import { operatorTenantSelector } from "../../corpus-lib/tenant";
import { soleWriterGuard } from "../../corpus-lib/sole-writer";
import { loadDotVars } from "../../lib/dotvars";
import { r2InventoryClientFromVars, refreshS3RequestDeps } from "../../lib/cf-clients";
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
  createRateLimitGate,
  parseConcurrencyFlag,
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
import { RateLimitedError } from "../../../src/modules/http-retry";
import {
  parseProductionWorkerVars,
  storageFromClient,
  type JudgeTransportOverrides,
  type RefreshConnectionsStorage,
  type StoredRawManifest,
} from "./corpus-refresh-connections";

const ASSUMED_OUTPUT_TOKENS = 128;

interface Args {
  tenant?: string;
  /** null when --pair was given without an explicit --report. */
  report: string | null;
  reportExplicit: boolean;
  bucket: string;
  execute: boolean;
  soleWriter: boolean;
  limit?: number;
  concurrency: number;
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
  createStorage: (bucket: string, keyRoot: string) => Promise<RefreshTensionsStorage>;
  loadProvider: (execute: boolean) => Promise<TensionProviderPlan>;
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
 * Holding a key blocks a later action, so the pool may dispatch a repair ahead
 * of a judge that is waiting on one. That is safe because a repair's staleness
 * guard compares the live `updated_at` against a plan-time timestamp, and no
 * write this command makes moves `updated_at` (`mergeTensionSide` preserves it
 * verbatim): no action in the pass can make another action's guard trip.
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
        report: { type: "string" },
        bucket: {
          type: "string",
          default: process.env.READING_LITE_BUCKET ?? "reading-lite",
        },
        execute: { type: "boolean", default: false },
        "sole-writer": { type: "boolean", default: false },
        limit: { type: "string" },
        concurrency: { type: "string" },
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
    bucket: values.bucket!,
    execute: values.execute === true,
    soleWriter: values["sole-writer"] === true,
    ...(limit === undefined ? {} : { limit }),
    concurrency: parseConcurrencyFlag(values.concurrency),
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
    return await refreshTensions(args, deps, timer);
  } finally {
    printTiming(timer, deps.io.stdout);
  }
}

async function refreshTensions(
  args: Args,
  deps: CorpusRefreshTensionsDeps,
  timer: RefreshTimer,
): Promise<number> {
  // Planning and execute read the same manifests through the same call, so the
  // phase label is what separates the fixed planning cost from the per-pair
  // re-reads every execute pass pays on top of it.
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
  const provider = await deps.loadProvider(args.execute);
  const storage = timedRefreshStorage(
    await deps.createStorage(args.bucket, tenant.keyRoot),
    timer,
    () => manifestReadPhase,
  );
  const items = await storage.readListIndex();
  const byId = new Map(items.map((item) => [item.id, item]));

  // Every reading a report pair or --pair could name. Manifests are read once
  // for planning; execute re-reads each side for a fresh ETag before writing.
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
  const manifests = createPrefetchingReader<StoredRawManifest | null>((keyPrefix) =>
    storage.readManifest(keyPrefix),
  );
  await manifests.prefetch(wantedRows.map((row) => row.key_prefix));
  for (const id of wantedIds) {
    const row = byId.get(id);
    if (!row || row.status !== "ready") {
      if (pairIds.has(id)) {
        planningFailed = true;
        deps.io.stderr(`  ! ${id}: no live ready list row`);
      }
      continue;
    }
    let stored: StoredRawManifest | null;
    try {
      stored = await manifests.read(row.key_prefix);
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
  manifestReadPhase = PHASE_MANIFEST_READ;
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
  const usageTotals = emptyUsageTotals();
  const gate = createRateLimitGate({
    now: deps.now,
    sleep: deps.sleep,
    onPause: (ms) =>
      deps.io.stderr(
        `  ! provider rate limited; pausing new judgements for ${formatSeconds(ms)}`,
      ),
    onGiveUp: (consecutive) =>
      deps.io.stderr(
        `  ! provider rate limited ${consecutive} times in a row; no longer pausing, ` +
          `the rest of this pass will fail fast`,
      ),
  });
  const readLive = async (id: string): Promise<StoredRawManifest> => {
    const row = byId.get(id);
    if (!row) throw new Error("no list row");
    const current = await storage.readManifest(row.key_prefix);
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
    const writeSide = async (
      id: string,
      partnerId: string,
      entry: Parameters<typeof mergeTensionSide>[2],
      judgedAt: string | undefined,
      current: StoredRawManifest,
    ): Promise<void> => {
      const merged = mergeTensionSide(current.manifest, partnerId, entry, judgedAt);
      if (!merged.ok) throw new Error(merged.error);
      const wrote = await storage.putManifestIfMatch(
        byId.get(id)!.key_prefix,
        merged.manifest,
        current.etag,
      );
      if (!wrote) throw new Error("manifest CAS lost; no overwrite performed");
      outcome.written++;
    };

    if (action.kind === "judge") {
      const { a: aId, b: bId, source, key } = action.candidate;
      let a: StoredRawManifest;
      let b: StoredRawManifest;
      try {
        a = await readLive(aId);
        b = await readLive(bId);
      } catch (error) {
        return fail(key, error);
      }
      if (source === "report" && isPairJudged(a.manifest, b.manifest)) {
        outcome.skippedSincePlan = true;
        outcome.stderr.push(`  ! skip ${key}: judged since the plan was made`);
        return outcome;
      }
      try {
        const input = buildTensionJudgementInput(a.manifest, b.manifest);
        // The one place a rate limit is observed for the whole pass: wait for
        // any window another worker opened before adding to it. The wait sits
        // here, after the re-reads, because it is the paid call it is pacing;
        // the ETags it waited on are still current, since --sole-writer is the
        // only writer.
        const round = await gate.wait();
        const { value: result, ms: providerMs } = await timer.measured(
          PHASE_PROVIDER,
          () => provider.judge(input),
        );
        // A call that came back is the evidence the limit is not sustained.
        gate.succeeded(round);
        outcome.judged = true;
        // Carried on the outcome whatever happens next, so the run total covers
        // every call billed, including judgements whose writes later fail.
        outcome.usage = result.usage;
        outcome.stdout.push(`  ${key}  ${formatUsage(result.usage)} ms=${providerMs}`);
        const computedAt = new Date(deps.now()).toISOString();
        const sides = deriveTensionSides(result.judgement, { a: aId, b: bId }, computedAt);
        await writeSide(aId, bId, sides.a, computedAt, a);
        try {
          await writeSide(bId, aId, sides.b, computedAt, b);
        } catch (error) {
          return fail(
            `${key}: ${bId} not written after ${aId} was (one-sided; rerun repairs it)`,
            error,
          );
        }
        outcome.stdout.push(
          `  ${key}  ${result.judgement.verdict}${result.judgement.side ? ` side=${result.judgement.side}` : ""}`,
        );
        return outcome;
      } catch (error) {
        if (error instanceof RateLimitedError) gate.close(error.retryAfterMs);
        return fail(key, error);
      }
    }

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
        const wrote = await storage.putManifestIfMatch(
          byId.get(repair.on)!.key_prefix,
          merged.manifest,
          target.etag,
        );
        if (!wrote) throw new Error("manifest CAS lost; no overwrite performed");
        outcome.written++;
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
    // failures and spend that a sequential pass never produces.
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
      if (outcome.failed) failures++;
      written += outcome.written;
    },
  );

  deps.io.stdout(
    `\nJudged: ${judged}; manifests written: ${written}; repaired: ${repaired}; ` +
      `skipped since plan: ${skippedSincePlan}; failures: ${failures}`,
  );
  deps.io.stdout(formatUsageTotals(usageTotals));
  return planningFailed || failures > 0 ? 1 : 0;
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

function defaultStorageVars(): Record<string, string | undefined> {
  return {
    ...loadDotVars(".dev.vars"),
    ...loadDotVars(".prd.vars"),
    ...loadDotVars(".corpus.vars"),
    ...process.env,
  };
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
  const fetchImpl = transport.fetch ?? globalThis.fetch;
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
storage write.

Execute mode writes each side's directional tension (contradicts, supersedes,
superseded_by, qualifies, qualified_by) and a judged-pair record to BOTH
manifests with ETag CAS, changing nothing else. index/list.json is not
touched. A crash between the two writes leaves a one-sided pair that the next
run mirrors without another paid call; entries naming a deleted partner are
purged the same way. It prints the provider token usage of each judgement and a
run total.

Options:
  --report <path>      Tier-one report. Default: ./refresh-report.json, except with --pair,
                       which reads a report only when --report is passed explicitly.
  --pair <a>,<b>       Hand-pick a pair (repeatable); bypasses the overlap filter and judged skip.
  --limit <n>          Cap paid judgement actions; free repairs always run.
  --concurrency <n>    Judgements in flight during --execute. Default: 4.
  --bucket <name>      R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --tenant <selector>  REQUIRED: tenant id (usr_…) or 'global'.
  --execute            Make paid provider calls and write results.
  --sole-writer        Required with --execute: assert all corpus writers are paused.
  --help               Show this message.`,
  defaultDeps: (io: CommandIo): CorpusRefreshTensionsDeps => ({
    io,
    readReport: readReportIfPresent,
    createStorage: async (bucket, keyRoot) =>
      storageFromClient(
        // Same opt-in as refresh-connections: the policy belongs to these
        // commands, not to every caller of the shared S3 client.
        r2InventoryClientFromVars(
          defaultStorageVars(),
          bucket,
          globalThis.fetch,
          refreshS3RequestDeps(),
        ),
        keyRoot,
      ),
    loadProvider: async (execute) => tensionProviderFromVars(await defaultProviderVars(), execute),
    now: () => Date.now(),
    sleep: realSleep,
  }),
  run: runCorpusRefreshTensions,
};
