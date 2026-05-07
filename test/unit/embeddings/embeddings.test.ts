import { describe, expect, it, vi } from "vitest";
import { embed, OpenAIError, BadEmbeddingResponseError } from "../../../src/modules/embeddings";

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function err(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("embed", () => {
  it("returns the embedding + usage on success", async () => {
    const embedding = new Array(1536).fill(0).map((_, i) => (i % 7) / 100);
    const fetchFn = vi.fn(async () =>
      ok({ data: [{ embedding }], usage: { prompt_tokens: 12, total_tokens: 12 } }),
    );
    const out = await embed("hello world", { fetch: fetchFn, apiKey: "sk-test" });
    expect(out.embedding).toHaveLength(1536);
    expect(out.embedding[7]).toBe(embedding[7]);
    expect(out.usage).toEqual({ prompt_tokens: 12, total_tokens: 12 });
  });

  it("calls OpenAI's embeddings endpoint with the right model + auth", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      ok({
        data: [{ embedding: new Array(1536).fill(0) }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );
    await embed("hi", { fetch: fetchFn, apiKey: "sk-secret" });
    expect(fetchFn).toHaveBeenCalledOnce();
    const call = fetchFn.mock.calls[0]!;
    const url = call[0];
    const init = call[1]!;
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-secret");
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.input).toBe("hi");
  });

  it("rejects empty input before calling fetch", async () => {
    const fetchFn = vi.fn(async () => ok({}));
    await expect(embed("", { fetch: fetchFn, apiKey: "sk" })).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws OpenAIError on non-2xx response", async () => {
    const fetchFn = vi.fn(async () => err(429, { error: { message: "rate limited" } }));
    const e = await embed("x", { fetch: fetchFn, apiKey: "sk" }).catch((e) => e);
    expect(e).toBeInstanceOf(OpenAIError);
    expect(e.status).toBe(429);
    expect(e.message).toContain("rate limited");
  });

  it("throws BadEmbeddingResponseError when shape is missing data[0].embedding", async () => {
    const fetchFn = vi.fn(async () => ok({ data: [] }));
    await expect(embed("x", { fetch: fetchFn, apiKey: "sk" })).rejects.toBeInstanceOf(
      BadEmbeddingResponseError,
    );
  });

  it("throws BadEmbeddingResponseError when embedding dim != 1536", async () => {
    const fetchFn = vi.fn(async () =>
      ok({
        data: [{ embedding: new Array(768).fill(0) }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );
    await expect(embed("x", { fetch: fetchFn, apiKey: "sk" })).rejects.toBeInstanceOf(
      BadEmbeddingResponseError,
    );
  });

  it("retries through retry deps and succeeds after 429 then 200", async () => {
    const embedding = new Array(1536).fill(0).map((_, i) => i / 1536);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(err(429, { error: { message: "slow down" } }))
      .mockResolvedValueOnce(
        ok({ data: [{ embedding }], usage: { prompt_tokens: 1, total_tokens: 1 } }),
      );
    const sleeps: number[] = [];
    const out = await embed("hello", {
      fetch: fetchFn as unknown as typeof fetch,
      apiKey: "sk",
      retry: {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 1,
      },
    });
    expect(out.embedding).toHaveLength(1536);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleeps.length).toBe(1);
  });
});
