import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { ListIndexItem } from "../../../src/schemas/api";
import { ManifestSchema } from "../../../src/schemas/manifest";
import {
  buildAnthropicRelationshipRequestBody,
  buildOpenAIRelationshipRequestBody,
  judgeRelationships,
  type RelationshipJudgementInput,
  type RelationshipJudgementResult,
} from "../../../src/modules/relationship-judgement";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_SUMMARIZATION_MODEL,
  parseAnthropicEffort,
  parseReasoningEffort,
  parseSummarizerProvider,
  type SummarizerProvider,
} from "../../../src/modules/summarizer";
import {
  buildRelationshipJudgementInput,
  isJudgedForReport,
  liveReportNeighbours,
  mergeRelationshipJudgement,
  parseRefreshConnectionsReport,
  type RefreshConnectionsReportReading,
} from "../../corpus-lib/refresh-connections";
import { describeReportScope } from "../../corpus-lib/refresh-neighbours";
import { operatorTenantSelector, type OperatorTenant } from "../../corpus-lib/tenant";
import { soleWriterGuard } from "../../corpus-lib/sole-writer";
import { loadDotVars } from "../../lib/dotvars";
import { DATABASE_URL_ENV_FLAG_HELP, openOperatorSql, type OpenOperatorSql } from "../../pg-lib/operator-db";
import {
  listItems,
  manifestVersion,
  replaceRelationships,
  requireTenantRows,
  withOperatorCorpus,
  type PublishedReplacement,
  type SkippedTarget,
} from "../../pg-lib/operator-corpus";
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
import { judgeRetryDeps } from "../judge-retry";
import {
  createRateLimitGate,
  judgeWithRateLimitRetry,
  parseConcurrencyFlag,
  parseMaxBackoffFlag,
  realSleep,
} from "../execute-pool";
import { runKeyedPool } from "../../lib/concurrency";
import {
  PHASE_PLANNING_READS,
  PHASE_PROVIDER,
  createRefreshTimer,
  formatSeconds,
  printTiming,
  timedRefreshStorage,
  type RefreshTimer,
} from "../refresh-timing";
import { type RetryDeps } from "../../../src/modules/http-retry";
import {
  addUsage,
  emptyUsageTotals,
  formatUsage,
  formatUsageTotals,
} from "../judgement-usage";

const ASSUMED_OUTPUT_TOKENS = 256;

interface Args {
  tenant?: string;
  databaseUrlEnv?: string;
  local: boolean;
  billingTenant?: string;
  report: string;
  bucket: string;
  execute: boolean;
  soleWriter: boolean;
  limit?: number;
  concurrency: number;
  maxBackoffMs: number;
}

/**
 * A reading as planning read it, with the version the write compares against.
 *
 * `version` is the content hash `src/relationship-judge.ts` uses, standing in
 * for the manifest ETag the compare-and-set used to witness: planning reads a
 * manifest, the provider judges from it, and the replace re-reads under the row
 * lock and refuses unless the hash still matches.
 */
export interface StoredManifest {
  manifest: Record<string, unknown>;
  version: string;
}

export interface RefreshConnectionsStorage {
  listItems(): Promise<ListIndexItem[]>;
  readManifest(id: string): Promise<StoredManifest | null>;
  /**
   * Writes one judged relationship set: the rows AND the summary flags on the
   * reading's current revision, in one transaction under the row lock.
   *
   * There is no second write to reconcile. The novelty verdict is a column of
   * the same row, so the closing index/list.json flush — and the list-row heal
   * that existed to repair what a failed flush left behind — are gone with the
   * document that needed them.
   */
  replaceRelationships(entries: readonly PublishedReplacement[]): Promise<{
    replaced: boolean;
    skippedTargets: SkippedTarget[];
  }>;
}

/** Which corpus a pass opens: the bucket names the database, the tenant the rows. */
export interface StoreTarget {
  bucket: string;
  local: boolean;
  databaseUrlEnv?: string;
  tenant: OperatorTenant;
}

export interface RelationshipProviderPlan {
  provider: SummarizerProvider;
  model: string;
  effort: string;
  estimate(input: RelationshipJudgementInput): {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  judge(input: RelationshipJudgementInput): Promise<RelationshipJudgementResult>;
}

export interface CorpusRefreshConnectionsDeps extends BaseDeps {
  readReport: (path: string) => Promise<string>;
  /** Opens the corpus for one pass and closes the session on every exit path. */
  withStore: <T>(
    target: StoreTarget,
    work: (storage: RefreshConnectionsStorage) => Promise<T>,
  ) => Promise<T>;
  // `paidFetch` is the spend-admitted transport, present only under --execute.
  // Without it the provider's judge refuses rather than reach a provider unguarded.
  loadProvider: (execute: boolean, paidFetch?: typeof fetch) => Promise<RelationshipProviderPlan>;
  /** Execute-only: the session with the central spend authority. */
  openSpend: OpenOperatorSpend;
  /** The provider transport, reached only through the spend wrapper. */
  fetch: typeof fetch;
  now: () => number;
  /** Injected so the rate-limit backoff is instant under a fake clock. */
  sleep: (ms: number) => Promise<void>;
}

interface Action {
  report: RefreshConnectionsReportReading;
  row: ListIndexItem;
  stored: StoredManifest;
  input: RelationshipJudgementInput;
  allowedIds: Set<string>;
  estimate: ReturnType<RelationshipProviderPlan["estimate"]>;
}

/** What one execute action produced, held until its turn in plan order. */
interface ExecuteOutcome {
  stdout: string[];
  stderr: string[];
  kind: "judged" | "failed" | "skipped";
  /** Present whenever the provider was called and billed. */
  usage?: RelationshipJudgementResult["usage"];
}

function parseRefreshConnectionsArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        tenant: { type: "string" },
        "billing-tenant": { type: "string" },
        "database-url-env": { type: "string" },
        local: { type: "boolean", default: false },
        report: { type: "string", default: "refresh-report.json" },
        bucket: {
          type: "string",
          default: process.env.READING_LITE_BUCKET ?? "reading-lite",
        },
        execute: { type: "boolean", default: false },
        "sole-writer": { type: "boolean", default: false },
        limit: { type: "string" },
        concurrency: { type: "string" },
        "max-backoff": { type: "string" },
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
  return {
    ...(values.tenant === undefined ? {} : { tenant: values.tenant }),
    ...(values["database-url-env"] === undefined
      ? {}
      : { databaseUrlEnv: values["database-url-env"] }),
    local: values.local === true,
    report: values.report!,
    ...(values["billing-tenant"] === undefined ? {} : { billingTenant: values["billing-tenant"] }),
    bucket: values.bucket!,
    execute: values.execute === true,
    soleWriter: values["sole-writer"] === true,
    ...(limit === undefined ? {} : { limit }),
    concurrency: parseConcurrencyFlag(values.concurrency),
    maxBackoffMs: parseMaxBackoffFlag(values["max-backoff"]),
  };
}

// The block prints in a finally: the passes worth timing most are the ones
// that end in a thrown stale-report or storage error, having already spent
// minutes of planning reads.
async function runCorpusRefreshConnections(
  argv: string[],
  deps: CorpusRefreshConnectionsDeps,
): Promise<number> {
  const args = parseRefreshConnectionsArgs(argv);
  const timer = createRefreshTimer(deps.now);
  try {
    const tenant = requireOperatorTenant(args.tenant);
    // Before the spend session opens: `--tenant global` names the pre-tenant R2
    // layout, which has no rows to judge, and admitting spend for work that
    // cannot happen is the failure worth preventing.
    requireTenantRows(tenant);
    const billingTenant = resolveBillingTenant(args.billingTenant, { tenant, execute: args.execute });
    // An --execute without --sole-writer is refused inside, before any provider
    // is loaded, so it needs no spend session either.
    if (!args.execute || !args.soleWriter) return await refreshConnections(args, deps, timer, undefined);
    return await withOperatorPaidFetch(
      deps,
      { env: spendEnvironmentForBucket(args.bucket), billingTenant, command: "corpus-refresh-connections" },
      (paidFetch) => refreshConnections(args, deps, timer, paidFetch),
    );
  } finally {
    printTiming(timer, deps.io.stdout);
  }
}

async function refreshConnections(
  args: Args,
  deps: CorpusRefreshConnectionsDeps,
  timer: RefreshTimer,
  paidFetch: typeof fetch | undefined,
): Promise<number> {
  if (args.execute && !args.soleWriter) {
    const verdict = soleWriterGuard({
      execute: true,
      acknowledged: false,
      tool: "ops corpus refresh-connections",
    });
    if (verdict.message) deps.io.stderr(verdict.message);
    throw new UsageError("--execute requires --sole-writer");
  }

  const tenant = requireOperatorTenant(args.tenant);
  const selector = operatorTenantSelector(tenant);
  const report = parseRefreshConnectionsReport(
    JSON.parse(await deps.readReport(args.report)) as unknown,
    selector,
  );
  const provider = await deps.loadProvider(args.execute, paidFetch);
  // One phase covers every manifest read: they all happen while planning, and
  // execute writes against the ETags those reads returned. A read added back
  // to the execute path would need its own phase again — the selector is a
  // function so that it can be given one — or it would hide inside this total.
  return deps.withStore(
    {
      bucket: args.bucket,
      local: args.local,
      ...(args.databaseUrlEnv === undefined ? {} : { databaseUrlEnv: args.databaseUrlEnv }),
      tenant,
    },
    (raw) => judgeFromReport(args, deps, timer, { report, provider, selector, storage: raw }),
  );
}

interface JudgeContext {
  report: ReturnType<typeof parseRefreshConnectionsReport>;
  provider: RelationshipProviderPlan;
  selector: string;
  storage: RefreshConnectionsStorage;
}

async function judgeFromReport(
  args: Args,
  deps: CorpusRefreshConnectionsDeps,
  timer: RefreshTimer,
  ctx: JudgeContext,
): Promise<number> {
  const { report, provider, selector } = ctx;
  const storage = timedRefreshStorage(ctx.storage, timer, () => PHASE_PLANNING_READS);
  const items = await storage.listItems();
  const byId = new Map(items.map((item) => [item.id, item]));
  const manifests = createPrefetchingReader<StoredManifest | null>((id) =>
    storage.readManifest(id),
  );
  const readStored = (row: ListIndexItem): Promise<StoredManifest | null> =>
    manifests.read(row.id);
  const prefetchStored = (rows: readonly ListIndexItem[]): Promise<void> =>
    manifests.prefetch(rows.map((row) => row.id));
  const liveReadyIds = new Set<string>();
  const invalidCandidateIds = new Set<string>();
  let planningFailed = false;
  const candidateIds = new Set(
    report.readings.flatMap((reading) =>
      reading.current_neighbours.map((neighbour) => neighbour.id),
    ),
  );
  const candidateRows = [...candidateIds]
    .map((id) => byId.get(id))
    .filter((row): row is ListIndexItem => row !== undefined && row.status === "ready");
  await prefetchStored(candidateRows);
  for (const id of candidateIds) {
    const row = byId.get(id);
    if (!row || row.status !== "ready") continue;
    let stored: StoredManifest | null;
    try {
      stored = await readStored(row);
    } catch (error) {
      planningFailed = true;
      invalidCandidateIds.add(id);
      deps.io.stderr(
        `  ! candidate ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (stored && validLiveManifest(stored.manifest, row)) {
      if (manifestChangedSinceReport(stored.manifest, report.generated_at)) {
        throw new Error(
          `report is stale: neighbour ${id} changed after ${report.generated_at}; regenerate it`,
        );
      }
      liveReadyIds.add(id);
    } else if (stored) {
      planningFailed = true;
      invalidCandidateIds.add(id);
      deps.io.stderr(`  ! candidate ${id}: live manifest is invalid or mismatched`);
    }
  }
  const actions: Action[] = [];
  let skipped = 0;

  const invalidCandidatesOf = (reportReading: RefreshConnectionsReportReading) =>
    reportReading.current_neighbours.filter((neighbour) =>
      invalidCandidateIds.has(neighbour.id),
    );
  // The live row a report reading names, or undefined when the corpus has
  // moved under the report. Shared with the prefetch below so the two agree on
  // exactly which manifests this pass is going to read.
  const targetRow = (reportReading: RefreshConnectionsReportReading) => {
    const row = byId.get(reportReading.id);
    if (
      !row ||
      row.status !== "ready" ||
      row.key_prefix !== reportReading.key_prefix ||
      row.url !== reportReading.url
    ) {
      return undefined;
    }
    return row;
  };
  await prefetchStored(
    report.readings
      .filter((reportReading) => invalidCandidatesOf(reportReading).length === 0)
      .map(targetRow)
      .filter((row): row is ListIndexItem => row !== undefined),
  );

  for (const reportReading of report.readings) {
    const invalidCandidates = invalidCandidatesOf(reportReading);
    if (invalidCandidates.length > 0) {
      skipped++;
      planningFailed = true;
      deps.io.stderr(
        `  ! skip ${reportReading.id}: invalid candidate manifest(s): ${invalidCandidates.map((item) => item.id).join(", ")}`,
      );
      continue;
    }
    const row = targetRow(reportReading);
    if (!row) {
      skipped++;
      deps.io.stderr(`  ! skip ${reportReading.id}: live ready list row does not match report`);
      continue;
    }
    let stored: StoredManifest | null;
    try {
      stored = await readStored(row);
    } catch (error) {
      skipped++;
      planningFailed = true;
      deps.io.stderr(
        `  ! skip ${reportReading.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!stored) {
      skipped++;
      deps.io.stderr(`  ! skip ${reportReading.id}: live manifest is missing`);
      continue;
    }
    if (!validTargetManifest(stored.manifest, reportReading)) {
      skipped++;
      planningFailed = true;
      deps.io.stderr(`  ! skip ${reportReading.id}: live ready manifest is invalid or mismatched`);
      continue;
    }
    if (manifestChangedSinceReport(stored.manifest, report.generated_at)) {
      throw new Error(
        `report is stale: target ${reportReading.id} changed after ${report.generated_at}; regenerate it`,
      );
    }
    // Already judged for this report: a resume marker, and now the whole of
    // it. The list row IS this row, so its verdict cannot disagree with the
    // manifest's and there is nothing left to heal.
    if (isJudgedForReport(stored.manifest, report.generated_at)) continue;
    const neighbours = liveReportNeighbours(reportReading, liveReadyIds);
    let input: RelationshipJudgementInput;
    try {
      input = buildRelationshipJudgementInput(
        stored.manifest,
        reportReading,
        neighbours,
      );
    } catch (error) {
      skipped++;
      planningFailed = true;
      deps.io.stderr(
        `  ! skip ${reportReading.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const allowedIds = new Set(neighbours.map((neighbour) => neighbour.id));
    actions.push({
      report: reportReading,
      row,
      stored,
      input,
      allowedIds,
      estimate: provider.estimate(input),
    });
  }

  const selected =
    args.limit === undefined ? actions : actions.slice(0, args.limit);
  deps.io.stdout(`Bucket: ${args.bucket}${args.local ? " (local)" : ""}`);
  deps.io.stdout(`Tenant: ${selector}`);
  deps.io.stdout(`Report: ${args.report} (${report.readings.length} flagged)`);
  // What tier 1 measured, from the report's own header: a nightly log that does
  // not say this cannot be read as covering the corpus.
  deps.io.stdout(describeReportScope(report.scope));
  deps.io.stdout(
    `Provider: ${provider.provider} ${provider.model} effort=${provider.effort}`,
  );
  deps.io.stdout(
    `Mode: ${args.execute ? `EXECUTE (concurrency ${args.concurrency})` : "PLAN"}`,
  );
  deps.io.stdout(`Selected actions: ${selected.length}; skipped: ${skipped}\n`);

  let estimatedTotal = 0;
  for (const action of selected) {
    const estimate = action.estimate;
    estimatedTotal += estimate.costUsd;
    const priorVerdict = action.report.novelty_verdict ?? "(unset)";
    const priorConnections =
      action.report.connections.map((connection) => connection.id).join(",") || "(none)";
    const candidates =
      liveReportNeighbours(action.report, liveReadyIds)
        .map((neighbour) => `${neighbour.id}@${neighbour.score.toFixed(3)}`)
        .join(",") || "(none)";
    deps.io.stdout(
      `  ${action.report.id}  judge reasons=${action.report.reasons.join(",")} ` +
        `prior=${priorVerdict}[${priorConnections}] candidates=${candidates} ` +
        `input≈${estimate.inputTokens} ` +
        `output=${estimate.outputTokens} cost≈$${estimate.costUsd.toFixed(6)}  ${action.report.url}`,
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
  const soleWriter = soleWriterGuard({
    execute: true,
    acknowledged: true,
    tool: "ops corpus refresh-connections",
  });
  if (soleWriter.message) deps.io.stderr(soleWriter.message);

  let failures = 0;
  let judged = 0;
  let ceilingSkipped = 0;
  const skippedTargets: SkippedTarget[] = [];
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

  // One action, start to finish, with nothing written outside it: the caller
  // folds the counters and prints the lines in plan order once every earlier
  // action has been folded, so overlapping the calls cannot reorder the run's
  // output or its accounting.
  const runAction = async (action: Action): Promise<ExecuteOutcome> => {
    const outcome: ExecuteOutcome = { stdout: [], stderr: [], kind: "failed" };
    const failWith = (message: string): ExecuteOutcome => {
      outcome.stderr.push(`  ! ${action.report.id}: ${message}`);
      return outcome;
    };
    const ceilingSkip = (): ExecuteOutcome => {
      outcome.kind = "skipped";
      outcome.stderr.push(
        `  ! skip ${action.report.id}: backoff ceiling reached before this action ran`,
      );
      return outcome;
    };
    if (gate.stopped()) return ceilingSkip();
    // No re-read: planning read this reading and kept its version, and a report
    // names a reading once, so nothing earlier in this pass can have written
    // it. The conditional write below is what detects a reading that changed
    // since planning, and it detects the changes a re-read never could — the
    // ones that land while the judgement is in flight.
    const current = action.stored;
    try {
      // Built at plan time from this same manifest, and the estimate printed
      // in plan order was made from it.
      const input = action.input;
      // The one place a rate limit is observed for the whole pass: wait for any
      // window another worker opened before adding to it. The wait sits here
      // rather than earlier because it is the paid call it is pacing.
      await gate.wait();
      // Woken by the ceiling rather than by the window expiring: this action
      // never called the provider, so it is skipped, not failed.
      if (gate.stopped()) return ceilingSkip();
      const { value: result, ms: providerMs } = await judgeWithRateLimitRetry(
        gate,
        () => timer.measured(PHASE_PROVIDER, () => provider.judge(input)),
      );
      // Carried on the outcome whatever happens next, so the run total covers
      // every call billed, including judgements whose write later fails.
      outcome.usage = result.usage;
      outcome.stdout.push(
        `  ${action.report.id}  ${formatUsage(result.usage)} ms=${providerMs}`,
      );
      const merged = mergeRelationshipJudgement(
        current.manifest,
        result.judgement,
        action.allowedIds,
        new Date(deps.now()).toISOString(),
      );
      if (!merged.ok) return failWith(merged.error);
      const next = ManifestSchema.safeParse(merged.manifest);
      // The judgement is merged onto a manifest that already parsed, so this
      // can only fail on what the provider contributed. Refused rather than
      // written: the rows are the corpus now, and a reading the Worker would
      // reject at read time must not be stored.
      if (!next.success) return failWith(`judged manifest is invalid: ${next.error.message}`);
      const written = await storage.replaceRelationships([
        {
          id: action.report.id,
          matches: async (live) => (await manifestVersion(live)) === current.version,
          next: next.data,
        },
      ]);
      if (!written.replaced) {
        return failWith("the reading changed since it was planned; no overwrite performed");
      }
      // A target dropped between the judgement and the write. Reported rather
      // than stored, so no refresh needs `corpus purge-connections` run behind
      // it to stay consistent.
      for (const skipped of written.skippedTargets) {
        outcome.stderr.push(
          `  ! ${skipped.sourceId}: skipped ${skipped.kind} target ${skipped.targetId}: no longer exists`,
        );
        skippedTargets.push(skipped);
      }
      outcome.kind = "judged";
      return outcome;
    } catch (error) {
      return failWith(error instanceof Error ? error.message : String(error));
    }
  };

  try {
    await runKeyedPool(
      selected,
      args.concurrency,
      // One reading per action, and a report names a reading once, so tier 2
      // never actually contends; the key still states what the action owns.
      (action) => [action.report.id],
      // `runAction` reports its own failures, but an unforeseen throw would
      // abort the pass with the results behind it unaccounted for, so the last
      // word on that belongs here rather than to the pool.
      async (action) => {
        try {
          return await runAction(action);
        } catch (error) {
          return {
            stdout: [],
            stderr: [
              `  ! ${action.report.id}: ${error instanceof Error ? error.message : String(error)}`,
            ],
            kind: "failed" as const,
          };
        }
      },
      (outcome) => {
        for (const line of outcome.stdout) deps.io.stdout(line);
        for (const line of outcome.stderr) deps.io.stderr(line);
        if (outcome.usage) addUsage(usageTotals, outcome.usage);
        if (outcome.kind === "judged") judged++;
        else if (outcome.kind === "skipped") ceilingSkipped++;
        else failures++;
      },
    );
  } finally {
    // Nothing to flush: the verdict landed on the reading's own row inside the
    // same transaction as its relationships.
  }

  deps.io.stdout(
    `\nJudged: ${judged}; failures: ${failures}` +
      (skippedTargets.length > 0 ? `; targets skipped as missing: ${skippedTargets.length}` : "") +
      (ceilingSkipped > 0 ? `; skipped at the backoff ceiling: ${ceilingSkipped}` : ""),
  );
  deps.io.stdout(formatUsageTotals(usageTotals));
  return planningFailed || failures > 0 || ceilingSkipped > 0 ? 1 : 0;
}

function validTargetManifest(
  manifest: Record<string, unknown>,
  report: RefreshConnectionsReportReading,
): boolean {
  const parsed = ManifestSchema.safeParse(manifest);
  return (
    parsed.success &&
    manifest.id === report.id &&
    manifest.url === report.url &&
    manifest.status === "ready"
  );
}

function validLiveManifest(
  manifest: Record<string, unknown>,
  row: ListIndexItem,
): boolean {
  const parsed = ManifestSchema.safeParse(manifest);
  return (
    parsed.success &&
    manifest.id === row.id &&
    manifest.url === row.url &&
    manifest.status === "ready"
  );
}

function manifestChangedSinceReport(
  manifest: Record<string, unknown>,
  reportGeneratedAt: string,
): boolean {
  if (typeof manifest.updated_at !== "string") return true;
  return Date.parse(manifest.updated_at) > Date.parse(reportGeneratedAt);
}

export function parseProductionWorkerVars(
  wranglerToml: string,
): Record<string, string> {
  const section = wranglerToml.match(
    /^\[env\.production\.vars\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m,
  )?.[1];
  if (section === undefined) {
    throw new Error("wrangler.toml is missing [env.production.vars]");
  }
  const vars: Record<string, string> = {};
  for (const rawLine of section.split(/\r?\n/)) {
    const match = rawLine.match(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"\s*$/);
    if (match) vars[match[1]!] = match[2]!;
  }
  return vars;
}

async function defaultProviderVars(): Promise<Record<string, string | undefined>> {
  const productionVars = parseProductionWorkerVars(
    await readFile("wrangler.toml", "utf8"),
  );
  return {
    ...loadDotVars(".dev.vars"),
    ...productionVars,
    ...loadDotVars(".prd.vars"),
    ...loadDotVars(".corpus.vars"),
    ...process.env,
  };
}

export interface JudgeTransportOverrides {
  fetch?: typeof fetch;
  retry?: RetryDeps;
}

export function providerFromVars(
  vars: Record<string, string | undefined>,
  execute: boolean,
  transport: JudgeTransportOverrides = {},
): RelationshipProviderPlan {
  const fetchImpl = transport.fetch ?? refuseUnguardedFetch;
  const retry = transport.retry ?? judgeRetryDeps();
  const provider = parseSummarizerProvider(vars.SUMMARIZER_PROVIDER);
  if (provider === "openai") {
    const model = vars.OPENAI_SUMMARIZATION_MODEL ?? DEFAULT_OPENAI_SUMMARIZATION_MODEL;
    const effort = parseReasoningEffort(
      vars.OPENAI_SUMMARIZATION_REASONING_EFFORT,
    );
    if (execute && !vars.OPENAI_API_KEY) throw new Error("missing OPENAI_API_KEY");
    return {
      provider,
      model,
      effort,
      estimate: (input) => estimateOpenAI(input, model, effort),
      judge: (input) =>
        judgeRelationships(input, {
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
  const effort = parseAnthropicEffort(
    vars.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT,
    model,
  );
  if (execute && !vars.ANTHROPIC_API_KEY) {
    throw new Error("missing ANTHROPIC_API_KEY");
  }
  return {
    provider,
    model,
    effort,
    estimate: (input) => estimateAnthropic(input, model, effort),
    judge: (input) =>
      judgeRelationships(input, {
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

function estimateOpenAI(
  input: RelationshipJudgementInput,
  model: string,
  effort: ReturnType<typeof parseReasoningEffort>,
) {
  const inputTokens = approximateTokens(
    JSON.stringify(buildOpenAIRelationshipRequestBody(input, model, effort)),
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
}

function estimateAnthropic(
  input: RelationshipJudgementInput,
  model: string,
  effort: ReturnType<typeof parseAnthropicEffort>,
) {
  const inputTokens = approximateTokens(
    JSON.stringify(buildAnthropicRelationshipRequestBody(input, model, effort)),
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
}

/**
 * The default store: one direct PostgreSQL session for the whole pass, closed
 * on every exit path. `requireTenantRows` refuses `--tenant global`, which
 * names the pre-tenant R2 layout and has no rows to judge.
 */
export function openStore(
  open: OpenOperatorSql,
  env: Record<string, string | undefined>,
): CorpusRefreshConnectionsDeps["withStore"] {
  return (target, work) =>
    withOperatorCorpus(target, env, open, ({ sql, tenant, store: rows }) =>
      work({
        listItems: () => listItems(rows),
        readManifest: async (id) => {
          const found = await rows.loadReadingById(id);
          if (!found) return null;
          return {
            manifest: found.manifest as unknown as Record<string, unknown>,
            version: await manifestVersion(found.manifest),
          };
        },
        replaceRelationships: (entries) => replaceRelationships(sql, tenant, entries),
      }),
    );
}

export const corpusRefreshConnectionsCommand: CommandDefinition<CorpusRefreshConnectionsDeps> = {
  group: "corpus",
  name: "refresh-connections",
  summary: "Rejudge stale connections and novelty from refresh-report.json",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus refresh-connections --tenant <selector> [options]

Consumes the tier-one refresh-report.json, validates it against the selected
tenant, and plans one relationship-only provider call for each eligible row.
Plan mode prints every judgement and an estimated synchronous cost without a
provider call or storage write. It prints the report's scope; a report with no
header is Scope: unstated, not full — pre-header refresh-neighbours already
accepted positional IDs and --limit, so coverage is not known.

Execute mode updates only connections, novelty_verdict, and
connections_computed_at. It requires a sole-writer window, and each judgement
is written in one transaction that locks the reading's row before it re-reads
it: a reading that changed since it was planned is refused rather than
overwritten. A judged reading is its own resume marker, so a rerun costs
nothing for the readings a previous pass finished. A connection naming a
reading that has since been deleted is dropped and reported, so no refresh
needs 'corpus purge-connections' run behind it. It prints the provider token
usage of each judgement and a run total.

Options:
  --report <path>      Tier-one report. Default: ./refresh-report.json.
  --limit <n>          Cap selected judgement actions.
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
  defaultDeps: (io: CommandIo): CorpusRefreshConnectionsDeps => ({
    io,
    readReport: (path) => readFile(path, "utf8"),
    withStore: openStore(openOperatorSql, process.env),
    loadProvider: async (execute, paidFetch) =>
      providerFromVars(await defaultProviderVars(), execute, paidFetch ? { fetch: paidFetch } : {}),
    openSpend: async (env) => (await import("../../system-lib/spend")).openRemoteOperatorSpend(env),
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => Date.now(),
    sleep: realSleep,
  }),
  run: runCorpusRefreshConnections,
};
