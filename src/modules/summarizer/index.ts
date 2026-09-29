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
import {
  ANTHROPIC_EFFORTS_BY_MODEL,
  CLAUDE_SONNET_5_5,
} from "./anthropic-models";

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
export const DEFAULT_ANTHROPIC_MODEL = CLAUDE_SONNET_5_5;
export const DEFAULT_ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "low";
export { anthropicMessagesControls } from "./anthropic-models";
const OPENAI_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly OpenAIReasoningEffort[];

export interface SummarizerDeps {
  fetch: typeof fetch;
  provider?: string;
  openaiApiKey?: string;
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
  tenantProviderKeys?: boolean;
  provider?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  openaiReasoningEffort?: string;
  anthropicReasoningEffort?: string;
  anthropicModel?: string;
}): void {
  if (config.tenantProviderKeys) {
    parseReasoningEffort(config.openaiReasoningEffort);
    return;
  }
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
  if (deps.openaiApiKey !== undefined && !deps.openaiApiKey) {
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
