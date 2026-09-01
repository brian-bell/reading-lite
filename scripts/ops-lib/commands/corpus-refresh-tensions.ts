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
  tensionCandidates,
  type RawManifest,
  type RepairAction,
  type TensionCandidate,
} from "../../corpus-lib/refresh-tensions";
import { operatorTenantSelector } from "../../corpus-lib/tenant";
import { soleWriterGuard } from "../../corpus-lib/sole-writer";
import { loadDotVars } from "../../lib/dotvars";
import { r2InventoryClientFromVars } from "../../lib/cf-clients";
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
import {
  parseProductionWorkerVars,
  storageFromClient,
  type RefreshConnectionsStorage,
  type StoredRawManifest,
} from "./corpus-refresh-connections";

const ASSUMED_OUTPUT_TOKENS = 128;

interface Args {
  tenant?: string;
  report: string;
  bucket: string;
  execute: boolean;
  soleWriter: boolean;
  limit?: number;
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
}

type Action =
  | {
      kind: "judge";
      candidate: TensionCandidate;
      input: TensionJudgementInput;
      estimate: ReturnType<TensionProviderPlan["estimate"]>;
    }
  | { kind: "repair"; repair: RepairAction };

function parseRefreshTensionsArgs(argv: string[]): Args {
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
    report: values.report!,
    bucket: values.bucket!,
    execute: values.execute === true,
    soleWriter: values["sole-writer"] === true,
    ...(limit === undefined ? {} : { limit }),
    pairs,
  };
}

async function runCorpusRefreshTensions(
  argv: string[],
  deps: CorpusRefreshTensionsDeps,
): Promise<number> {
  const args = parseRefreshTensionsArgs(argv);
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
  const rawReport = await deps.readReport(args.report);
  if (rawReport === null && args.pairs.length === 0) {
    throw new Error(
      `report ${args.report} not found; run corpus refresh-neighbours first or pass --pair`,
    );
  }
  const report: RefreshConnectionsReport | null =
    rawReport === null
      ? null
      : parseRefreshConnectionsReport(JSON.parse(rawReport) as unknown, selector);
  const provider = await deps.loadProvider(args.execute);
  const storage = await deps.createStorage(args.bucket, tenant.keyRoot);
  const items = await storage.readListIndex();
  const byId = new Map(items.map((item) => [item.id, item]));

  // Every reading a report pair or --pair could name. Manifests are read once
  // for planning; execute re-reads each side for a fresh ETag before writing.
  const wanted = new Set<string>();
  for (const reading of report?.readings ?? []) {
    wanted.add(reading.id);
    for (const neighbour of reading.current_neighbours) wanted.add(neighbour.id);
  }
  for (const [a, b] of args.pairs) {
    wanted.add(a);
    wanted.add(b);
  }
  const manifestsById = new Map<string, RawManifest>();
  const liveReadyIds = new Set<string>();
  let planningFailed = false;
  const pairIds = new Set(args.pairs.flat());
  for (const id of [...wanted].sort()) {
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
      stored = await storage.readManifest(row.key_prefix);
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
    if (report && !pairIds.has(id) && manifestChangedSinceReport(stored.manifest, report.generated_at)) {
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
  const repairs = findOneSided(manifestsById, liveReadyIds);
  const mirrorKeys = new Set(
    repairs.flatMap((repair) => (repair.kind === "drop" ? [] : [pairKey(repair.from, repair.to)])),
  );
  const actions: Action[] = [];
  let skippedJudged = 0;
  for (const candidate of [...candidates.values()].sort((x, y) => x.key.localeCompare(y.key))) {
    const a = manifestsById.get(candidate.a)!;
    const b = manifestsById.get(candidate.b)!;
    if (candidate.source === "report" && (isPairJudged(a, b) || mirrorKeys.has(candidate.key))) {
      skippedJudged++;
      continue;
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
  const judgedKeys = new Set(
    actions.flatMap((action) => (action.kind === "judge" ? [action.candidate.key] : [])),
  );
  for (const repair of repairs) {
    const key = repair.kind === "drop" ? pairKey(repair.on, repair.partner) : pairKey(repair.from, repair.to);
    if (judgedKeys.has(key)) continue;
    actions.push({ kind: "repair", repair });
  }

  const selected = args.limit === undefined ? actions : actions.slice(0, args.limit);
  deps.io.stdout(`Bucket: ${args.bucket}`);
  deps.io.stdout(`Tenant: ${selector}`);
  deps.io.stdout(
    report
      ? `Report: ${args.report} (${report.readings.length} flagged)`
      : `Report: none (--pair only)`,
  );
  deps.io.stdout(`Provider: ${provider.provider} ${provider.model} effort=${provider.effort}`);
  deps.io.stdout(`Mode: ${args.execute ? "EXECUTE" : "PLAN"}`);
  deps.io.stdout(
    `Selected actions: ${selected.length}; below overlap threshold: ${filteredOut}; already judged: ${skippedJudged}\n`,
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
  const fail = (label: string, error: unknown) => {
    failures++;
    deps.io.stderr(`  ! ${label}: ${error instanceof Error ? error.message : String(error)}`);
  };
  const readLive = async (id: string): Promise<StoredRawManifest> => {
    const row = byId.get(id);
    if (!row) throw new Error("no list row");
    const current = await storage.readManifest(row.key_prefix);
    if (!current || !validLiveManifest(current.manifest, row)) {
      throw new Error("manifest changed before write");
    }
    return current;
  };
  const writeSide = async (
    id: string,
    partnerId: string,
    entry: Parameters<typeof mergeTensionSide>[2],
    judgedAt: string | undefined,
    current: StoredRawManifest,
  ): Promise<boolean> => {
    const merged = mergeTensionSide(current.manifest, partnerId, entry, judgedAt);
    if (!merged.ok) throw new Error(merged.error);
    const wrote = await storage.putManifestIfMatch(
      byId.get(id)!.key_prefix,
      merged.manifest,
      current.etag,
    );
    if (!wrote) throw new Error("manifest CAS lost; no overwrite performed");
    written++;
    return true;
  };

  for (const action of selected) {
    if (action.kind === "judge") {
      const { a: aId, b: bId, source, key } = action.candidate;
      let a: StoredRawManifest;
      let b: StoredRawManifest;
      try {
        a = await readLive(aId);
        b = await readLive(bId);
      } catch (error) {
        fail(key, error);
        continue;
      }
      if (source === "report" && isPairJudged(a.manifest, b.manifest)) continue;
      try {
        const input = buildTensionJudgementInput(a.manifest, b.manifest);
        const result = await provider.judge(input);
        judged++;
        const computedAt = new Date(deps.now()).toISOString();
        const sides = deriveTensionSides(result.judgement, { a: aId, b: bId }, computedAt);
        await writeSide(aId, bId, sides.a, computedAt, a);
        try {
          await writeSide(bId, aId, sides.b, computedAt, b);
        } catch (error) {
          fail(
            `${key}: ${bId} not written after ${aId} was (one-sided; rerun repairs it)`,
            error,
          );
          continue;
        }
        deps.io.stdout(
          `  ${key}  ${result.judgement.verdict}${result.judgement.side ? ` side=${result.judgement.side}` : ""}`,
        );
      } catch (error) {
        fail(key, error);
      }
      continue;
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
      } else {
        const target = await readLive(repair.on);
        await writeSide(repair.on, repair.partner, null, undefined, target);
      }
      repaired++;
    } catch (error) {
      fail(describeRepair(repair), error);
    }
  }

  deps.io.stdout(
    `\nJudged: ${judged}; manifests written: ${written}; repaired: ${repaired}; failures: ${failures}`,
  );
  return planningFailed || failures > 0 ? 1 : 0;
}

function describeRepair(repair: RepairAction): string {
  switch (repair.kind) {
    case "mirror":
      return `${repair.to}<-${repair.from}  repair mirror ${repair.entry.kind} (no provider call)`;
    case "mirror-judged":
      return `${repair.to}<-${repair.from}  repair mirror judged-at ${repair.judged_at} (no provider call)`;
    case "drop":
      return `${repair.on}  repair drop stale tension -> ${repair.partner} (partner reprocessed since)`;
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
): TensionProviderPlan {
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
          fetch: globalThis.fetch,
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
        fetch: globalThis.fetch,
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
run mirrors without another paid call.

Options:
  --report <path>      Tier-one report. Default: ./refresh-report.json (optional with --pair).
  --pair <a>,<b>       Hand-pick a pair (repeatable); bypasses the overlap filter and judged skip.
  --limit <n>          Cap selected judgement and repair actions.
  --bucket <name>      R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --tenant <selector>  REQUIRED: tenant id (usr_…) or 'global'.
  --execute            Make paid provider calls and write results.
  --sole-writer        Required with --execute: assert all corpus writers are paused.
  --help               Show this message.`,
  defaultDeps: (io: CommandIo): CorpusRefreshTensionsDeps => ({
    io,
    readReport: readReportIfPresent,
    createStorage: async (bucket, keyRoot) =>
      storageFromClient(r2InventoryClientFromVars(defaultStorageVars(), bucket), keyRoot),
    loadProvider: async (execute) => tensionProviderFromVars(await defaultProviderVars(), execute),
    now: () => Date.now(),
  }),
  run: runCorpusRefreshTensions,
};
