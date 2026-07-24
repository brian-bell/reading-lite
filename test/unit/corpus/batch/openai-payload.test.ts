import { describe, expect, it } from "vitest";
import { buildSummarizeRequestBody } from "../../../../src/modules/openai-summarizer";
import {
  MAX_OPENAI_BATCH_REQUESTS,
  prepareOpenAIBatchPayload,
} from "../../../../scripts/corpus-lib/batch/openai-payload";
import type { SummarizeTarget } from "../../../../scripts/corpus-lib/batch/types";

function target(): SummarizeTarget {
  return {
    extracted: {
      target: {
        readingId: "rd_a",
        url: "https://example.com/a",
      },
      markdown: "# Article\n\nUseful text.",
      title: "Article",
    },
    similar: [
      {
        id: "rd_related",
        url: "https://example.com/related",
        title: "Related",
        tldr: "Related context.",
      },
    ],
    queryEmbedTokens: 7,
  } as SummarizeTarget;
}

describe("prepareOpenAIBatchPayload", () => {
  it("builds UTF-8 JSONL with the exact realtime Responses body", () => {
    const prepared = prepareOpenAIBatchPayload(
      [target()],
      "gpt-5.6-terra",
      "low",
    );

    const line = JSON.parse(prepared.jsonl.trimEnd());
    expect(line).toEqual({
      custom_id: "rd_a",
      method: "POST",
      url: "/v1/responses",
      body: buildSummarizeRequestBody(
        {
          url: "https://example.com/a",
          title: "Article",
          extractedText: "# Article\n\nUseful text.",
          similarReadings: [
            {
              id: "rd_related",
              url: "https://example.com/related",
              title: "Related",
              tldr: "Related context.",
            },
          ],
        },
        "gpt-5.6-terra",
        "low",
      ),
    });
    expect(prepared.jsonl.endsWith("\n")).toBe(true);
    expect(prepared.requestCount).toBe(1);
    expect(prepared.byteCount).toBe(
      new TextEncoder().encode(prepared.jsonl).byteLength,
    );
  });

  it("rejects the measured UTF-8 payload above the configured byte cap", () => {
    const unicode = target();
    unicode.extracted.markdown = "# Café\n\n🙂";
    const measured = prepareOpenAIBatchPayload(
      [unicode],
      "gpt-5.6-terra",
      "low",
    );

    expect(() =>
      prepareOpenAIBatchPayload(
        [unicode],
        "gpt-5.6-terra",
        "low",
        { maxBytes: measured.byteCount - 1 },
      ),
    ).toThrow(/byte.*cap|cap.*byte/i);
  });

  it("enforces the 50,000-request service limit", () => {
    expect(MAX_OPENAI_BATCH_REQUESTS).toBe(50_000);
    expect(() =>
      prepareOpenAIBatchPayload(
        [target()],
        "gpt-5.6-terra",
        "low",
        { maxRequests: 0 },
      ),
    ).toThrow(/request.*limit/i);
  });

  it("does not let an override raise the hard service request limit", () => {
    const sparseTargets = new Array(
      MAX_OPENAI_BATCH_REQUESTS + 1,
    ) as SummarizeTarget[];

    expect(() =>
      prepareOpenAIBatchPayload(
        sparseTargets,
        "gpt-5.6-terra",
        "low",
        { maxRequests: MAX_OPENAI_BATCH_REQUESTS + 1 },
      ),
    ).toThrow(/request.*limit/i);
  });
});
