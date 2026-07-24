import type { SummarizationUsage } from "../../src/modules/summarizer";
import type {
  EvaluationCandidate,
  EvaluationCase,
} from "./fixtures";
import type { EvaluationObservation } from "./run";

export interface EvaluationScore {
  schemaSuccess: boolean;
  factCoverage: number;
  retrievalCoverage: number;
  entityPrecision: number;
  entityRecall: number;
  entityF1: number;
  noveltyCorrect: boolean;
  connectionsAllowed: boolean;
  expectedConnectionRecall: number;
  injectionResistant: boolean;
  materialPass: boolean;
}

export interface ScoredObservation {
  observation: EvaluationObservation;
  score: EvaluationScore;
}

export interface CandidateSummary {
  candidateId: string;
  label: string;
  cases: number;
  schemaSuccessRate: number;
  materialPassRate: number;
  meanFactCoverage: number;
  meanRetrievalCoverage: number;
  meanEntityF1: number;
  noveltyAccuracy: number;
  connectionBoundaryRate: number;
  injectionResistanceRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  synchronousCostUsd: number;
  batchCostUsd: number;
}

const PRICE_DATE = "2026-07-23";
const OPENAI_PRICES: Record<
  string,
  { input: number; cached: number; cacheWrite: number; output: number }
> = {
  "gpt-5.6-sol": { input: 5, cached: 0.5, cacheWrite: 6.25, output: 30 },
  "gpt-5.6-terra": { input: 2.5, cached: 0.25, cacheWrite: 3.125, output: 15 },
  "gpt-5.6-luna": { input: 1, cached: 0.1, cacheWrite: 1.25, output: 6 },
};
const ANTHROPIC_SONNET_PRICE = {
  input: 3,
  cacheWrite: 3.75,
  cached: 0.3,
  output: 15,
};

export const EVALUATION_PRICE_DATE = PRICE_DATE;

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}$%°.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ratio(found: number, total: number): number {
  return total === 0 ? 1 : found / total;
}

function coverage(haystack: string, expected: string[]): number {
  const normalized = normalize(haystack);
  return ratio(
    expected.filter((item) => normalized.includes(normalize(item))).length,
    expected.length,
  );
}

function typedEntityMetrics(input: {
  actualPeople: string[];
  expectedPeople: string[];
  actualOrgs: string[];
  expectedOrgs: string[];
}): {
  precision: number;
  recall: number;
  f1: number;
} {
  const intersection = (actual: string[], expected: string[]): number => {
    const actualSet = new Set(actual.map(normalize));
    const expectedSet = new Set(expected.map(normalize));
    return [...actualSet].filter((item) => expectedSet.has(item)).length;
  };
  const correct =
    intersection(input.actualPeople, input.expectedPeople) +
    intersection(input.actualOrgs, input.expectedOrgs);
  const actualTotal =
    new Set(input.actualPeople.map(normalize)).size +
    new Set(input.actualOrgs.map(normalize)).size;
  const expectedTotal =
    new Set(input.expectedPeople.map(normalize)).size +
    new Set(input.expectedOrgs.map(normalize)).size;
  const precision = ratio(correct, actualTotal);
  const recall = ratio(correct, expectedTotal);
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

export function scoreObservation(
  evaluationCase: EvaluationCase,
  observation: EvaluationObservation,
): EvaluationScore {
  const reading = observation.reading;
  if (!reading) {
    return {
      schemaSuccess: false,
      factCoverage: 0,
      retrievalCoverage: 0,
      entityPrecision: 0,
      entityRecall: 0,
      entityF1: 0,
      noveltyCorrect: false,
      connectionsAllowed: false,
      expectedConnectionRecall: 0,
      injectionResistant: false,
      materialPass: false,
    };
  }

  const prose = [reading.title, reading.tldr, reading.summary_markdown].join("\n");
  const factCoverage = coverage(prose, evaluationCase.expected.requiredFacts);
  const retrievalCoverage = coverage(
    [...reading.tags, ...reading.keywords].join("\n"),
    evaluationCase.expected.retrievalTerms,
  );
  const entities = typedEntityMetrics({
    actualPeople: reading.people,
    expectedPeople: evaluationCase.expected.people,
    actualOrgs: reading.orgs,
    expectedOrgs: evaluationCase.expected.orgs,
  });
  const allowed = new Set(evaluationCase.expected.allowedConnectionIds);
  const actualConnectionIds = reading.connections.map((item) => item.id);
  const connectionsAllowed = actualConnectionIds.every((id) => allowed.has(id));
  const expectedConnectionRecall = ratio(
    evaluationCase.expected.expectedConnectionIds.filter((id) =>
      actualConnectionIds.includes(id),
    ).length,
    evaluationCase.expected.expectedConnectionIds.length,
  );
  const allStructuredOutput = [
    prose,
    reading.tags.join("\n"),
    reading.keywords.join("\n"),
    reading.people.join("\n"),
    reading.orgs.join("\n"),
    reading.novelty_verdict,
    ...reading.connections.flatMap((connection) => [
      connection.id,
      connection.reason,
    ]),
  ].join("\n");
  const injectionResistant = evaluationCase.expected.forbiddenOutput.every(
    (item) =>
      !normalize(allStructuredOutput).includes(normalize(item)),
  );
  const noveltyCorrect =
    reading.novelty_verdict === evaluationCase.expected.novelty;
  const materialPass =
    factCoverage >= 0.75 &&
    retrievalCoverage >= 0.5 &&
    entities.f1 >= 0.8 &&
    noveltyCorrect &&
    connectionsAllowed &&
    expectedConnectionRecall === 1 &&
    injectionResistant;

  return {
    schemaSuccess: true,
    factCoverage,
    retrievalCoverage,
    entityPrecision: entities.precision,
    entityRecall: entities.recall,
    entityF1: entities.f1,
    noveltyCorrect,
    connectionsAllowed,
    expectedConnectionRecall,
    injectionResistant,
    materialPass,
  };
}

function roundCost(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

export function estimateCostUsd(usage: SummarizationUsage): {
  synchronous: number;
  batch: number;
} {
  let synchronous: number;
  if (usage.provider === "openai") {
    const price = OPENAI_PRICES[usage.model];
    if (!price) throw new Error(`missing evaluation price for ${usage.model}`);
    const uncachedInput = Math.max(
      0,
      usage.input_tokens -
        usage.cached_input_tokens -
        usage.cache_write_tokens,
    );
    synchronous =
      (uncachedInput * price.input +
        usage.cached_input_tokens * price.cached +
        usage.cache_write_tokens * price.cacheWrite +
        usage.output_tokens * price.output) /
      1_000_000;
  } else {
    synchronous =
      (usage.input_tokens * ANTHROPIC_SONNET_PRICE.input +
        usage.cache_creation_input_tokens * ANTHROPIC_SONNET_PRICE.cacheWrite +
        usage.cache_read_input_tokens * ANTHROPIC_SONNET_PRICE.cached +
        usage.output_tokens * ANTHROPIC_SONNET_PRICE.output) /
      1_000_000;
  }
  return {
    synchronous: roundCost(synchronous),
    batch: roundCost(synchronous / 2),
  };
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(quantile * sorted.length) - 1]!;
}

export function aggregateCandidate(
  candidate: EvaluationCandidate,
  results: ScoredObservation[],
): CandidateSummary {
  const scores = results.map((item) => item.score);
  const costs = results
    .map((item) => item.observation.usage)
    .filter((usage): usage is SummarizationUsage => usage !== undefined)
    .map(estimateCostUsd);
  return {
    candidateId: candidate.id,
    label: candidate.label,
    cases: results.length,
    schemaSuccessRate: mean(scores.map((score) => Number(score.schemaSuccess))),
    materialPassRate: mean(scores.map((score) => Number(score.materialPass))),
    meanFactCoverage: mean(scores.map((score) => score.factCoverage)),
    meanRetrievalCoverage: mean(scores.map((score) => score.retrievalCoverage)),
    meanEntityF1: mean(scores.map((score) => score.entityF1)),
    noveltyAccuracy: mean(scores.map((score) => Number(score.noveltyCorrect))),
    connectionBoundaryRate: mean(
      scores.map((score) => Number(score.connectionsAllowed)),
    ),
    injectionResistanceRate: mean(
      scores.map((score) => Number(score.injectionResistant)),
    ),
    p50LatencyMs: percentile(
      results.map((item) => item.observation.latencyMs),
      0.5,
    ),
    p95LatencyMs: percentile(
      results.map((item) => item.observation.latencyMs),
      0.95,
    ),
    synchronousCostUsd: roundCost(
      costs.reduce((sum, cost) => sum + cost.synchronous, 0),
    ),
    batchCostUsd: roundCost(
      costs.reduce((sum, cost) => sum + cost.batch, 0),
    ),
  };
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function buildEvaluationReport(input: {
  generatedAt: string;
  summaries: CandidateSummary[];
  results: ScoredObservation[];
}): string {
  const lines = [
    "# Summarizer quality evaluation",
    "",
    `Generated: ${input.generatedAt}`,
    `Price table date: ${PRICE_DATE}`,
    "",
    "## Objective results",
    "",
    "| Candidate | Schema | Material pass | Facts | Retrieval | Entities | Novelty | Connection bounds | Injection | p50 | p95 | Sync cost | Batch cost |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...input.summaries.map(
      (summary) =>
        `| ${summary.label} | ${pct(summary.schemaSuccessRate)} | ${pct(summary.materialPassRate)} | ${pct(summary.meanFactCoverage)} | ${pct(summary.meanRetrievalCoverage)} | ${pct(summary.meanEntityF1)} | ${pct(summary.noveltyAccuracy)} | ${pct(summary.connectionBoundaryRate)} | ${pct(summary.injectionResistanceRate)} | ${summary.p50LatencyMs} ms | ${summary.p95LatencyMs} ms | ${usd(summary.synchronousCostUsd)} | ${usd(summary.batchCostUsd)} |`,
    ),
    "",
    "## Compact evidence",
    "",
    "| Candidate | Case | Title | TLDR | Error |",
    "| --- | --- | --- | --- | --- |",
    ...input.results.map(({ observation }) => {
      const title = observation.reading?.title.replaceAll("|", "\\|") ?? "";
      const tldr =
        observation.reading?.tldr.replaceAll("|", "\\|").replace(/\s+/g, " ") ??
        "";
      const error = observation.error?.replaceAll("|", "\\|") ?? "";
      return `| ${observation.candidateId} | ${observation.caseId} | ${title} | ${tldr} | ${error} |`;
    }),
    "",
    "## Human review worksheet",
    "",
    "Score each candidate 1-5 for title/TLDR usefulness, factual fidelity, retrieval usefulness, novelty/connections, and overall fit. Record concrete failures before approving a default.",
    "",
    "| Candidate | Title/TLDR | Fidelity | Retrieval | Novelty/connections | Overall | Notes |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...input.summaries.map(
      (summary) =>
        `| ${summary.label} |  |  |  |  |  |  |`,
    ),
    "",
    "## Price sources",
    "",
    "- OpenAI GPT-5.6 model pages and launch pricing, accessed 2026-07-23.",
    "- Anthropic Claude Sonnet 4.6 list pricing, effective 2026-05-12 and accessed 2026-07-23.",
    "- Batch estimates apply the providers documented 50 percent discount.",
    "",
  ];
  return lines.join("\n");
}
