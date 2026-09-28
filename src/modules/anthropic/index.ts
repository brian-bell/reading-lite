import {
  ReadingSummarySchema,
  type ReadingSummary,
} from "../../schemas/reading-summary";
import { fetchWithRetry, type RetryDeps } from "../http-retry";
import { providerErrorText } from "../provider-error-text";
import {
  LIBRARIAN_INSTRUCTIONS,
  buildSummarizeUserMessage,
} from "../summarizer/instructions";
import type {
  AnthropicReasoningEffort,
  SummarizeReadingInput,
} from "../summarizer/types";

export type {
  SimilarContext,
  SummarizeReadingInput,
} from "../summarizer/types";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export const EMIT_READING_TOOL_NAME = "emit_reading";
export const REJECT_SOURCE_TOOL_NAME = "reject_source";

export class AnthropicError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "AnthropicError";
  }
}

export class NoToolUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoToolUseError";
  }
}

export class BadToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadToolInputError";
  }
}

export class SourceRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceRejectedError";
  }
}

export interface AnthropicDeps {
  fetch: typeof fetch;
  apiKey: string;
  model: string;
  effort: AnthropicReasoningEffort;
  retry?: RetryDeps;
}

export interface SummarizeReadingResult {
  reading: ReadingSummary;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

const SYSTEM_PROMPT = `${LIBRARIAN_INSTRUCTIONS}

Call exactly one tool. Call emit_reading when the extracted source is a full article or transcript. Call reject_source when it is not. Do not write free-form prose.`;

// Sent with strict tool use, so the API guarantees every call matches it:
// without strict, `required` and `type` are advisory, and production Sonnet 5
// omitted `tags` and sent `keywords` as a string. Strict tool use supports no
// string length bounds, no maxItems, and minItems of 0 or 1 only, so this is
// READING_SUMMARY_JSON_SCHEMA with exactly those keywords removed and stated in
// descriptions instead. ReadingSummarySchema still enforces them at parse time,
// and summarizeReading asks once more when a call misses one. Guarded by an
// alignment test against READING_SUMMARY_JSON_SCHEMA.
const EMIT_READING_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: {
      type: "string",
      description: "Article title (5-120 chars).",
    },
    tldr: { type: "string", description: "1-3 sentence summary." },
    tags: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
      description: "Broad topical buckets (1-6 non-empty items).",
    },
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "Specific noun phrases (3-15 non-empty items).",
    },
    people: { type: "array", items: { type: "string" } },
    orgs: { type: "array", items: { type: "string" } },
    novelty_verdict: {
      type: "string",
      enum: ["novel", "familiar", "duplicate"],
      description: "Verdict relative to the user's prior library.",
    },
    connections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: {
            type: "string",
            description: "Reading id from the prior library.",
          },
          reason: {
            type: "string",
            description: "One-clause reason for the connection.",
          },
        },
        required: ["id", "reason"],
      },
    },
    summary_markdown: {
      type: "string",
      description: "2-6 short paragraphs in markdown.",
    },
  },
  required: [
    "title",
    "tldr",
    "tags",
    "keywords",
    "people",
    "orgs",
    "novelty_verdict",
    "connections",
    "summary_markdown",
  ],
} as const;

const REJECT_SOURCE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: {
      type: "string",
      description:
        "Why the extracted source is not a full article or transcript.",
    },
  },
  required: ["reason"],
} as const;

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface AnthropicMessageResponse {
  content: Array<AnthropicToolUseBlock | { type: string; [k: string]: unknown }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// The Anthropic Messages request body for one reading. Pure + exported so the
// realtime path (summarizeReading) and the bulk Message Batch path build a
// byte-identical body — same tools + system prefix, hence a shared prompt cache.
// Render order is tools → system → messages; cache_control on the last system
// block caches tools + system together in one breakpoint.
export function buildSummarizeRequestBody(
  input: SummarizeReadingInput,
  model: string,
  effort: AnthropicReasoningEffort,
): object {
  return {
    model,
    max_tokens: 8192,
    // Sonnet 5 turns adaptive thinking on if `thinking` is omitted. Disable it
    // explicitly so summarization stays a single tool call at the 8192 cap.
    thinking: { type: "disabled" },
    output_config: { effort },
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [
      {
        name: EMIT_READING_TOOL_NAME,
        description:
          "Emit the structured reading record when the extracted source is a full article or transcript.",
        input_schema: EMIT_READING_INPUT_SCHEMA,
        strict: true,
      },
      {
        name: REJECT_SOURCE_TOOL_NAME,
        description:
          "Reject the input when it is a teaser, metadata-only page, or a summary of the URL rather than a full article or transcript.",
        input_schema: REJECT_SOURCE_INPUT_SCHEMA,
        strict: true,
      },
    ],
    tool_choice: { type: "any" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildSummarizeUserMessage(input),
          },
        ],
      },
    ],
  };
}

// Parse a Messages `content` array (realtime or batch result) into the validated
// reading + usage. Shared so both paths apply the same tool-use contract.
export function parseEmitReadingResult(
  content: AnthropicMessageResponse["content"],
  usage: AnthropicMessageResponse["usage"],
): SummarizeReadingResult {
  const rejectUse = content.find(
    (b): b is AnthropicToolUseBlock =>
      b.type === "tool_use" &&
      (b as AnthropicToolUseBlock).name === REJECT_SOURCE_TOOL_NAME,
  );
  if (rejectUse) {
    throw new SourceRejectedError(rejectSourceReason(rejectUse.input));
  }

  const toolUse = content.find(
    (b): b is AnthropicToolUseBlock =>
      b.type === "tool_use" && (b as AnthropicToolUseBlock).name === EMIT_READING_TOOL_NAME,
  );
  if (!toolUse) {
    throw new NoToolUseError(
      `Anthropic response did not contain a tool_use block for ${EMIT_READING_TOOL_NAME}`,
    );
  }

  const parsed = ReadingSummarySchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new BadToolInputError(
      `tool_use input failed validation: ${parsed.error.message}`,
    );
  }

  return { reading: parsed.data, usage };
}

function rejectSourceReason(input: unknown): string {
  if (
    input &&
    typeof input === "object" &&
    "reason" in input &&
    typeof input.reason === "string" &&
    input.reason.trim().length > 0
  ) {
    return input.reason.trim();
  }
  return "extracted source is not a full article or transcript";
}

export async function summarizeReading(
  input: SummarizeReadingInput,
  deps: AnthropicDeps,
): Promise<SummarizeReadingResult> {
  if (input.extractedText.length === 0) {
    throw new Error("summarizeReading: extractedText must be non-empty");
  }

  const body = buildSummarizeRequestBody(input, deps.model, deps.effort);

  const init: RequestInit = {
    method: "POST",
    headers: {
      "x-api-key": deps.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
  // A call that misses a bound strict tool use cannot express (or skips the
  // tool) is one bad sample, so ask once more. Each call is its own paid
  // dispatch through deps.fetch; the returned usage covers both.
  let spent: AnthropicMessageResponse["usage"] | undefined;
  for (let call = 1; ; call++) {
    const response = deps.retry
      ? await fetchWithRetry(deps.fetch, ANTHROPIC_MESSAGES_URL, init, deps.retry)
      : await deps.fetch(ANTHROPIC_MESSAGES_URL, init);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new AnthropicError(
        response.status,
        providerErrorText(text, `Anthropic returned ${response.status}`),
      );
    }

    const json = (await response.json()) as AnthropicMessageResponse;
    spent = spent ? addUsage(spent, json.usage) : json.usage;
    try {
      return parseEmitReadingResult(json.content, spent);
    } catch (e) {
      const slip = e instanceof BadToolInputError || e instanceof NoToolUseError;
      if (!slip || call >= SUMMARIZE_CALLS) throw e;
    }
  }
}

const SUMMARIZE_CALLS = 2;

function addUsage(
  a: AnthropicMessageResponse["usage"],
  b: AnthropicMessageResponse["usage"],
): AnthropicMessageResponse["usage"] {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  };
}
