import { z } from "zod";
import {
  READING_SUMMARY_JSON_SCHEMA,
  ReadingSummarySchema,
  type ReadingSummary,
} from "../../schemas/reading-summary";
import { fetchWithRetry, type RetryDeps } from "../http-retry";
import { redactProviderKeys } from "../provider-error-text";
import {
  LIBRARIAN_INSTRUCTIONS,
  buildSummarizeUserMessage,
} from "../summarizer/instructions";
import type {
  OpenAIReasoningEffort,
  ProviderSummarizeResult,
  SummarizeReadingInput,
} from "../summarizer/types";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const INSTRUCTIONS = `${LIBRARIAN_INSTRUCTIONS}

If the source is adequate, emit result "reading_summary" with the structured reading. If the source is inadequate, emit result "reject_source" with a reason and reading null. Do not invent a reading_summary for a teaser, metadata-only page, or a summary of the URL.`;

// Strict Responses schema: a tagged outcome so thin sources can fail closed
// instead of being forced into reading_summary. Native refusals stay reserved
// for safety policy.
export const OPENAI_SUMMARIZE_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    result: {
      type: "string",
      enum: ["reading_summary", "reject_source"],
    },
    reason: { type: "string" },
    reading: {
      anyOf: [READING_SUMMARY_JSON_SCHEMA, { type: "null" }],
    },
  },
  required: ["result", "reason", "reading"],
} as const;

export interface OpenAISummarizerDeps {
  fetch: typeof fetch;
  apiKey: string;
  model: string;
  reasoningEffort: OpenAIReasoningEffort;
  retry?: RetryDeps;
}

export interface OpenAISummarizerUsage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
}

export type OpenAISummarizeResult = ProviderSummarizeResult<OpenAISummarizerUsage>;

export class OpenAIError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "OpenAIError";
  }
}

export class OpenAIRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIRefusalError";
  }
}

export class OpenAISourceRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAISourceRejectedError";
  }
}

export class OpenAIIncompleteResponseError extends Error {
  constructor(status: string, details: unknown) {
    super(
      `OpenAI response status was ${status}${
        details === undefined ? "" : `: ${JSON.stringify(details)}`
      }`,
    );
    this.name = "OpenAIIncompleteResponseError";
  }
}

export class OpenAIOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenAIOutputError";
  }
}

export class OpenAIResponseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenAIResponseError";
  }
}

const ResponseEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("response"),
    status: z.string(),
    incomplete_details: z.unknown().optional(),
    output: z.array(
      z
        .object({
          type: z.string(),
          role: z.string().optional(),
          content: z
            .array(
              z
                .object({
                  type: z.string(),
                  text: z.string().optional(),
                  refusal: z.string().optional(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough(),
    ),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        input_tokens_details: z
          .object({
            cached_tokens: z.number().int().nonnegative().optional(),
            cache_write_tokens: z.number().int().nonnegative().optional(),
          })
          .optional(),
        output_tokens_details: z
          .object({
            reasoning_tokens: z.number().int().nonnegative().optional(),
          })
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

export function buildSummarizeRequestBody(
  input: SummarizeReadingInput,
  model: string,
  reasoningEffort: OpenAIReasoningEffort,
): object {
  return {
    model,
    store: false,
    reasoning: { effort: reasoningEffort },
    max_output_tokens: 8192,
    instructions: INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildSummarizeUserMessage(input),
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "summarize_outcome",
        strict: true,
        schema: OPENAI_SUMMARIZE_OUTPUT_JSON_SCHEMA,
      },
    },
    // Deliberate caching opt-out, not a misconfiguration: explicit mode with no
    // prompt_cache_breakpoint blocks disables prompt caching entirely. Implicit
    // mode would breakpoint the latest message — the unique per-reading article —
    // billing 1.25x cache writes with no realistic chance of a later hit, and the
    // shared prefix (instructions) is too small to cache on its own.
    prompt_cache_options: { mode: "explicit" },
  };
}

export async function summarizeReading(
  input: SummarizeReadingInput,
  deps: OpenAISummarizerDeps,
): Promise<OpenAISummarizeResult> {
  if (input.extractedText.length === 0) {
    throw new Error("summarizeReading: extractedText must be non-empty");
  }

  const body = buildSummarizeRequestBody(input, deps.model, deps.reasoningEffort);
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: `Bearer ${deps.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
  const response = deps.retry
    ? await fetchWithRetry(deps.fetch, OPENAI_RESPONSES_URL, init, deps.retry)
    : await deps.fetch(OPENAI_RESPONSES_URL, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new OpenAIError(
      response.status,
      redactProviderKeys(openAIErrorMessage(text, response.status)),
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch (cause) {
    throw new OpenAIResponseError(
      "OpenAI response body was not valid JSON",
      { cause },
    );
  }
  return parseSummarizeResponse(value);
}

export function parseSummarizeResponse(value: unknown): OpenAISummarizeResult {
  const parsed = ResponseEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new OpenAIResponseError(
      `OpenAI response failed validation: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  const response = parsed.data;
  if (response.status !== "completed") {
    throw new OpenAIIncompleteResponseError(
      response.status,
      response.incomplete_details,
    );
  }

  const messages = response.output.filter(
    (item) => item.type === "message" && item.role === "assistant",
  );
  const refusal = messages
    .flatMap((message) => message.content ?? [])
    .find(
      (item): item is typeof item & { refusal: string } =>
        item.type === "refusal" && typeof item.refusal === "string",
    );
  if (refusal) {
    throw new OpenAIRefusalError(refusal.refusal);
  }

  const outputText = messages.flatMap((message) =>
    (message.content ?? []).filter(
      (item): item is typeof item & { text: string } =>
        item.type === "output_text" && typeof item.text === "string",
    ),
  );
  if (messages.length !== 1 || outputText.length !== 1) {
    throw new OpenAIOutputError(
      "OpenAI response did not contain exactly one assistant output_text",
    );
  }

  let reading: ReadingSummary;
  try {
    reading = parseSummarizeOutputText(outputText[0]!.text);
  } catch (cause) {
    if (cause instanceof OpenAISourceRejectedError) throw cause;
    throw new OpenAIOutputError(
      "OpenAI output_text was not a valid reading summary",
      { cause },
    );
  }
  return {
    reading,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      reasoning_tokens: response.usage.output_tokens_details?.reasoning_tokens ?? 0,
      cached_input_tokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
      cache_write_tokens: response.usage.input_tokens_details?.cache_write_tokens ?? 0,
    },
  };
}

function parseSummarizeOutputText(text: string): ReadingSummary {
  const value: unknown = JSON.parse(text);
  if (isRecord(value) && value.result === "reject_source") {
    throw new OpenAISourceRejectedError(rejectSourceReason(value.reason));
  }
  if (isRecord(value) && value.result === "reading_summary") {
    return ReadingSummarySchema.parse(value.reading);
  }
  // Bare reading summaries remain parseable so in-flight OpenAI batches
  // submitted against the previous schema still commit.
  return ReadingSummarySchema.parse(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function rejectSourceReason(reason: unknown): string {
  return typeof reason === "string" && reason.trim().length > 0
    ? reason.trim()
    : "extracted source is not a full article or transcript";
}

function openAIErrorMessage(text: string, status: number): string {
  try {
    const json = JSON.parse(text) as { error?: { message?: string } };
    if (json.error?.message) return json.error.message;
  } catch {
    // Ignore invalid error bodies and fall back to their raw text.
  }
  return text || `OpenAI returned ${status}`;
}
