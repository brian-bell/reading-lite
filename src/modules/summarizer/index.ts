import type { ReadingSummary } from "../../schemas/reading-summary";
import type { SummarizationUsage } from "../../schemas/manifest";
import { summarizeReading as summarizeWithAnthropic } from "../anthropic";
import {
  summarizeReading as summarizeWithOpenAI,
} from "../openai-summarizer";
import type { RetryDeps } from "../http-retry";
import type {
  OpenAIReasoningEffort,
  SummarizeReadingInput,
} from "./types";

export {
  ReadingSummarySchema,
  type ReadingSummary,
} from "../../schemas/reading-summary";
export type { SummarizationUsage } from "../../schemas/manifest";
export type {
  OpenAIReasoningEffort,
  SimilarContext,
  SummarizeReadingInput,
} from "./types";

export const DEFAULT_OPENAI_SUMMARIZATION_MODEL = "gpt-5.6-terra";
export const DEFAULT_OPENAI_SUMMARIZATION_REASONING_EFFORT = "low";
const OPENAI_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly OpenAIReasoningEffort[];

export class SummarizerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummarizerConfigError";
  }
}

export interface SummarizerDeps {
  fetch: typeof fetch;
  provider?: string;
  openaiApiKey: string;
  openaiModel?: string;
  openaiReasoningEffort?: string;
  anthropicApiKey: string;
  anthropicModel: string;
  retry?: RetryDeps;
}

export interface SummarizeReadingResult {
  reading: ReadingSummary;
  usage: SummarizationUsage;
}

export async function summarizeReading(
  input: SummarizeReadingInput,
  deps: SummarizerDeps,
): Promise<SummarizeReadingResult> {
  const provider = parseProvider(deps.provider);
  if (provider === "anthropic") {
    const result = await summarizeWithAnthropic(input, {
      fetch: deps.fetch,
      apiKey: deps.anthropicApiKey,
      model: deps.anthropicModel,
      retry: deps.retry,
    });
    return {
      reading: result.reading,
      usage: {
        provider: "anthropic",
        model: deps.anthropicModel,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cache_creation_input_tokens:
          result.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
  const model = deps.openaiModel ?? DEFAULT_OPENAI_SUMMARIZATION_MODEL;
  const reasoningEffort = parseReasoningEffort(deps.openaiReasoningEffort);
  const result = await summarizeWithOpenAI(input, {
    fetch: deps.fetch,
    apiKey: deps.openaiApiKey,
    model,
    reasoningEffort,
    retry: deps.retry,
  });
  return {
    reading: result.reading,
    usage: {
      provider: "openai",
      model,
      ...result.usage,
    },
  };
}

function parseProvider(value: string | undefined): "openai" | "anthropic" {
  const provider = value ?? "openai";
  if (provider === "openai" || provider === "anthropic") return provider;
  throw new SummarizerConfigError(`invalid SUMMARIZER_PROVIDER: ${provider}`);
}

function parseReasoningEffort(value: string | undefined): OpenAIReasoningEffort {
  const effort = value ?? DEFAULT_OPENAI_SUMMARIZATION_REASONING_EFFORT;
  if (
    OPENAI_REASONING_EFFORTS.includes(
      effort as (typeof OPENAI_REASONING_EFFORTS)[number],
    )
  ) {
    return effort as OpenAIReasoningEffort;
  }
  throw new SummarizerConfigError(
    `invalid OPENAI_SUMMARIZATION_REASONING_EFFORT: ${effort}`,
  );
}
