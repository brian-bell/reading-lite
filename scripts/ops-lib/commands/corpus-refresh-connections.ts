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
import { judgeRetryDeps } from "../judge-retry";
import {
  PHASE_MANIFEST_READ,
  PHASE_PLANNING_READS,
  PHASE_PROVIDER,
  createRefreshTimer,
  timedRefreshStorage,
  type RefreshTimer,
} from "../refresh-timing";
import type { RetryDeps } from "../../../src/modules/http-retry";
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
    deps.io.stdout(`\n${timer.format()}`);
  }
}

async function refreshConnections(
  args: Args,
  deps: CorpusRefreshConnectionsDeps,
  timer: RefreshTimer,
): Promise<number> {
  // Planning and execute read the same manifests through the same call, so the
  // phase label is what separates the fixed planning cost from the per-action
  // re-read every execute pass pays on top of it.
  let manifestReadPhase = PHASE_PLANNING_READS;
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
  const storage = timedRefreshStorage(
    await deps.createStorage(args.bucket, tenant.keyRoot),
    timer,
    () => manifestReadPhase,
  );
  const items = await storage.readListIndex();
  const byId = new Map(items.map((item) => [item.id, item]));
  const storedByPrefix = new Map<string, StoredRawManifest | null>();
  const storedErrorsByPrefix = new Map<string, Error>();
  const readStored = async (row: ListIndexItem): Promise<StoredRawManifest | null> => {
    const priorError = storedErrorsByPrefix.get(row.key_prefix);
    if (priorError) throw priorError;
    if (storedByPrefix.has(row.key_prefix)) {
      return storedByPrefix.get(row.key_prefix) ?? null;
    }
    try {
      const stored = await storage.readManifest(row.key_prefix);
      storedByPrefix.set(row.key_prefix, stored);
      return stored;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      storedErrorsByPrefix.set(row.key_prefix, error);
      throw error;
    }
  };
  const liveReadyIds = new Set<string>();
  const invalidCandidateIds = new Set<string>();
  let planningFailed = false;
  const candidateIds = new Set(
    report.readings.flatMap((reading) =>
      reading.current_neighbours.map((neighbour) => neighbour.id),
    ),
  );
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

  for (const reportReading of report.readings) {
    const invalidCandidates = reportReading.current_neighbours.filter((neighbour) =>
      invalidCandidateIds.has(neighbour.id),
    );
    if (invalidCandidates.length > 0) {
      skipped++;
      planningFailed = true;
      deps.io.stderr(
        `  ! skip ${reportReading.id}: invalid candidate manifest(s): ${invalidCandidates.map((item) => item.id).join(", ")}`,
      );
      continue;
    }
    const row = byId.get(reportReading.id);
    if (
      !row ||
      row.status !== "ready" ||
      row.key_prefix !== reportReading.key_prefix ||
      row.url !== reportReading.url
    ) {
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
  deps.io.stdout(`Mode: ${args.execute ? "EXECUTE" : "PLAN"}`);
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
  manifestReadPhase = PHASE_MANIFEST_READ;
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
  try {
    for (const action of selected) {
      if (action.kind === "heal") {
        verdictUpdates.set(
          action.report.id,
          action.stored.manifest.novelty_verdict as ListIndexItem["novelty_verdict"],
        );
        healed++;
        continue;
      }
      let current: StoredRawManifest | null;
      try {
        current = await storage.readManifest(action.row.key_prefix);
      } catch (error) {
        failures++;
        deps.io.stderr(
          `  ! ${action.report.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!current || !validTargetManifest(current.manifest, action.report)) {
        failures++;
        deps.io.stderr(`  ! ${action.report.id}: manifest changed before judgement`);
        continue;
      }
      if (isJudgedForReport(current.manifest, report.generated_at)) {
        verdictUpdates.set(
          action.report.id,
          current.manifest.novelty_verdict as ListIndexItem["novelty_verdict"],
        );
        healed++;
        continue;
      }
      try {
        const input = buildRelationshipJudgementInput(
          current.manifest,
          action.report,
          liveReportNeighbours(action.report, liveReadyIds),
        );
        const { value: result, ms: providerMs } = await timer.measured(
          PHASE_PROVIDER,
          () => provider.judge(input),
        );
        // Counted before the write so the report covers every call billed,
        // including judgements whose manifest write later fails.
        addUsage(usageTotals, result.usage);
        deps.io.stdout(
          `  ${action.report.id}  ${formatUsage(result.usage)} ms=${providerMs}`,
        );
        const merged = mergeRelationshipJudgement(
          current.manifest,
          result.judgement,
          action.allowedIds!,
          new Date(deps.now()).toISOString(),
        );
        if (!merged.ok) {
          failures++;
          deps.io.stderr(`  ! ${action.report.id}: ${merged.error}`);
          continue;
        }
        const wrote = await storage.putManifestIfMatch(
          action.row.key_prefix,
          merged.manifest,
          current.etag,
        );
        if (!wrote) {
          failures++;
          deps.io.stderr(`  ! ${action.report.id}: manifest CAS lost; no overwrite performed`);
          continue;
        }
        verdictUpdates.set(
          action.report.id,
          merged.manifest.novelty_verdict as ListIndexItem["novelty_verdict"],
        );
        judged++;
      } catch (error) {
        failures++;
        deps.io.stderr(
          `  ! ${action.report.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
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
  const client = r2InventoryClientFromVars(defaultStorageVars(), bucket);
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
    async readManifest(keyPrefix) {
      const key = rooted(layout.manifestKey(keyPrefix));
      const [objects, body] = await Promise.all([
        client.listObjects(key),
        client.get(key),
      ]);
      const object = objects.find((candidate) => candidate.key === key);
      if (!object || body === null) return null;
      const raw: unknown = JSON.parse(body);
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
  }),
  run: runCorpusRefreshConnections,
};
