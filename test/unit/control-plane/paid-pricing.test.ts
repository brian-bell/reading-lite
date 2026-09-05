import { describe, expect, it } from "vitest";
import {
  PAID_PRICE_CATALOG_VERSION,
  actualPaidCost,
  quotePaidRequest,
} from "../../../src/modules/paid-pricing";
import { buildSummarizeRequestBody as buildOpenAIRequest } from "../../../src/modules/openai-summarizer";
import { buildSummarizeRequestBody as buildAnthropicRequest } from "../../../src/modules/anthropic";
import {
  buildAnthropicTensionRequestBody,
  buildOpenAITensionRequestBody,
} from "../../../src/modules/tension-judgement";
import {
  buildAnthropicRelationshipRequestBody,
  buildOpenAIRelationshipRequestBody,
} from "../../../src/modules/relationship-judgement";

const JSON_HEADERS = { "content-type": "application/json" };

function request(body: unknown): RequestInit {
  return { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) };
}

const summaryInput = {
  url: "https://example.com/article",
  title: "Article",
  extractedText: "A complete extracted article.",
  similarReadings: [],
};

function openAIRequest(maxOutputTokens = 8192): object {
  const body = buildOpenAIRequest(summaryInput, "gpt-5.6-terra", "low") as Record<string, unknown>;
  return { ...body, max_output_tokens: maxOutputTokens };
}

describe("runtime paid-request pricing", () => {
  it("quotes the full embedding payload under the versioned catalog", async () => {
    const init = request({ model: "text-embedding-3-small", input: "hello" });
    const quote = await quotePaidRequest("https://api.openai.com/v1/embeddings", init);

    expect(quote).toMatchObject({
      catalogVersion: PAID_PRICE_CATALOG_VERSION,
      provider: "openai",
      kind: "embedding",
      model: "text-embedding-3-small",
    });
    // The fixed protocol allowance keeps a tiny body conservatively bounded.
    expect(quote?.maxMicrodollars).toBeGreaterThanOrEqual(21);
    expect(quote?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the embedding maximum for incomplete or contradictory usage", async () => {
    const quote = (await quotePaidRequest("https://api.openai.com/v1/embeddings",
      request({model:"text-embedding-3-small",input:"hello"})))!;
    expect(actualPaidCost(quote,{usage:{prompt_tokens:0}})).toBeNull();
    expect(actualPaidCost(quote,{usage:{prompt_tokens:0,total_tokens:100}})).toBeNull();
    expect(actualPaidCost(quote,{usage:{prompt_tokens:10,total_tokens:10}})).toBe(1);
  });

  it("uses every serialized byte for the bound, rather than a bytes/4 estimate", async () => {
    const short = request({ model: "text-embedding-3-small", input: "a" });
    const wide = request({ model: "text-embedding-3-small", input: "😀".repeat(100) });
    const [smallQuote, wideQuote] = await Promise.all([
      quotePaidRequest("https://api.openai.com/v1/embeddings", short),
      quotePaidRequest("https://api.openai.com/v1/embeddings", wide),
    ]);
    expect(wideQuote!.maxMicrodollars).toBeGreaterThan(smallQuote!.maxMicrodollars);
    expect(wideQuote!.maxMicrodollars).toBeGreaterThanOrEqual(9);
  });

  it("reserves the most expensive OpenAI input category plus the declared output ceiling", async () => {
    const quote = await quotePaidRequest(
      "https://api.openai.com/v1/responses",
      request(openAIRequest(100)),
    );

    expect(quote).toMatchObject({ provider: "openai", kind: "responses", model: "gpt-5.6-terra" });
    expect(quote!.maxMicrodollars).toBeGreaterThanOrEqual(1_500);
  });

  it("reconciles OpenAI cache buckets without double counting reasoning or input", async () => {
    const quote = await quotePaidRequest(
      "https://api.openai.com/v1/responses",
      request(openAIRequest(100)),
    );
    expect(quote).not.toBeNull();
    // (100 - 20 - 10) × 2 + 20 × .2 + 10 × 2.5 + 5 × 12 = 229.
    expect(actualPaidCost(quote!, {
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
        output_tokens_details: { reasoning_tokens: 4 },
      },
    })).toBe(229);
  });

  it("quotes and reconciles Anthropic's separate cache usage buckets", async () => {
    const quote = await quotePaidRequest(
      "https://api.anthropic.com/v1/messages",
      request({ ...(buildAnthropicRequest(summaryInput, "claude-sonnet-5", "low") as Record<string, unknown>), max_tokens: 20 }),
    );
    expect(quote).toMatchObject({ provider: "anthropic", kind: "messages", model: "claude-sonnet-5" });
    // Base is 60.4µ$; conservative unknown geography applies the 1.1× surcharge.
    expect(actualPaidCost(quote!, {
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 4,
      },
    })).toBe(67);
  });

  it("reserves and settles Anthropic at the conservative unknown-geometry surcharge", async () => {
    const quote = await quotePaidRequest(
      "https://api.anthropic.com/v1/messages",
      request(buildAnthropicRequest(summaryInput, "claude-sonnet-5", "low")),
    );
    expect(quote).not.toBeNull();
    // One 2µ$ Sonnet input token becomes ceil(2 × 1.1) = 3µ$.
    expect(actualPaidCost(quote!, { usage: { input_tokens: 1, output_tokens: 0 } })).toBe(3);
  });

  it("fails closed for unknown models, stream bodies, non-text inputs, and unbounded output", async () => {
    await expect(quotePaidRequest(
      "https://api.openai.com/v1/embeddings",
      request({ model: "new-model", input: "source" }),
    )).resolves.toBeNull();
    await expect(quotePaidRequest(
      "https://api.openai.com/v1/responses",
      request({ ...openAIRequest(), stream: true }),
    )).resolves.toBeNull();
    await expect(quotePaidRequest(
      "https://api.anthropic.com/v1/messages",
      request({ ...buildAnthropicRequest(summaryInput, "claude-sonnet-5", "low"), service_tier: "priority" }),
    )).resolves.toBeNull();
    await expect(quotePaidRequest("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: JSON_HEADERS,
      body: new URLSearchParams({ model: "text-embedding-3-small", input: "x" }),
    })).resolves.toBeNull();
  });

  it("retains the maximum when usage is malformed, overlaps, or exceeds the quote", async () => {
    const quote = await quotePaidRequest(
      "https://api.openai.com/v1/responses",
      request(openAIRequest(1)),
    );
    expect(actualPaidCost(quote!, { usage: { input_tokens: 1 } })).toBeNull();
    expect(actualPaidCost(quote!, {
      usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 1, cache_write_tokens: 1 } },
    })).toBeNull();
    expect(actualPaidCost(quote!, { usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } })).toBeNull();
  });

  it("accepts each hosted request-builder shape and prices a 1h Anthropic cache at its higher rate", async () => {
    const openAI = await quotePaidRequest("https://api.openai.com/v1/responses", request(openAIRequest()));
    const anthropicBody = buildAnthropicRequest(summaryInput, "claude-sonnet-5", "low") as Record<string, unknown>;
    const ordinary = await quotePaidRequest("https://api.anthropic.com/v1/messages", request(anthropicBody));
    const oneHour = await quotePaidRequest("https://api.anthropic.com/v1/messages", request({
      ...anthropicBody,
      system: [{ ...(anthropicBody.system as Array<Record<string, unknown>>)[0]!, cache_control: { type: "ephemeral", ttl: "1h" } }],
    }));
    expect(openAI).not.toBeNull();
    expect(ordinary).not.toBeNull();
    expect(oneHour).not.toBeNull();
    expect(oneHour!.maxMicrodollars).toBeGreaterThan(ordinary!.maxMicrodollars);
  });

  it("accepts the hosted relationship and tension request builders", async () => {
    const tension = {
      a: { id: "rd_a", url: "https://a.test", title: "A", tldr: "a", summary_markdown: "a" },
      b: { id: "rd_b", url: "https://b.test", title: "B", tldr: "b", summary_markdown: "b" },
    };
    const relationship = {
      reading: { id: "rd_a", url: "https://a.test", title: "A", tldr: "a", tags: [], summary_markdown: "a" },
      similarReadings: [],
    };
    const bodies = [
      ["https://api.openai.com/v1/responses", buildOpenAITensionRequestBody(tension, "gpt-5.6-terra", "low")],
      ["https://api.anthropic.com/v1/messages", buildAnthropicTensionRequestBody(tension, "claude-sonnet-5", "low")],
      ["https://api.openai.com/v1/responses", buildOpenAIRelationshipRequestBody(relationship, "gpt-5.6-terra", "low")],
      ["https://api.anthropic.com/v1/messages", buildAnthropicRelationshipRequestBody(relationship, "claude-sonnet-5", "low")],
    ] as const;
    for (const [url, body] of bodies) {
      await expect(quotePaidRequest(url, request(body))).resolves.not.toBeNull();
    }
  });

  it("rejects hidden prior context and mismatched response models", async () => {
    await expect(quotePaidRequest("https://api.openai.com/v1/responses", request({
      ...openAIRequest(), previous_response_id: "resp_paid_elsewhere",
    }))).resolves.toBeNull();
    const quote = await quotePaidRequest("https://api.openai.com/v1/responses", request(openAIRequest(1)));
    expect(actualPaidCost(quote!, { model: "gpt-5.6-sol", usage: { input_tokens: 1, output_tokens: 1 } })).toBeNull();
    expect(actualPaidCost(quote!, { service_tier: "priority", usage: { input_tokens: 1, output_tokens: 1 } })).toBeNull();
    expect(actualPaidCost(quote!, { usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: "bad" } })).toBeNull();
  });

  it("uses the published OpenAI long-context tier for both reservations and actual settlement", async () => {
    const longInput = { ...summaryInput, extractedText: "x".repeat(273_000) };
    const body = buildOpenAIRequest(longInput, "gpt-5.6-terra", "low");
    const quote = await quotePaidRequest("https://api.openai.com/v1/responses", request(body));
    expect(quote).not.toBeNull();
    // Long-context Terra: 272,001 input × 4µ$ plus 1 output × 18µ$.
    expect(actualPaidCost(quote!, { usage: { input_tokens: 272_001, output_tokens: 1 } })).toBe(1_088_022);
    // The reservation uses the more expensive 5µ$ cache-write maximum.
    expect(quote!.maxMicrodollars).toBeGreaterThan(1_365_000);
  });

  it("accepts only the explicit default OpenAI service tier", async () => {
    await expect(quotePaidRequest("https://api.openai.com/v1/responses", request({
      ...openAIRequest(), service_tier: "default",
    }))).resolves.not.toBeNull();
    await expect(quotePaidRequest("https://api.openai.com/v1/responses", request({
      ...openAIRequest(), service_tier: "flex",
    }))).resolves.toBeNull();
  });
});
