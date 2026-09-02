import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ListIndexSchema, type ListIndexItem } from "../../../src/schemas/api";
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
import { LIST_INDEX_KEY, r2KeyLayout } from "../../../src/modules/stores/layout";
import {
  buildRelationshipJudgementInput,
  isJudgedForReport,
  liveReportNeighbours,
  mergeRelationshipJudgement,
  parseRefreshConnectionsReport,
  type RefreshConnectionsReportReading,
} from "../../corpus-lib/refresh-connections";
import { operatorTenantSelector } from "../../corpus-lib/tenant";
import { soleWriterGuard } from "../../corpus-lib/sole-writer";
import { loadDotVars } from "../../lib/dotvars";
import {
  r2InventoryClientFromVars,
  refreshS3RequestDeps,
  type R2InventoryClient,
} from "../../lib/cf-clients";
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
import { judgeRetryDeps } from "../judge-retry";
import {
  createRateLimitGate,
  parseConcurrencyFlag,
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
import { RateLimitedError, type RetryDeps } from "../../../src/modules/http-retry";
import {
  addUsage,
  emptyUsageTotals,
  formatUsage,
  formatUsageTotals,
} from "../judgement-usage";

const ASSUMED_OUTPUT_TOKENS = 256;
const layout = r2KeyLayout();

interface Args {
  tenant?: string;
  report: string;
  bucket: string;
  execute: boolean;
  soleWriter: boolean;
  limit?: number;
  concurrency: number;
}

export interface StoredRawManifest {
  manifest: Record<string, unknown>;
  etag: string;
}

export interface RefreshConnectionsStorage {
  readListIndex(): Promise<ListIndexItem[]>;
  readManifest(keyPrefix: string): Promise<StoredRawManifest | null>;
  putManifestIfMatch(
    keyPrefix: string,
    manifest: Record<string, unknown>,
    etag: string,
  ): Promise<boolean>;
  writeListIndex(items: ListIndexItem[]): Promise<void>;
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
  createStorage: (
    bucket: string,
    keyRoot: string,
  ) => Promise<RefreshConnectionsStorage>;
  loadProvider: (execute: boolean) => Promise<RelationshipProviderPlan>;
  now: () => number;
  /** Injected so the rate-limit backoff is instant under a fake clock. */
  sleep: (ms: number) => Promise<void>;
}

interface Action {
  kind: "judge" | "heal";
  report: RefreshConnectionsReportReading;
  row: ListIndexItem;
  stored: StoredRawManifest;
  input?: RelationshipJudgementInput;
  allowedIds?: Set<string>;
  estimate?: ReturnType<RelationshipProviderPlan["estimate"]>;
}

/** What one execute action produced, held until its turn in plan order. */
interface ExecuteOutcome {
  stdout: string[];
  stderr: string[];
  kind: "judged" | "healed" | "failed";
  /**
   * The verdict to flush onto the list row. Read for every outcome that is
   * not a failure, `undefined` included: a manifest whose `novelty_verdict`
   * is absent is exactly the drift a heal exists to clear off the row.
   */
  verdict: ListIndexItem["novelty_verdict"];
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
        report: { type: "string", default: "refresh-report.json" },
        bucket: {
          type: "string",
          default: process.env.READING_LITE_BUCKET ?? "reading-lite",
        },
        execute: { type: "boolean", default: false },
        "sole-writer": { type: "boolean", default: false },
        limit: { type: "string" },
        concurrency: { type: "string" },
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
    report: values.report!,
    bucket: values.bucket!,
    execute: values.execute === true,
    soleWriter: values["sole-writer"] === true,
    ...(limit === undefined ? {} : { limit }),
    concurrency: parseConcurrencyFlag(values.concurrency),
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
    return await refreshConnections(args, deps, timer);
  } finally {
    printTiming(timer, deps.io.stdout);
  }
}

async function refreshConnections(
  args: Args,
  deps: CorpusRefreshConnectionsDeps,
  timer: RefreshTimer,
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
  const provider = await deps.loadProvider(args.execute);
  // One phase covers every manifest read: they all happen while planning, and
  // execute writes against the ETags those reads returned.
  const storage = timedRefreshStorage(
    await deps.createStorage(args.bucket, tenant.keyRoot),
    timer,
    () => PHASE_PLANNING_READS,
  );
  const items = await storage.readListIndex();
  const byId = new Map(items.map((item) => [item.id, item]));
  const manifests = createPrefetchingReader<StoredRawManifest | null>((keyPrefix) =>
    storage.readManifest(keyPrefix),
  );
  const readStored = (row: ListIndexItem): Promise<StoredRawManifest | null> =>
    manifests.read(row.key_prefix);
  const prefetchStored = (rows: readonly ListIndexItem[]): Promise<void> =>
    manifests.prefetch(rows.map((row) => row.key_prefix));
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
    let stored: StoredRawManifest | null;
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
    let stored: StoredRawManifest | null;
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
    if (isJudgedForReport(stored.manifest, report.generated_at)) {
      if (row.novelty_verdict !== stored.manifest.novelty_verdict) {
        actions.push({ kind: "heal", report: reportReading, row, stored });
      }
      continue;
    }
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
      kind: "judge",
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
  deps.io.stdout(`Bucket: ${args.bucket}`);
  deps.io.stdout(`Tenant: ${selector}`);
  deps.io.stdout(`Report: ${args.report} (${report.readings.length} flagged)`);
  deps.io.stdout(
    `Provider: ${provider.provider} ${provider.model} effort=${provider.effort}`,
  );
  deps.io.stdout(
    `Mode: ${args.execute ? `EXECUTE (concurrency ${args.concurrency})` : "PLAN"}`,
  );
  deps.io.stdout(`Selected actions: ${selected.length}; skipped: ${skipped}\n`);

  let estimatedTotal = 0;
  for (const action of selected) {
    if (action.kind === "heal") {
      deps.io.stdout(
        `  ${action.report.id}  heal-list  verdict=${String(action.stored.manifest.novelty_verdict)}`,
      );
      continue;
    }
    const estimate = action.estimate!;
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

  const verdictUpdates = new Map<string, ListIndexItem["novelty_verdict"]>();
  let failures = 0;
  let judged = 0;
  let healed = 0;
  let flushFailed = false;
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

  // One action, start to finish, with nothing written outside it: the caller
  // folds the counters and prints the lines in plan order once every earlier
  // action has been folded, so overlapping the calls cannot reorder the run's
  // output or its accounting.
  const runAction = async (action: Action): Promise<ExecuteOutcome> => {
    const outcome: ExecuteOutcome = {
      stdout: [],
      stderr: [],
      kind: "failed",
      verdict: undefined,
    };
    const failWith = (message: string): ExecuteOutcome => {
      outcome.stderr.push(`  ! ${action.report.id}: ${message}`);
      return outcome;
    };
    if (action.kind === "heal") {
      outcome.kind = "healed";
      outcome.verdict = action.stored.manifest
        .novelty_verdict as ListIndexItem["novelty_verdict"];
      return outcome;
    }
    // No re-read: planning read this manifest and kept its ETag, and a report
    // names a reading once, so nothing earlier in this pass can have written
    // it. The conditional write below is what detects a manifest that changed
    // since planning, and it detects the changes a re-read never could — the
    // ones that land while the judgement is in flight.
    const current = action.stored;
    try {
      // Built at plan time from this same manifest, and the estimate printed
      // in plan order was made from it.
      const input = action.input!;
      // The one place a rate limit is observed for the whole pass: wait for any
      // window another worker opened before adding to it. The wait sits here
      // rather than earlier because it is the paid call it is pacing.
      await gate.wait();
      const { value: result, ms: providerMs } = await timer.measured(
        PHASE_PROVIDER,
        () => provider.judge(input),
      );
      // A call that came back is the evidence the limit is not sustained.
      gate.succeeded();
      // Carried on the outcome whatever happens next, so the run total covers
      // every call billed, including judgements whose write later fails.
      outcome.usage = result.usage;
      outcome.stdout.push(
        `  ${action.report.id}  ${formatUsage(result.usage)} ms=${providerMs}`,
      );
      const merged = mergeRelationshipJudgement(
        current.manifest,
        result.judgement,
        action.allowedIds!,
        new Date(deps.now()).toISOString(),
      );
      if (!merged.ok) return failWith(merged.error);
      const wrote = await storage.putManifestIfMatch(
        action.row.key_prefix,
        merged.manifest,
        current.etag,
      );
      if (!wrote) return failWith("manifest CAS lost; no overwrite performed");
      outcome.kind = "judged";
      outcome.verdict = merged.manifest
        .novelty_verdict as ListIndexItem["novelty_verdict"];
      return outcome;
    } catch (error) {
      if (error instanceof RateLimitedError) gate.close(error.retryAfterMs);
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
            verdict: undefined,
          };
        }
      },
      (outcome, index) => {
        for (const line of outcome.stdout) deps.io.stdout(line);
        for (const line of outcome.stderr) deps.io.stderr(line);
        if (outcome.usage) addUsage(usageTotals, outcome.usage);
        // Keyed on the outcome, not on the value: a heal whose manifest has
        // no verdict must still clear the stale one off the list row, or it
        // is re-planned every run and never fixed.
        if (outcome.kind !== "failed") {
          verdictUpdates.set(selected[index]!.report.id, outcome.verdict);
        }
        if (outcome.kind === "judged") judged++;
        else if (outcome.kind === "healed") healed++;
        else failures++;
      },
    );
  } finally {
    if (verdictUpdates.size > 0) {
      const updated = items.map((item) =>
        verdictUpdates.has(item.id)
          ? { ...item, novelty_verdict: verdictUpdates.get(item.id) }
          : item,
      );
      try {
        await storage.writeListIndex(updated);
      } catch (error) {
        flushFailed = true;
        deps.io.stderr(
          `  ! index/list.json write failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  deps.io.stdout(
    `\nJudged: ${judged}; list rows healed: ${healed}; failures: ${failures}`,
  );
  deps.io.stdout(formatUsageTotals(usageTotals));
  return planningFailed || failures > 0 || flushFailed ? 1 : 0;
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

function defaultStorageVars(): Record<string, string | undefined> {
  return {
    ...loadDotVars(".dev.vars"),
    ...loadDotVars(".prd.vars"),
    ...loadDotVars(".corpus.vars"),
    ...process.env,
  };
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
  const fetchImpl = transport.fetch ?? globalThis.fetch;
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

async function createDefaultStorage(
  bucket: string,
  keyRoot: string,
): Promise<RefreshConnectionsStorage> {
  // The deadline and transient retry are the refresh commands' policy, not
  // every ops command's: opt in here rather than in the shared client.
  const client = r2InventoryClientFromVars(
    defaultStorageVars(),
    bucket,
    globalThis.fetch,
    refreshS3RequestDeps(),
  );
  return storageFromClient(client, keyRoot);
}

export function storageFromClient(
  client: R2InventoryClient,
  keyRoot: string,
): RefreshConnectionsStorage {
  const rooted = (key: string) => `${keyRoot}${key}`;
  return {
    async readListIndex() {
      const body = await client.get(rooted(LIST_INDEX_KEY));
      if (body === null) throw new Error(`${LIST_INDEX_KEY} not found`);
      return ListIndexSchema.parse(JSON.parse(body)).items;
    },
    // One GET. The ETag CAS needs comes back on the read response, so the
    // LIST that used to fetch it alongside the body is gone: half the requests,
    // and no window in which the two halves disagree.
    async readManifest(keyPrefix) {
      const key = rooted(layout.manifestKey(keyPrefix));
      const object = await client.getWithEtag(key);
      if (object === null) return null;
      // Every write back to this manifest is an If-Match on this token, and an
      // empty one loses the CAS after the judgement has already been paid for.
      // R2 always sends an ETag, so this is a broken response, not a corpus
      // state: say so before the plan is built on it.
      if (object.etag === "") throw new Error(`manifest ${keyPrefix} was read without an ETag`);
      const raw: unknown = JSON.parse(object.body);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`manifest ${keyPrefix} is not an object`);
      }
      return { manifest: raw as Record<string, unknown>, etag: object.etag };
    },
    async putManifestIfMatch(keyPrefix, manifest, etag) {
      return client.putIfMatch(
        rooted(layout.manifestKey(keyPrefix)),
        JSON.stringify(manifest),
        etag,
        { contentType: "application/json" },
      );
    },
    async writeListIndex(items) {
      await client.put(
        rooted(LIST_INDEX_KEY),
        JSON.stringify({ version: 1, items }),
        { contentType: "application/json" },
      );
    },
  };
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
provider call or storage write.

Execute mode updates only connections, novelty_verdict, and
connections_computed_at, then synchronizes each list-row verdict. It requires a
sole-writer window and uses manifest ETag CAS writes. Completed manifests are
resume markers, so a rerun heals a stale list row without another paid call. It
prints the provider token usage of each judgement and a run total.

Options:
  --report <path>      Tier-one report. Default: ./refresh-report.json.
  --limit <n>          Cap selected judgement or list-heal actions.
  --concurrency <n>    Judgements in flight during --execute. Default: 4.
  --bucket <name>      R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --tenant <selector>  REQUIRED: tenant id (usr_…) or 'global'.
  --execute            Make paid provider calls and write results.
  --sole-writer        Required with --execute: assert all corpus writers are paused.
  --help               Show this message.`,
  defaultDeps: (io: CommandIo): CorpusRefreshConnectionsDeps => ({
    io,
    readReport: (path) => readFile(path, "utf8"),
    createStorage: createDefaultStorage,
    loadProvider: async (execute) =>
      providerFromVars(await defaultProviderVars(), execute),
    now: () => Date.now(),
    sleep: realSleep,
  }),
  run: runCorpusRefreshConnections,
};
