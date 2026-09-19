import { describe, expect, it, vi } from "vitest";
import { RateLimitedError, type RetryDeps } from "../../../src/modules/http-retry";
import { providerFromVars } from "../../../scripts/ops-lib/commands/corpus-refresh-connections";
import { tensionProviderFromVars } from "../../../scripts/ops-lib/commands/corpus-refresh-tensions";
import { judgeRetryDeps } from "../../../scripts/ops-lib/judge-retry";
import { withOperatorPaidFetch } from "../../../scripts/ops-lib/operator-spend";
import { BILLING_TENANT, spendHarness } from "../../helpers/operator-spend";

const vars = {
  SUMMARIZER_PROVIDER: "openai",
  OPENAI_SUMMARIZATION_MODEL: "gpt-5.6-terra",
  OPENAI_SUMMARIZATION_REASONING_EFFORT: "high",
  OPENAI_API_KEY: "sk-test",
};

const relationshipInput = {
  reading: {
    id: "rd_a",
    url: "https://example.com/a",
    title: "Target",
    tldr: "Target argument.",
    tags: ["testing"],
    summary_markdown: "Target summary.",
  },
  similarReadings: [{ id: "rd_b", score: 0.87, title: "Prior", tldr: "Related." }],
};

const tensionInput = {
  a: {
    id: "rd_a",
    url: "https://example.com/a",
    title: "A",
    tldr: "A claim.",
    summary_markdown: "A summary.",
  },
  b: {
    id: "rd_b",
    url: "https://example.com/b",
    title: "B",
    tldr: "B claim.",
    summary_markdown: "B summary.",
  },
};

function relationshipResponse() {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                novelty_verdict: "familiar",
                connections: [{ id: "rd_b", reason: "same argument" }],
              }),
            },
          ],
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 7 },
      },
    }),
    { status: 200 },
  );
}

function testRetry(sleep: (ms: number) => Promise<void>): RetryDeps {
  return { ...judgeRetryDeps(sleep), random: () => 1 };
}

describe("refresh judgement retry", () => {
  it("retries a 5xx and returns the judgement the retry produced", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchFn = vi
      .fn<(input: any, init?: any) => Promise<Response>>()
      .mockResolvedValueOnce(new Response("upstream boom", { status: 503 }))
      .mockResolvedValueOnce(relationshipResponse());
    const provider = providerFromVars(vars, true, {
      fetch: fetchFn as unknown as typeof fetch,
      retry: testRetry(sleep),
    });

    const result = await provider.judge(relationshipInput);
    expect(result.judgement.novelty_verdict).toBe("familiar");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("exhausts the retry budget and reports the provider error", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(
      async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 500 }),
    );
    const provider = providerFromVars(vars, true, {
      fetch: fetchFn as unknown as typeof fetch,
      retry: testRetry(async () => {}),
    });

    await expect(provider.judge(relationshipInput)).rejects.toThrow(/500 relationship provider error/);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("retries a network fault, which is what a request timeout arrives as", async () => {
    const fetchFn = vi
      .fn<(input: any, init?: any) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(relationshipResponse());
    const provider = providerFromVars(vars, true, {
      fetch: fetchFn as unknown as typeof fetch,
      retry: testRetry(async () => {}),
    });

    await expect(provider.judge(relationshipInput)).resolves.toMatchObject({
      judgement: { novelty_verdict: "familiar" },
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("surfaces a 429 as a typed RateLimitedError without burning the budget", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(
      async () => new Response("slow down", { status: 429, headers: { "retry-after": "12" } }),
    );
    const provider = providerFromVars(vars, true, {
      fetch: fetchFn as unknown as typeof fetch,
      retry: testRetry(async () => {}),
    });

    await expect(provider.judge(relationshipInput)).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("applies the same policy to the tension judge", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(
      async () => new Response("slow down", { status: 429 }),
    );
    const provider = tensionProviderFromVars(vars, true, {
      fetch: fetchFn as unknown as typeof fetch,
      retry: testRetry(async () => {}),
    });

    await expect(provider.judge(tensionInput)).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("defaults to the shared judge retry policy when no transport is injected", () => {
    expect(judgeRetryDeps()).toMatchObject({
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 8_000,
    });
  });
});

// reading-lite-gh319.1. The spend wrapper sits where the judge client takes its
// fetch, inside the retry loop: the real relationship payload is one the price
// catalog can bound, and the retried attempt is a second possible bill.
describe("refresh judgement retry under spend admission", () => {
  it("reserves each provider attempt under a fresh operation identity", async () => {
    const spend = spendHarness();
    spend.fetch
      .mockResolvedValueOnce(new Response("upstream boom", { status: 503 }))
      .mockResolvedValueOnce(relationshipResponse());
    const result = await withOperatorPaidFetch(
      { openSpend: spend.openSpend, fetch: spend.fetch, now: () => Date.now() },
      { env: "staging", billingTenant: BILLING_TENANT, command: "corpus-refresh-connections" },
      (paidFetch) =>
        providerFromVars(vars, true, { fetch: paidFetch, retry: testRetry(async () => {}) }).judge(relationshipInput),
    );
    expect(result.judgement.novelty_verdict).toBe("familiar");
    expect(spend.fetch).toHaveBeenCalledTimes(2);
    const reserved = spend.calls.filter((call) => call.kind === "reserve_spend").map((call) => call.opId);
    expect(reserved).toHaveLength(2);
    expect(new Set(reserved).size).toBe(2);
    expect(reserved.every((opId) => opId.startsWith("operator:corpus-refresh-connections:operator:"))).toBe(true);
  });
});
