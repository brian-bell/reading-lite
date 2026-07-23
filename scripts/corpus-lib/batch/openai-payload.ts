import { buildSummarizeRequestBody } from "../../../src/modules/openai-summarizer";
import type { OpenAIReasoningEffort } from "../../../src/modules/summarizer/types";
import type { SummarizeTarget } from "./types";

export const MAX_OPENAI_BATCH_BYTES = 190_000_000;
export const MAX_OPENAI_BATCH_REQUESTS = 50_000;

export interface PreparedOpenAIBatchPayload {
  provider: "openai";
  jsonl: string;
  requestCount: number;
  byteCount: number;
}

export function prepareOpenAIBatchPayload(
  targets: SummarizeTarget[],
  model: string,
  reasoningEffort: OpenAIReasoningEffort,
  limits: { maxBytes?: number; maxRequests?: number } = {},
): PreparedOpenAIBatchPayload {
  const maxRequests = Math.min(
    limits.maxRequests ?? MAX_OPENAI_BATCH_REQUESTS,
    MAX_OPENAI_BATCH_REQUESTS,
  );
  if (targets.length > maxRequests) {
    throw new Error(
      `OpenAI batch has ${targets.length} requests, above the ${maxRequests}-request limit; ` +
        "re-run with --limit to split it",
    );
  }
  const lines = targets.map((target) => {
    const { extracted, similar } = target;
    return JSON.stringify({
      custom_id: extracted.target.readingId,
      method: "POST",
      url: "/v1/responses",
      body: buildSummarizeRequestBody(
        {
          url: extracted.target.url,
          extractedText: extracted.markdown,
          ...(extracted.title === undefined ? {} : { title: extracted.title }),
          similarReadings: similar,
        },
        model,
        reasoningEffort,
      ),
    });
  });
  const jsonl = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  const byteCount = new TextEncoder().encode(jsonl).byteLength;
  const maxBytes = Math.min(
    limits.maxBytes ?? MAX_OPENAI_BATCH_BYTES,
    MAX_OPENAI_BATCH_BYTES,
  );
  if (byteCount > maxBytes) {
    throw new Error(
      `OpenAI batch payload is ${byteCount} UTF-8 bytes, above the ${maxBytes}-byte safety cap; ` +
        "re-run with --limit to split it",
    );
  }
  return {
    provider: "openai",
    jsonl,
    requestCount: lines.length,
    byteCount,
  };
}
