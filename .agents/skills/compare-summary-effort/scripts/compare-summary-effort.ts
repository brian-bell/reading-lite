#!/usr/bin/env -S npx tsx
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  DEFAULT_OPENAI_SUMMARIZATION_MODEL,
  parseReasoningEffort,
  summarizeReading,
  type OpenAIReasoningEffort,
  type SummarizeReadingResult,
  type SummarizeReadingInput,
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
const DEFAULT_PRICE_DATE = "2026-07-30";
const MAX_OUTPUT_TOKENS = 8192;

export interface ComparisonArgs {
  target: string;
  baseUrl: string;
  execute: boolean;
  efforts: OpenAIReasoningEffort[];
  outputDir?: string;
  model?: string;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  priceDate: string;
}

export interface ComparisonPlan {
  readingId: string;
  contentSha256: string;
  model: string;
  efforts: OpenAIReasoningEffort[];
  input: SummarizeReadingInput;
  productionBaseline: ReadingSummary;
  productionUsage?: SummarizationUsage;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  priceDate: string;
  estimatedMaximumCostUsd: number;
}

export interface PrepareComparisonDeps {
  fetch: typeof fetch;
  readerToken: string;
}

export interface ComparisonCandidate {
  model: string;
  reasoningEffort: OpenAIReasoningEffort;
}

export interface RunComparisonDeps {
  summarize(
    input: SummarizeReadingInput,
    candidate: ComparisonCandidate,
  ): Promise<SummarizeReadingResult>;
  now(): number;
  onProgress?(observation: ComparisonObservation): void | Promise<void>;
}

type OpenAIUsage = Extract<SummarizationUsage, { provider: "openai" }>;

export interface ComparisonObservation {
  effort: OpenAIReasoningEffort;
  latencyMs: number;
  reading: ReadingSummary;
  usage: OpenAIUsage;
  estimatedCostUsd: number;
}

export interface ComparisonArtifactPaths {
  resultsPath: string;
  reportPath: string;
}

export function parseComparisonArgs(argv: string[]): ComparisonArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: "string" },
      "base-url": { type: "string", default: DEFAULT_BASE_URL },
      execute: { type: "boolean", default: false },
      effort: { type: "string", multiple: true, default: [] },
      "output-dir": { type: "string" },
      model: { type: "string" },
      "input-price": {
        type: "string",
        default: String(DEFAULT_INPUT_PRICE_PER_MILLION),
      },
      "output-price": {
        type: "string",
        default: String(DEFAULT_OUTPUT_PRICE_PER_MILLION),
      },
      "price-date": { type: "string", default: DEFAULT_PRICE_DATE },
    },
    strict: true,
  });
  if (!values.target) throw new Error("--target is required");
  const efforts =
    values.effort!.length === 0
      ? [...DEFAULT_EFFORTS]
      : [...new Set(values.effort!.map(parseReasoningEffort))];
  const inputPricePerMillion = Number(values["input-price"]);
  const outputPricePerMillion = Number(values["output-price"]);
  if (!Number.isFinite(inputPricePerMillion) || inputPricePerMillion < 0) {
    throw new Error("--input-price must be a non-negative number");
  }
  if (!Number.isFinite(outputPricePerMillion) || outputPricePerMillion < 0) {
    throw new Error("--output-price must be a non-negative number");
  }
  return {
    target: values.target,
    baseUrl: values["base-url"]!.replace(/\/$/, ""),
    execute: values.execute!,
    efforts,
    outputDir: values["output-dir"],
    model: values.model,
    inputPricePerMillion,
    outputPricePerMillion,
    priceDate: values["price-date"]!,
  };
}

export async function prepareComparison(
  args: ComparisonArgs,
  deps: PrepareComparisonDeps,
): Promise<ComparisonPlan> {
  const readingId = args.target.startsWith("rd_")
    ? args.target
    : await lookupReadingId(args.target, args.baseUrl, deps);
  const manifest = ManifestSchema.parse(
    await getJson(`${args.baseUrl}/api/readings/${encodeURIComponent(readingId)}`, deps),
  );
  if (manifest.status !== "ready" || manifest.content_status !== "captured") {
    throw new Error(
      `reading ${readingId} must be ready with captured content (got ${manifest.status}/${manifest.content_status})`,
    );
  }

  const extractedText = await getText(
    `${args.baseUrl}/api/readings/${encodeURIComponent(readingId)}/content`,
    deps,
  );
  const rawContent = await getBytes(
    `${args.baseUrl}/api/readings/${encodeURIComponent(readingId)}/content/raw`,
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
          `${args.baseUrl}/api/readings/${encodeURIComponent(connection.id)}`,
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
  const model =
    args.model ??
    (productionUsage?.provider === "openai"
      ? productionUsage.model
      : DEFAULT_OPENAI_SUMMARIZATION_MODEL);
  const estimatedInputTokens =
    productionUsage?.provider === "openai"
      ? productionUsage.input_tokens
      : Math.ceil(extractedText.length / 3);
  const maximumCostPerCall =
    (estimatedInputTokens * args.inputPricePerMillion +
      MAX_OUTPUT_TOKENS * args.outputPricePerMillion) /
    1_000_000;

  return {
    readingId,
    contentSha256: manifest.content_sha256,
    model,
    efforts: args.efforts,
    input: {
      url: manifest.url,
      ...(manifest.title ? { title: manifest.title } : {}),
      extractedText,
      similarReadings,
    },
    productionBaseline,
    ...(productionUsage ? { productionUsage } : {}),
    inputPricePerMillion: args.inputPricePerMillion,
    outputPricePerMillion: args.outputPricePerMillion,
    priceDate: args.priceDate,
    estimatedMaximumCostUsd: maximumCostPerCall * args.efforts.length,
  };
}

export async function runComparison(
  plan: ComparisonPlan,
  deps: RunComparisonDeps,
): Promise<ComparisonObservation[]> {
  const observations: ComparisonObservation[] = [];
  for (const effort of plan.efforts) {
    const startedAt = deps.now();
    const result = await deps.summarize(plan.input, {
      model: plan.model,
      reasoningEffort: effort,
    });
    const latencyMs = deps.now() - startedAt;
    if (result.usage.provider !== "openai") {
      throw new Error(
        `comparison candidate ${effort} returned ${result.usage.provider} usage`,
      );
    }
    const observation = {
      effort,
      latencyMs,
      reading: result.reading,
      usage: result.usage,
      estimatedCostUsd: estimateActualCost(
        result.usage,
        plan.inputPricePerMillion,
        plan.outputPricePerMillion,
      ),
    };
    observations.push(observation);
    await deps.onProgress?.(observation);
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
    reading: {
      id: plan.readingId,
      url: plan.input.url,
      title: plan.input.title,
      content_sha256: plan.contentSha256,
    },
    comparison: {
      model: plan.model,
      efforts: plan.efforts,
      similar_readings: plan.input.similarReadings,
      pricing: {
        as_of: plan.priceDate,
        input_per_million: plan.inputPricePerMillion,
        output_per_million: plan.outputPricePerMillion,
      },
    },
    production_baseline: {
      reading: plan.productionBaseline,
      usage: plan.productionUsage,
    },
    candidates: observations,
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
  const productionUsage =
    plan.productionUsage?.provider === "openai"
      ? plan.productionUsage
      : undefined;
  const productionRow = productionUsage
    ? `| Production baseline | n/a | ${productionUsage.input_tokens} | ${productionUsage.output_tokens} | ${productionUsage.reasoning_tokens} | n/a |`
    : "| Production baseline | n/a | n/a | n/a | n/a | n/a |";
  const candidateRows = observations.map(
    (item) =>
      `| ${item.effort} | ${item.latencyMs} | ${item.usage.input_tokens} | ${item.usage.output_tokens} | ${item.usage.reasoning_tokens} | $${item.estimatedCostUsd.toFixed(6)} |`,
  );
  const contexts =
    plan.input.similarReadings.length === 0
      ? "None"
      : plan.input.similarReadings
          .map(
            (item) =>
              `- \`${item.id}\`${item.title ? ` — ${item.title}` : ""}`,
          )
          .join("\n");
  const sections = [
    readingSection("Production baseline", plan.productionBaseline),
    ...observations.map((item) =>
      readingSection(`${item.effort} effort`, item.reading),
    ),
  ];
  return `# Summary effort comparison

- Reading: [${plan.input.title ?? plan.readingId}](${plan.input.url})
- Reading id: \`${plan.readingId}\`
- Content SHA-256: \`${plan.contentSha256}\`
- Model: \`${plan.model}\`
- Generated: ${generatedAt}
- Pricing: $${plan.inputPricePerMillion}/M input, $${plan.outputPricePerMillion}/M output (as of ${plan.priceDate})

All local candidates used the exact same captured article and frozen similarity context. The context below is reconstructed from the production baseline's selected connections; it may not contain every original top-K candidate seen during production ingestion.

## Frozen similarity context

${contexts}

## Metrics

| Candidate | Latency ms | Input tokens | Output tokens | Reasoning tokens | Estimated cost |
| --- | ---: | ---: | ---: | ---: | ---: |
${[productionRow, ...candidateRows].join("\n")}

${sections.join("\n\n")}
`;
}

function readingSection(label: string, reading: ReadingSummary): string {
  const connections =
    reading.connections.length === 0
      ? "None"
      : reading.connections
          .map((item) => `- \`${item.id}\`: ${item.reason}`)
          .join("\n");
  return `## ${label}

### TL;DR

${reading.tldr}

### Summary

${reading.summary_markdown}

### Structured fields

- Title: ${reading.title}
- Tags: ${reading.tags.join(", ")}
- Keywords: ${reading.keywords.join(", ")}
- People: ${reading.people.join(", ") || "None"}
- Organizations: ${reading.orgs.join(", ") || "None"}
- Novelty: ${reading.novelty_verdict}

### Connections

${connections}`;
}

function estimateActualCost(
  usage: OpenAIUsage,
  inputPricePerMillion: number,
  outputPricePerMillion: number,
): number {
  const uncachedInput = Math.max(
    0,
    usage.input_tokens - usage.cached_input_tokens - usage.cache_write_tokens,
  );
  const value =
    (uncachedInput * inputPricePerMillion +
      usage.cached_input_tokens * inputPricePerMillion * 0.1 +
      usage.cache_write_tokens * inputPricePerMillion * 1.25 +
      usage.output_tokens * outputPricePerMillion) /
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

Reads an existing production reading and compares OpenAI summarization efforts
locally. Dry-run by default; --execute makes paid OpenAI calls. Production is
never mutated.

  --target <url-or-id>       Canonical source URL or reading id (required).
  --effort <effort>          Candidate effort; repeatable. Default: low,
                             medium, high, xhigh.
  --model <model>            Override the production manifest's OpenAI model.
  --base-url <url>           Reading service. Default: ${DEFAULT_BASE_URL}.
  --output-dir <path>        Artifact directory. Default:
                             .summarizer-comparisons/<id>/<timestamp>.
  --input-price <usd>        Standard input price per 1M tokens.
                             Default: ${DEFAULT_INPUT_PRICE_PER_MILLION}.
  --output-price <usd>       Standard output price per 1M tokens.
                             Default: ${DEFAULT_OUTPUT_PRICE_PER_MILLION}.
  --price-date <date>        Pricing provenance date. Default: ${DEFAULT_PRICE_DATE}.
  --execute                  Make paid OpenAI calls and write artifacts.
  --help                     Show this help.

Credentials resolve from process env, .prd.vars, then .dev.vars. The runner
uses GET requests only against reading-lite and sends the frozen input directly
to OpenAI with store:false through the production summarizer module.
`);
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }
  const args = parseComparisonArgs(argv);
  const vars = loadCredentials();
  if (!vars.READER_API_TOKEN) throw new Error("missing READER_API_TOKEN");
  const plan = await prepareComparison(args, {
    fetch: globalThis.fetch,
    readerToken: vars.READER_API_TOKEN,
  });
  process.stdout.write(
    `${args.execute ? "[EXECUTE]" : "[DRY RUN]"} ${plan.readingId}\n` +
      `  source: ${plan.input.url}\n` +
      `  model: ${plan.model}\n` +
      `  efforts: ${plan.efforts.join(", ")}\n` +
      `  frozen similar readings: ${plan.input.similarReadings.length}\n` +
      `  conservative maximum: $${plan.estimatedMaximumCostUsd.toFixed(4)} ` +
      `(pricing as of ${plan.priceDate})\n`,
  );
  if (!args.execute) {
    process.stdout.write(
      "No OpenAI calls made. After explicit spend approval, pass --execute.\n",
    );
    return;
  }
  if (!vars.OPENAI_API_KEY) throw new Error("missing OPENAI_API_KEY");

  const generatedAt = new Date().toISOString();
  const outputDir =
    args.outputDir ??
    `.summarizer-comparisons/${plan.readingId}/${generatedAt.replace(/[:.]/g, "-")}`;
  process.stdout.write(`  candidate checkpoints: ${resolve(outputDir)}\n`);
  const { observations, paths } = await runCheckpointedComparison(
    plan,
    outputDir,
    generatedAt,
    {
      now: () => Date.now(),
      summarize: (input, candidate) =>
        summarizeReading(input, {
          fetch: globalThis.fetch,
          provider: "openai",
          openaiApiKey: vars.OPENAI_API_KEY!,
          openaiModel: candidate.model,
          openaiReasoningEffort: candidate.reasoningEffort,
          anthropicApiKey: vars.ANTHROPIC_API_KEY,
          anthropicModel: vars.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
        }),
      onProgress: (observation) => {
        process.stderr.write(
          `${observation.effort}: ok (${observation.latencyMs} ms, ` +
            `$${observation.estimatedCostUsd.toFixed(6)})\n`,
        );
      },
    },
  );
  const totalCost = observations.reduce(
    (sum, observation) => sum + observation.estimatedCostUsd,
    0,
  );
  process.stdout.write(
    `Wrote ${observations.length} candidates to ${resolve(outputDir)}\n` +
      `  report: ${paths.reportPath}\n` +
      `  results: ${paths.resultsPath}\n` +
      `  estimated total: $${totalCost.toFixed(6)}\n`,
  );
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
