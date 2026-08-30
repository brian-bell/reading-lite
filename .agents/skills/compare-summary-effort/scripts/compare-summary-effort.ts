#!/usr/bin/env -S npx tsx
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_ANTHROPIC_SUMMARIZATION_REASONING_EFFORT,
  DEFAULT_OPENAI_SUMMARIZATION_MODEL,
  parseAnthropicEffort as parseModelAwareAnthropicEffort,
  parseReasoningEffort,
  summarizeReading,
  type AnthropicReasoningEffort,
  type OpenAIReasoningEffort,
  type SummarizeReadingResult,
  type SummarizeReadingInput,
  type SummarizerDeps,
} from "../../../../src/modules/summarizer";
import {
  ManifestSchema,
  ReadingSummarySchema,
  type ReadingSummary,
  type SummarizationUsage,
} from "../../../../src/schemas/manifest";
import { loadDotVars } from "../../../../scripts/lib/dotvars";

const DEFAULT_BASE_URL = "https://reading-lite.bbell.dev";
const DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const DEFAULT_INPUT_PRICE_PER_MILLION = 2;
const DEFAULT_OUTPUT_PRICE_PER_MILLION = 12;
const DEFAULT_ANTHROPIC_INPUT_PRICE_PER_MILLION = 3;
const DEFAULT_ANTHROPIC_OUTPUT_PRICE_PER_MILLION = 15;
const DEFAULT_PRICE_DATE = "2026-07-30";
const MAX_OUTPUT_TOKENS = 8192;
const ANTHROPIC_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly AnthropicReasoningEffort[];

export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

export interface ComparisonArgs {
  targets: string[];
  baseUrl: string;
  execute: boolean;
  efforts: OpenAIReasoningEffort[];
  includeAnthropic: boolean;
  anthropicModel: string;
  anthropicEffort: AnthropicEffort;
  outputDir?: string;
  model?: string;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  anthropicInputPricePerMillion: number;
  anthropicOutputPricePerMillion: number;
  priceDate: string;
}

export type ComparisonCandidate =
  | {
      provider: "openai";
      model: string;
      reasoningEffort: OpenAIReasoningEffort;
    }
  | {
      provider: "anthropic";
      model: string;
      anthropicEffort: AnthropicEffort;
    };

export interface FrozenReading {
  readingId: string;
  contentSha256: string;
  input: SummarizeReadingInput;
  productionBaseline: ReadingSummary;
  productionUsage?: SummarizationUsage;
}

export interface ComparisonPlan {
  readings: FrozenReading[];
  candidates: ComparisonCandidate[];
  openaiModel: string;
  efforts: OpenAIReasoningEffort[];
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  anthropicInputPricePerMillion: number;
  anthropicOutputPricePerMillion: number;
  priceDate: string;
  estimatedMaximumCostUsd: number;
}

export interface PrepareComparisonDeps {
  fetch: typeof fetch;
  readerToken: string;
}

export interface RunComparisonDeps {
  summarize(
    input: SummarizeReadingInput,
    candidate: ComparisonCandidate,
  ): Promise<SummarizeReadingResult>;
  now(): number;
  onProgress?(observation: ComparisonObservation): void | Promise<void>;
}

export interface ComparisonObservation {
  readingId: string;
  provider: ComparisonCandidate["provider"];
  model: string;
  reasoningEffort?: OpenAIReasoningEffort;
  anthropicEffort?: AnthropicEffort;
  latencyMs: number;
  reading: ReadingSummary;
  usage: SummarizationUsage;
  estimatedCostUsd: number;
}

export interface ComparisonArtifactPaths {
  resultsPath: string;
  reportPath: string;
}

export interface CompareCliDeps {
  fetch: typeof fetch;
  now(): number;
  credentials: Record<string, string | undefined>;
  summarize?: RunComparisonDeps["summarize"];
  stdout?(text: string): void;
  stderr?(text: string): void;
}

export interface CompareRunResult {
  mode: "plan" | "execute";
  plan: ComparisonPlan;
  observations?: ComparisonObservation[];
  paths?: ComparisonArtifactPaths;
  outputDir?: string;
}

export function parseAnthropicEffort(value: string): AnthropicEffort {
  if ((ANTHROPIC_EFFORTS as readonly string[]).includes(value)) {
    return value as AnthropicEffort;
  }
  throw new Error(
    `invalid Anthropic effort: ${value} (expected low|medium|high|xhigh|max)`,
  );
}

export function parseComparisonArgs(argv: string[]): ComparisonArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: "string", multiple: true, default: [] },
      "base-url": { type: "string", default: DEFAULT_BASE_URL },
      execute: { type: "boolean", default: false },
      effort: { type: "string", multiple: true, default: [] },
      "output-dir": { type: "string" },
      model: { type: "string" },
      "anthropic-model": { type: "string" },
      "anthropic-effort": { type: "string" },
      "openai-only": { type: "boolean", default: false },
      "input-price": {
        type: "string",
        default: String(DEFAULT_INPUT_PRICE_PER_MILLION),
      },
      "output-price": {
        type: "string",
        default: String(DEFAULT_OUTPUT_PRICE_PER_MILLION),
      },
      "anthropic-input-price": {
        type: "string",
        default: String(DEFAULT_ANTHROPIC_INPUT_PRICE_PER_MILLION),
      },
      "anthropic-output-price": {
        type: "string",
        default: String(DEFAULT_ANTHROPIC_OUTPUT_PRICE_PER_MILLION),
      },
      "price-date": { type: "string", default: DEFAULT_PRICE_DATE },
    },
    strict: true,
  });
  if (!values.target || values.target.length === 0) {
    throw new Error("--target is required (repeatable)");
  }
  if (values["openai-only"] && values["anthropic-effort"]) {
    throw new Error("--anthropic-effort cannot be combined with --openai-only");
  }
  const includeAnthropic = values["openai-only"] !== true;
  const anthropicModel = values["anthropic-model"] ?? DEFAULT_ANTHROPIC_MODEL;
  const anthropicEffort = values["anthropic-effort"]
    ? parseAnthropicEffort(values["anthropic-effort"])
    : DEFAULT_ANTHROPIC_SUMMARIZATION_REASONING_EFFORT;
  if (includeAnthropic) {
    parseModelAwareAnthropicEffort(anthropicEffort, anthropicModel);
  }
  const efforts =
    values.effort!.length === 0
      ? [...DEFAULT_EFFORTS]
      : [...new Set(values.effort!.map(parseReasoningEffort))];
  const inputPricePerMillion = Number(values["input-price"]);
  const outputPricePerMillion = Number(values["output-price"]);
  const anthropicInputPricePerMillion = Number(values["anthropic-input-price"]);
  const anthropicOutputPricePerMillion = Number(values["anthropic-output-price"]);
  if (!Number.isFinite(inputPricePerMillion) || inputPricePerMillion < 0) {
    throw new Error("--input-price must be a non-negative number");
  }
  if (!Number.isFinite(outputPricePerMillion) || outputPricePerMillion < 0) {
    throw new Error("--output-price must be a non-negative number");
  }
  if (
    !Number.isFinite(anthropicInputPricePerMillion) ||
    anthropicInputPricePerMillion < 0
  ) {
    throw new Error("--anthropic-input-price must be a non-negative number");
  }
  if (
    !Number.isFinite(anthropicOutputPricePerMillion) ||
    anthropicOutputPricePerMillion < 0
  ) {
    throw new Error("--anthropic-output-price must be a non-negative number");
  }
  return {
    targets: uniqueTargets(values.target),
    baseUrl: values["base-url"]!.replace(/\/$/, ""),
    execute: values.execute!,
    efforts,
    includeAnthropic,
    anthropicModel,
    anthropicEffort,
    outputDir: values["output-dir"],
    model: values.model,
    inputPricePerMillion,
    outputPricePerMillion,
    anthropicInputPricePerMillion,
    anthropicOutputPricePerMillion,
    priceDate: values["price-date"]!,
  };
}

export function buildCandidateMatrix(
  args: Pick<
    ComparisonArgs,
    "efforts" | "includeAnthropic" | "anthropicModel" | "anthropicEffort"
  >,
  openaiModel: string,
): ComparisonCandidate[] {
  const candidates: ComparisonCandidate[] = args.efforts.map(
    (reasoningEffort) => ({
      provider: "openai" as const,
      model: openaiModel,
      reasoningEffort,
    }),
  );
  if (args.includeAnthropic) {
    candidates.push({
      provider: "anthropic",
      model: args.anthropicModel,
      anthropicEffort: args.anthropicEffort,
    });
  }
  return candidates;
}

export function candidateLabel(candidate: ComparisonCandidate): string {
  if (candidate.provider === "openai") {
    return `openai/${candidate.model} effort=${candidate.reasoningEffort}`;
  }
  return `anthropic/${candidate.model} effort=${candidate.anthropicEffort}`;
}

export function formatComparisonPlan(
  plan: ComparisonPlan,
  execute: boolean,
): string {
  const readingCount = plan.readings.length;
  const candidateCount = plan.candidates.length;
  const callCount = readingCount * candidateCount;
  const readingNoun = readingCount === 1 ? "reading" : "readings";
  const candidateNoun = candidateCount === 1 ? "candidate" : "candidates";
  const callNoun = callCount === 1 ? "provider call" : "provider calls";
  const readingLines = plan.readings
    .map(
      (reading) =>
        `  ${reading.readingId}\n` +
        `    source: ${reading.input.url}\n` +
        `    frozen similar readings: ${reading.input.similarReadings.length}`,
    )
    .join("\n");
  const candidateLines = plan.candidates
    .map((candidate) => `    ${candidateLabel(candidate)}`)
    .join("\n");
  const anthropicCandidate = plan.candidates.find(
    (candidate) => candidate.provider === "anthropic",
  );
  const anthropicLine = anthropicCandidate
    ? `  anthropic: ${anthropicCandidate.model} effort=${anthropicCandidate.anthropicEffort}\n`
    : "  anthropic: omitted\n";
  return (
    `${execute ? "[EXECUTE]" : "[DRY RUN]"} ${readingCount} ${readingNoun} × ${candidateCount} ${candidateNoun} = ${callCount} ${callNoun}\n` +
    `${readingLines}\n` +
    `  openai model: ${plan.openaiModel}\n` +
    `  openai efforts: ${plan.efforts.join(", ")}\n` +
    anthropicLine +
    `  candidates:\n${candidateLines}\n` +
    `  conservative maximum: $${plan.estimatedMaximumCostUsd.toFixed(4)} ` +
    `(pricing as of ${plan.priceDate})\n`
  );
}

export function summarizerDepsForCandidate(
  candidate: ComparisonCandidate,
  creds: {
    fetch: typeof fetch;
    openaiApiKey: string;
    anthropicApiKey?: string;
  },
): SummarizerDeps {
  if (candidate.provider === "openai") {
    return {
      fetch: creds.fetch,
      provider: "openai",
      openaiApiKey: creds.openaiApiKey,
      openaiModel: candidate.model,
      openaiReasoningEffort: candidate.reasoningEffort,
      anthropicApiKey: creds.anthropicApiKey,
      anthropicModel: DEFAULT_ANTHROPIC_MODEL,
    };
  }
  if (!creds.anthropicApiKey) {
    throw new Error("missing ANTHROPIC_API_KEY");
  }
  return {
    fetch: creds.fetch,
    provider: "anthropic",
    openaiApiKey: creds.openaiApiKey,
    anthropicApiKey: creds.anthropicApiKey,
    anthropicModel: candidate.model,
    anthropicReasoningEffort: candidate.anthropicEffort,
  };
}

export async function prepareComparison(
  args: ComparisonArgs,
  deps: PrepareComparisonDeps,
): Promise<ComparisonPlan> {
  const readings: FrozenReading[] = [];
  const seen = new Set<string>();
  for (const target of args.targets) {
    const frozen = await freezeReading(target, args.baseUrl, deps);
    if (seen.has(frozen.readingId)) continue;
    seen.add(frozen.readingId);
    readings.push(frozen);
  }
  const openaiModel = resolveOpenAIModel(args.model, readings);
  const candidates = buildCandidateMatrix(args, openaiModel);
  const estimatedMaximumCostUsd = readings.reduce((sum, reading) => {
    const estimatedInputTokens = estimateInputTokens(reading);
    const openaiCallCeiling =
      (estimatedInputTokens * args.inputPricePerMillion +
        MAX_OUTPUT_TOKENS * args.outputPricePerMillion) /
      1_000_000;
    const anthropicCallCeiling =
      (estimatedInputTokens * args.anthropicInputPricePerMillion +
        MAX_OUTPUT_TOKENS * args.anthropicOutputPricePerMillion) /
      1_000_000;
    const openaiCount = candidates.filter(
      (candidate) => candidate.provider === "openai",
    ).length;
    const anthropicCount = candidates.filter(
      (candidate) => candidate.provider === "anthropic",
    ).length;
    return sum + openaiCallCeiling * openaiCount + anthropicCallCeiling * anthropicCount;
  }, 0);

  return {
    readings,
    candidates,
    openaiModel,
    efforts: args.efforts,
    inputPricePerMillion: args.inputPricePerMillion,
    outputPricePerMillion: args.outputPricePerMillion,
    anthropicInputPricePerMillion: args.anthropicInputPricePerMillion,
    anthropicOutputPricePerMillion: args.anthropicOutputPricePerMillion,
    priceDate: args.priceDate,
    estimatedMaximumCostUsd,
  };
}

export async function runComparison(
  plan: ComparisonPlan,
  deps: RunComparisonDeps,
): Promise<ComparisonObservation[]> {
  const observations: ComparisonObservation[] = [];
  for (const reading of plan.readings) {
    for (const candidate of plan.candidates) {
      const startedAt = deps.now();
      const result = await deps.summarize(reading.input, candidate);
      const latencyMs = deps.now() - startedAt;
      if (result.usage.provider !== candidate.provider) {
        throw new Error(
          `comparison candidate ${candidateLabel(candidate)} returned ${result.usage.provider} usage`,
        );
      }
      const observation: ComparisonObservation = {
        readingId: reading.readingId,
        provider: candidate.provider,
        model: candidate.model,
        ...(candidate.provider === "openai"
          ? { reasoningEffort: candidate.reasoningEffort }
          : { anthropicEffort: candidate.anthropicEffort }),
        latencyMs,
        reading: result.reading,
        usage: result.usage,
        estimatedCostUsd: estimateActualCost(result.usage, plan),
      };
      observations.push(observation);
      await deps.onProgress?.(observation);
    }
  }
  return observations;
}

export async function runCheckpointedComparison(
  plan: ComparisonPlan,
  outputDir: string,
  generatedAt: string,
  deps: RunComparisonDeps,
): Promise<{
  observations: ComparisonObservation[];
  paths: ComparisonArtifactPaths;
}> {
  const completed: ComparisonObservation[] = [];
  let paths: ComparisonArtifactPaths | undefined;
  const observations = await runComparison(plan, {
    ...deps,
    onProgress: async (observation) => {
      completed.push(observation);
      paths = await writeComparisonArtifacts(
        plan,
        completed,
        outputDir,
        generatedAt,
      );
      await deps.onProgress?.(observation);
    },
  });
  if (!paths) throw new Error("comparison completed without any candidates");
  return { observations, paths };
}

export async function writeComparisonArtifacts(
  plan: ComparisonPlan,
  observations: ComparisonObservation[],
  outputDir: string,
  generatedAt: string,
): Promise<ComparisonArtifactPaths> {
  const absoluteOutputDir = resolve(outputDir);
  await mkdir(absoluteOutputDir, { recursive: true });
  const resultsPath = resolve(absoluteOutputDir, "results.json");
  const reportPath = resolve(absoluteOutputDir, "report.md");
  const serializable = {
    generatedAt,
    comparison: {
      openai_model: plan.openaiModel,
      efforts: plan.efforts,
      candidates: plan.candidates,
      pricing: {
        as_of: plan.priceDate,
        openai: {
          input_per_million: plan.inputPricePerMillion,
          output_per_million: plan.outputPricePerMillion,
        },
        anthropic: {
          input_per_million: plan.anthropicInputPricePerMillion,
          output_per_million: plan.anthropicOutputPricePerMillion,
        },
      },
    },
    readings: plan.readings.map((reading) => ({
      id: reading.readingId,
      url: reading.input.url,
      title: reading.input.title,
      content_sha256: reading.contentSha256,
      similar_readings: reading.input.similarReadings,
      production_baseline: {
        reading: reading.productionBaseline,
        usage: reading.productionUsage,
      },
      candidates: observations.filter(
        (observation) => observation.readingId === reading.readingId,
      ),
    })),
  };
  await Promise.all([
    writeFile(resultsPath, JSON.stringify(serializable, null, 2) + "\n", "utf8"),
    writeFile(
      reportPath,
      buildComparisonReport(plan, observations, generatedAt),
      "utf8",
    ),
  ]);
  return { resultsPath, reportPath };
}

export function buildComparisonReport(
  plan: ComparisonPlan,
  observations: ComparisonObservation[],
  generatedAt: string,
): string {
  const metricRows = [
    ...plan.readings.flatMap((reading) => {
      const productionRow = productionMetricRow(reading);
      const candidateRows = observations
        .filter((item) => item.readingId === reading.readingId)
        .map(
          (item) =>
            `| ${reading.readingId} | ${observationLabel(item)} | ${item.latencyMs} | ${item.usage.input_tokens} | ${item.usage.output_tokens} | ${extraTokenCell(item.usage)} | $${item.estimatedCostUsd.toFixed(6)} |`,
        );
      return [productionRow, ...candidateRows];
    }),
  ];
  const readingSections = plan.readings.flatMap((reading) => {
    const related =
      reading.input.similarReadings.length === 0
        ? "None"
        : reading.input.similarReadings
            .map(
              (item) =>
                `- \`${item.id}\`${item.title ? ` — ${item.title}` : ""}`,
            )
            .join("\n");
    const sections = [
      readingSection("Production baseline", reading.productionBaseline),
      ...observations
        .filter((item) => item.readingId === reading.readingId)
        .map((item) => readingSection(observationLabel(item), item.reading)),
    ];
    return [
      `## ${reading.input.title ?? reading.readingId}`,
      "",
      `- Reading: [${reading.input.title ?? reading.readingId}](${reading.input.url})`,
      `- Reading id: \`${reading.readingId}\``,
      `- Content SHA-256: \`${reading.contentSha256}\``,
      "",
      "### Frozen similarity context",
      "",
      related,
      "",
      ...sections,
    ];
  });
  return `# Summarizer comparison

- Generated: ${generatedAt}
- OpenAI model: \`${plan.openaiModel}\`
- OpenAI efforts: ${plan.efforts.join(", ")}
- Anthropic: ${
    plan.candidates.some((candidate) => candidate.provider === "anthropic")
      ? `\`${candidateLabel(plan.candidates.find((candidate) => candidate.provider === "anthropic")!)}\``
      : "omitted"
  }
- Pricing: OpenAI $${plan.inputPricePerMillion}/M input, $${plan.outputPricePerMillion}/M output; Anthropic $${plan.anthropicInputPricePerMillion}/M input, $${plan.anthropicOutputPricePerMillion}/M output (as of ${plan.priceDate})

All local candidates used the captured article and frozen similarity context for that reading. The context below is reconstructed from the production baseline's selected connections; it may not contain every original top-K candidate seen during production ingestion.

## Metrics

| Reading | Candidate | Latency ms | Input tokens | Output tokens | Reasoning / cache | Estimated cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
${metricRows.join("\n")}

${readingSections.join("\n\n")}
`;
}

export async function runCompareSummaryEffort(
  argv: string[],
  deps: CompareCliDeps,
): Promise<CompareRunResult> {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const args = parseComparisonArgs(argv);
  if (!deps.credentials.READER_API_TOKEN) throw new Error("missing READER_API_TOKEN");
  const plan = await prepareComparison(args, {
    fetch: deps.fetch,
    readerToken: deps.credentials.READER_API_TOKEN,
  });
  write(formatComparisonPlan(plan, args.execute));
  if (!args.execute) {
    write("No provider calls made. After explicit spend approval, pass --execute.\n");
    return { mode: "plan", plan };
  }

  const hasOpenAI = plan.candidates.some((candidate) => candidate.provider === "openai");
  const hasAnthropic = plan.candidates.some(
    (candidate) => candidate.provider === "anthropic",
  );
  if (hasOpenAI && !deps.credentials.OPENAI_API_KEY) {
    throw new Error("missing OPENAI_API_KEY");
  }
  if (hasAnthropic && !deps.credentials.ANTHROPIC_API_KEY) {
    throw new Error("missing ANTHROPIC_API_KEY");
  }

  const generatedAt = new Date(deps.now()).toISOString();
  const outputDir =
    args.outputDir ?? defaultOutputDir(plan, generatedAt);
  write(`  candidate checkpoints: ${resolve(outputDir)}\n`);
  const summarize =
    deps.summarize ??
    ((input, candidate) =>
      summarizeReading(
        input,
        summarizerDepsForCandidate(candidate, {
          fetch: deps.fetch,
          openaiApiKey: deps.credentials.OPENAI_API_KEY ?? "",
          anthropicApiKey: deps.credentials.ANTHROPIC_API_KEY,
        }),
      ));
  const { observations, paths } = await runCheckpointedComparison(
    plan,
    outputDir,
    generatedAt,
    {
      now: deps.now,
      summarize,
      onProgress: (observation) => {
        writeErr(
          `${observation.readingId} ${observationLabel(observation)}: ok (${observation.latencyMs} ms, ` +
            `$${observation.estimatedCostUsd.toFixed(6)})\n`,
        );
      },
    },
  );
  const totalCost = observations.reduce(
    (sum, observation) => sum + observation.estimatedCostUsd,
    0,
  );
  write(
    `Wrote ${observations.length} candidates to ${resolve(outputDir)}\n` +
      `  report: ${paths.reportPath}\n` +
      `  results: ${paths.resultsPath}\n` +
      `  estimated total: $${totalCost.toFixed(6)}\n`,
  );
  return { mode: "execute", plan, observations, paths, outputDir };
}

function uniqueTargets(targets: string[]): string[] {
  return [...new Set(targets)];
}

function resolveOpenAIModel(
  override: string | undefined,
  readings: FrozenReading[],
): string {
  if (override) return override;
  const models = [
    ...new Set(
      readings
        .map((reading) => reading.productionUsage)
        .filter(
          (usage): usage is Extract<SummarizationUsage, { provider: "openai" }> =>
            usage?.provider === "openai",
        )
        .map((usage) => usage.model),
    ),
  ];
  return models.length === 1 ? models[0]! : DEFAULT_OPENAI_SUMMARIZATION_MODEL;
}

function estimateInputTokens(reading: FrozenReading): number {
  return reading.productionUsage?.provider === "openai"
    ? reading.productionUsage.input_tokens
    : Math.ceil(reading.input.extractedText.length / 3);
}

async function freezeReading(
  target: string,
  baseUrl: string,
  deps: PrepareComparisonDeps,
): Promise<FrozenReading> {
  const readingId = target.startsWith("rd_")
    ? target
    : await lookupReadingId(target, baseUrl, deps);
  const manifest = ManifestSchema.parse(
    await getJson(`${baseUrl}/api/readings/${encodeURIComponent(readingId)}`, deps),
  );
  if (manifest.status !== "ready" || manifest.content_status !== "captured") {
    throw new Error(
      `reading ${readingId} must be ready with captured content (got ${manifest.status}/${manifest.content_status})`,
    );
  }

  const extractedText = await getText(
    `${baseUrl}/api/readings/${encodeURIComponent(readingId)}/content`,
    deps,
  );
  const rawContent = await getBytes(
    `${baseUrl}/api/readings/${encodeURIComponent(readingId)}/content/raw`,
    deps,
  );
  const actualSha = createHash("sha256").update(rawContent).digest("hex");
  if (actualSha !== manifest.content_sha256) {
    throw new Error(
      `content hash mismatch for ${readingId}: manifest=${manifest.content_sha256} downloaded=${actualSha}`,
    );
  }

  const productionBaseline = ReadingSummarySchema.parse({
    title: manifest.title,
    tldr: manifest.tldr,
    tags: manifest.tags,
    keywords: manifest.keywords,
    people: manifest.people,
    orgs: manifest.orgs,
    novelty_verdict: manifest.novelty_verdict,
    connections: manifest.connections,
    summary_markdown: manifest.summary_markdown,
  });
  const similarReadings = await Promise.all(
    productionBaseline.connections.map(async (connection) => {
      const related = ManifestSchema.parse(
        await getJson(
          `${baseUrl}/api/readings/${encodeURIComponent(connection.id)}`,
          deps,
        ),
      );
      return {
        id: related.id,
        url: related.url,
        ...(related.title ? { title: related.title } : {}),
        ...(related.tldr ? { tldr: related.tldr } : {}),
      };
    }),
  );
  const productionUsage =
    manifest.usage && "summarization" in manifest.usage
      ? manifest.usage.summarization
      : undefined;

  return {
    readingId,
    contentSha256: manifest.content_sha256,
    input: {
      url: manifest.url,
      ...(manifest.title ? { title: manifest.title } : {}),
      extractedText,
      similarReadings,
    },
    productionBaseline,
    ...(productionUsage ? { productionUsage } : {}),
  };
}

function defaultOutputDir(plan: ComparisonPlan, generatedAt: string): string {
  const stamp = generatedAt.replace(/[:.]/g, "-");
  if (plan.readings.length === 1) {
    return `.summarizer-comparisons/${plan.readings[0]!.readingId}/${stamp}`;
  }
  return `.summarizer-comparisons/${stamp}`;
}

function observationLabel(item: {
  provider: ComparisonCandidate["provider"];
  model: string;
  reasoningEffort?: OpenAIReasoningEffort;
  anthropicEffort?: AnthropicEffort;
}): string {
  if (item.provider === "openai") {
    return `${item.provider}/${item.model}/${item.reasoningEffort ?? "n/a"}`;
  }
  return `${item.provider}/${item.model}/${item.anthropicEffort ?? "none"}`;
}

function extraTokenCell(usage: SummarizationUsage): string {
  if (usage.provider === "openai") {
    return String(usage.reasoning_tokens);
  }
  return `cache r${usage.cache_read_input_tokens}/w${usage.cache_creation_input_tokens}`;
}

function productionMetricRow(reading: FrozenReading): string {
  const usage = reading.productionUsage;
  if (!usage) {
    return `| ${reading.readingId} | Production baseline | n/a | n/a | n/a | n/a | n/a |`;
  }
  return `| ${reading.readingId} | Production baseline | n/a | ${usage.input_tokens} | ${usage.output_tokens} | ${extraTokenCell(usage)} | n/a |`;
}

function readingSection(label: string, reading: ReadingSummary): string {
  const connections =
    reading.connections.length === 0
      ? "None"
      : reading.connections
          .map((item) => `- \`${item.id}\`: ${item.reason}`)
          .join("\n");
  return `### ${label}

#### TL;DR

${reading.tldr}

#### Summary

${reading.summary_markdown}

#### Structured fields

- Title: ${reading.title}
- Tags: ${reading.tags.join(", ")}
- Keywords: ${reading.keywords.join(", ")}
- People: ${reading.people.join(", ") || "None"}
- Organizations: ${reading.orgs.join(", ") || "None"}
- Novelty: ${reading.novelty_verdict}

#### Connections

${connections}`;
}

function estimateActualCost(
  usage: SummarizationUsage,
  plan: Pick<
    ComparisonPlan,
    | "inputPricePerMillion"
    | "outputPricePerMillion"
    | "anthropicInputPricePerMillion"
    | "anthropicOutputPricePerMillion"
  >,
): number {
  if (usage.provider === "openai") {
    const uncachedInput = Math.max(
      0,
      usage.input_tokens - usage.cached_input_tokens - usage.cache_write_tokens,
    );
    const value =
      (uncachedInput * plan.inputPricePerMillion +
        usage.cached_input_tokens * plan.inputPricePerMillion * 0.1 +
        usage.cache_write_tokens * plan.inputPricePerMillion * 1.25 +
        usage.output_tokens * plan.outputPricePerMillion) /
      1_000_000;
    return Math.round(value * 100_000_000) / 100_000_000;
  }
  const value =
    (usage.input_tokens * plan.anthropicInputPricePerMillion +
      usage.cache_creation_input_tokens * plan.anthropicInputPricePerMillion * 1.25 +
      usage.cache_read_input_tokens * plan.anthropicInputPricePerMillion * 0.1 +
      usage.output_tokens * plan.anthropicOutputPricePerMillion) /
    1_000_000;
  return Math.round(value * 100_000_000) / 100_000_000;
}

async function lookupReadingId(
  target: string,
  baseUrl: string,
  deps: PrepareComparisonDeps,
): Promise<string> {
  const sourceUrl = new URL(target).toString();
  const lookup = new URL("/api/readings/lookup", baseUrl);
  lookup.searchParams.set("url", sourceUrl);
  const value = await getJson(lookup.toString(), deps);
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.length === 0
  ) {
    throw new Error("lookup response did not contain a reading id");
  }
  return value.id;
}

async function getJson(url: string, deps: PrepareComparisonDeps): Promise<unknown> {
  const response = await authorizedGet(url, deps);
  try {
    return await response.json();
  } catch (cause) {
    throw new Error(`invalid JSON from ${url}`, { cause });
  }
}

async function getText(url: string, deps: PrepareComparisonDeps): Promise<string> {
  return (await authorizedGet(url, deps)).text();
}

async function getBytes(
  url: string,
  deps: PrepareComparisonDeps,
): Promise<Uint8Array> {
  return new Uint8Array(await (await authorizedGet(url, deps)).arrayBuffer());
}

async function authorizedGet(
  url: string,
  deps: PrepareComparisonDeps,
): Promise<Response> {
  const response = await deps.fetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${deps.readerToken}` },
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(
      `GET ${url} failed: ${response.status}${detail ? ` ${detail}` : ""}`,
    );
  }
  return response;
}

function loadCredentials(): Record<string, string | undefined> {
  return {
    ...loadDotVars(".dev.vars"),
    ...loadDotVars(".prd.vars"),
    ...process.env,
  };
}

function printUsage(): void {
  process.stdout.write(`Usage: npx tsx .agents/skills/compare-summary-effort/scripts/compare-summary-effort.ts --target <url-or-id> [options]

Reads existing production readings and compares summarizer candidates locally
(OpenAI efforts plus optional Anthropic). Dry-run by default; --execute is
the only paid path. Production is never mutated: GET-only against reading-lite,
no /reprocess, and no manifest/vector/list writes.

  --target <url-or-id>         Canonical source URL or reading id. Repeatable.
  --effort <effort>            OpenAI candidate effort; repeatable.
                               none|low|medium|high|xhigh|max.
                               Default: low, medium, high, xhigh.
  --model <model>              OpenAI model override (default: production
                               OpenAI model, else gpt-5.6-terra).
  --anthropic-model <model>    Anthropic model. Default: ${DEFAULT_ANTHROPIC_MODEL}.
  --anthropic-effort <effort>  Anthropic output_config.effort.
                               low|medium|high|xhigh|max.
                               Default: ${DEFAULT_ANTHROPIC_SUMMARIZATION_REASONING_EFFORT}
                               (pinned; ambient ANTHROPIC_SUMMARIZATION_REASONING_EFFORT
                               cannot change a run).
  --openai-only                OpenAI-only matrix (skip Sonnet).
  --base-url <url>             Reading service. Default: ${DEFAULT_BASE_URL}.
  --output-dir <path>          Artifact directory. Default:
                               .summarizer-comparisons/<id>/<timestamp> (one
                               reading) or .summarizer-comparisons/<timestamp>
                               (N readings).
  --input-price <usd>          OpenAI standard input price per 1M tokens.
                               Default: ${DEFAULT_INPUT_PRICE_PER_MILLION}.
  --output-price <usd>         OpenAI standard output price per 1M tokens.
                               Default: ${DEFAULT_OUTPUT_PRICE_PER_MILLION}.
  --anthropic-input-price <usd> Anthropic input price per 1M tokens.
                               Default: ${DEFAULT_ANTHROPIC_INPUT_PRICE_PER_MILLION}.
  --anthropic-output-price <usd> Anthropic output price per 1M tokens.
                               Default: ${DEFAULT_ANTHROPIC_OUTPUT_PRICE_PER_MILLION}.
  --price-date <date>          Pricing provenance date. Default: ${DEFAULT_PRICE_DATE}.
  --execute                    Make paid provider calls and write artifacts.
  --help                       Show this help.

Credentials resolve from process env, .prd.vars, then .dev.vars. The runner
uses GET requests only against reading-lite and sends each frozen input through
the production summarizeReading() module (OpenAI store:false; Anthropic tool
use). Production OpenAI stays gpt-5.6-terra; this runner does not change
Worker config.
`);
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }
  await runCompareSummaryEffort(argv, {
    fetch: globalThis.fetch,
    now: () => Date.now(),
    credentials: loadCredentials(),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
