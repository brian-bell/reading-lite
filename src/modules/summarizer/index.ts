import type { ReadingSummary } from "../../schemas/reading-summary";
import type { SummarizationUsage } from "../../schemas/manifest";
import { summarizeReading as summarizeWithAnthropic } from "../anthropic";
import {
  summarizeReading as summarizeWithOpenAI,
} from "../openai-summarizer";
import type { RetryDeps } from "../http-retry";
import type {
  AnthropicReasoningEffort,
  OpenAIReasoningEffort,
  SummarizeReadingInput,
} from "./types";
import {
  parseSummarizerProvider,
  SummarizerConfigError,
} from "./config";

export {
  ReadingSummarySchema,
  type ReadingSummary,
} from "../../schemas/reading-summary";
export type { SummarizationUsage } from "../../schemas/manifest";
export type {
  AnthropicReasoningEffort,
  OpenAIReasoningEffort,
  SimilarContext,
  SummarizeReadingInput,
} from "./types";
export {
  parseSummarizerProvider,
  SummarizerConfigError,
  type SummarizerProvider,
} from "./config";

export const DEFAULT_OPENAI_SUMMARIZATION_MODEL = "gpt-5.6-terra";
export const DEFAULT_OPENAI_SUMMARIZATION_REASONING_EFFORT = "low";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
export const DEFAULT_ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "low";
const OPENAI_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly OpenAIReasoningEffort[];

// Intersection of official effort availability and thinking-disabled
// compatibility. buildSummarizeRequestBody always sends
// thinking: { type: "disabled" }.
// https://platform.claude.com/docs/en/build-with-claude/effort
// https://platform.claude.com/docs/en/build-with-claude/thinking
// Fable 5, Mythos 5, and Mythos Preview reject disabled thinking (omitted).
// Opus 5 accepts disabled thinking only at high or below; xhigh|max 400.
// Unknown models fail closed.
const ANTHROPIC_EFFORT_LOW_MEDIUM_HIGH = [
  "low",
  "medium",
  "high",
] as const satisfies readonly AnthropicReasoningEffort[];
const ANTHROPIC_EFFORT_WITH_MAX = [
  "low",
  "medium",
  "high",
  "max",
] as const satisfies readonly AnthropicReasoningEffort[];
const ANTHROPIC_EFFORT_ALL = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly AnthropicReasoningEffort[];

const ANTHROPIC_EFFORTS_BY_MODEL: Record<
  string,
  readonly AnthropicReasoningEffort[]
> = {
  "claude-sonnet-5": ANTHROPIC_EFFORT_ALL,
  // Disabled thinking is accepted only at high or below.
  "claude-opus-5": ANTHROPIC_EFFORT_LOW_MEDIUM_HIGH,
  "claude-opus-4-8": ANTHROPIC_EFFORT_ALL,
  "claude-opus-4-7": ANTHROPIC_EFFORT_ALL,
  "claude-sonnet-4-6": ANTHROPIC_EFFORT_WITH_MAX,
  "claude-opus-4-6": ANTHROPIC_EFFORT_WITH_MAX,
  "claude-opus-4-5-20251101": ANTHROPIC_EFFORT_LOW_MEDIUM_HIGH,
};

export interface SummarizerDeps {
  fetch: typeof fetch;
  provider?: string;
  openaiApiKey: string;
  openaiModel?: string;
  openaiReasoningEffort?: string;
  anthropicApiKey?: string;
  anthropicModel: string;
  anthropicReasoningEffort?: string;
  retry?: RetryDeps;
}

export interface SummarizeReadingResult {
  reading: ReadingSummary;
  usage: SummarizationUsage;
}

export function validateProcessingCredentials(config: {
  provider?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  openaiReasoningEffort?: string;
  anthropicReasoningEffort?: string;
  anthropicModel?: string;
}): void {
  const provider = parseSummarizerProvider(config.provider);
  if (!config.openaiApiKey) {
    throw new SummarizerConfigError(
      "missing OPENAI_API_KEY; it is required for embeddings under every summarizer provider",
    );
  }
  if (provider === "anthropic" && !config.anthropicApiKey) {
    throw new SummarizerConfigError(
      "missing ANTHROPIC_API_KEY for SUMMARIZER_PROVIDER=anthropic",
    );
  }
  if (provider === "openai") {
    parseReasoningEffort(config.openaiReasoningEffort);
  }
  if (provider === "anthropic") {
    parseAnthropicEffort(config.anthropicReasoningEffort, config.anthropicModel);
  }
}

export async function summarizeReading(
  input: SummarizeReadingInput,
  deps: SummarizerDeps,
): Promise<SummarizeReadingResult> {
  const provider = parseSummarizerProvider(deps.provider);
  if (provider === "anthropic") {
    if (!deps.anthropicApiKey) {
      throw new SummarizerConfigError(
        "missing ANTHROPIC_API_KEY for SUMMARIZER_PROVIDER=anthropic",
      );
    }
    const effort = parseAnthropicEffort(
      deps.anthropicReasoningEffort,
      deps.anthropicModel,
    );
    const result = await summarizeWithAnthropic(input, {
      fetch: deps.fetch,
      apiKey: deps.anthropicApiKey,
      model: deps.anthropicModel,
      effort,
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
  if (!deps.openaiApiKey) {
    throw new SummarizerConfigError(
      "missing OPENAI_API_KEY for SUMMARIZER_PROVIDER=openai",
    );
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

export function parseReasoningEffort(value: string | undefined): OpenAIReasoningEffort {
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

export function parseAnthropicEffort(
  value: string | undefined,
  model: string | undefined,
): AnthropicReasoningEffort {
  const resolvedModel = model ?? "";
  const allowed = ANTHROPIC_EFFORTS_BY_MODEL[resolvedModel];
  if (!allowed) {
    throw new SummarizerConfigError(
      `unsupported ANTHROPIC_MODEL for effort: ${resolvedModel || "(missing)"}`,
    );
  }
  const effort = value ?? DEFAULT_ANTHROPIC_SUMMARIZATION_REASONING_EFFORT;
  if (allowed.includes(effort as AnthropicReasoningEffort)) {
    return effort as AnthropicReasoningEffort;
  }
  throw new SummarizerConfigError(
    `invalid ANTHROPIC_SUMMARIZATION_REASONING_EFFORT: ${effort}`,
  );
}
