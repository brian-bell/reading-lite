import { describe, expect, it, vi } from "vitest";
import {
  makeAnthropicBatchClient,
  makeOpenAIBatchClient,
  makeOpenAIEmbedClient,
} from "../../../../scripts/corpus-lib/batch/clients";

type FetchMock = ReturnType<typeof vi.fn<(input: any, init?: any) => Promise<Response>>>;
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("makeAnthropicBatchClient", () => {
  it("creates a batch and posts requests with auth + version headers", async () => {
    const fetchFn: FetchMock = vi.fn(async () =>
      json({ id: "msgbatch_1", processing_status: "in_progress", results_url: null }),
    );
    const client = makeAnthropicBatchClient({ fetch: fetchFn as unknown as typeof fetch, apiKey: "sk-ant" });
    const info = await client.create([{ custom_id: "rd_a", params: { model: "m" } }]);
    expect(info.id).toBe("msgbatch_1");
    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages/batches");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("sk-ant");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    const body = JSON.parse(init.body as string);
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].custom_id).toBe("rd_a");
  });

  it("throws on a non-2xx create", async () => {
    const fetchFn: FetchMock = vi.fn(async () => json({ error: { message: "bad" } }, 400));
    const client = makeAnthropicBatchClient({ fetch: fetchFn as unknown as typeof fetch, apiKey: "sk" });
    await expect(client.create([])).rejects.toThrow(/batch create/i);
  });

  it("gets batch status by id", async () => {
    const fetchFn: FetchMock = vi.fn(async () =>
      json({ id: "msgbatch_1", processing_status: "ended", results_url: "https://r/results" }),
    );
    const client = makeAnthropicBatchClient({ fetch: fetchFn as unknown as typeof fetch, apiKey: "sk" });
    const info = await client.get("msgbatch_1");
    expect(info.processing_status).toBe("ended");
    expect(info.results_url).toBe("https://r/results");
    const [url] = fetchFn.mock.calls[0]! as [string];
    expect(url).toBe("https://api.anthropic.com/v1/messages/batches/msgbatch_1");
  });

  it("parses JSONL results into per-request records", async () => {
    const lines = [
      JSON.stringify({ custom_id: "rd_a", result: { type: "succeeded", message: { content: [], usage: {} } } }),
      JSON.stringify({ custom_id: "rd_b", result: { type: "errored", error: { type: "x" } } }),
      "",
    ].join("\n");
    const fetchFn: FetchMock = vi.fn(async () => new Response(lines, { status: 200 }));
    const client = makeAnthropicBatchClient({ fetch: fetchFn as unknown as typeof fetch, apiKey: "sk" });
    const results = await client.results("https://r/results");
    expect(results).toHaveLength(2);
    expect(results[0]!.custom_id).toBe("rd_a");
    expect(results[0]!.result.type).toBe("succeeded");
    expect(results[1]!.result.type).toBe("errored");
  });
});

describe("makeOpenAIBatchClient", () => {
  it("uploads the exact JSONL as a purpose=batch multipart file", async () => {
    const fetchFn: FetchMock = vi.fn(async () =>
      json({
        id: "file_input",
        object: "file",
        bytes: 42,
        created_at: 1,
        filename: "reading-lite-run_1.jsonl",
        purpose: "batch",
      }),
    );
    const client = makeOpenAIBatchClient({
      fetch: fetchFn as unknown as typeof fetch,
      apiKey: "sk-oa",
    });
    const jsonl = '{"custom_id":"rd_a"}\n';

    await expect(client.upload(jsonl, "run_1")).resolves.toMatchObject({
      id: "file_input",
    });

    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/files");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-oa");
    expect(new Headers(init.headers).has("content-type")).toBe(false);
    const form = init.body as FormData;
    expect(form.get("purpose")).toBe("batch");
    const file = form.get("file") as File;
    expect(file.name).toBe("reading-lite-run_1.jsonl");
    expect(await file.text()).toBe(jsonl);
  });

  it("creates a /v1/responses batch with a 24h window and stable run metadata", async () => {
    const fetchFn: FetchMock = vi.fn(async () =>
      json({
        id: "batch_1",
        object: "batch",
        endpoint: "/v1/responses",
        errors: null,
        input_file_id: "file_input",
        completion_window: "24h",
        status: "validating",
        output_file_id: null,
        error_file_id: null,
        request_counts: { total: 0, completed: 0, failed: 0 },
      }),
    );
    const client = makeOpenAIBatchClient({
      fetch: fetchFn as unknown as typeof fetch,
      apiKey: "sk-oa",
    });

    await expect(client.create("file_input", "run_1")).resolves.toMatchObject({
      id: "batch_1",
      status: "validating",
    });

    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/batches");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-oa");
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      input_file_id: "file_input",
      endpoint: "/v1/responses",
      completion_window: "24h",
      metadata: { run_id: "run_1" },
    });
  });

  it("defaults optional in-flight batch fields the API may omit", async () => {
    // The Batch object marks output_file_id, error_file_id, and request_counts
    // optional while validating/in progress; an omitting response must not fail
    // parsing after the remote batch already exists.
    const inFlight = {
      id: "batch_1",
      object: "batch",
      endpoint: "/v1/responses",
      input_file_id: "file_input",
      completion_window: "24h",
      status: "validating",
    };
    const fetchFn: FetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(inFlight))
      .mockResolvedValueOnce(json(inFlight));
    const client = makeOpenAIBatchClient({
      fetch: fetchFn as unknown as typeof fetch,
      apiKey: "sk-oa",
    });

    const expected = {
      id: "batch_1",
      status: "validating",
      output_file_id: null,
      error_file_id: null,
      request_counts: { total: 0, completed: 0, failed: 0 },
    };
    await expect(client.create("file_input", "run_1")).resolves.toMatchObject(
      expected,
    );
    await expect(client.get("batch_1")).resolves.toMatchObject(expected);
  });

  it("retrieves batch status and file content by id", async () => {
    const batch = {
      id: "batch_1",
      object: "batch",
      endpoint: "/v1/responses",
      errors: null,
      input_file_id: "file_input",
      completion_window: "24h",
      status: "completed",
      output_file_id: "file_output",
      error_file_id: null,
      request_counts: { total: 1, completed: 1, failed: 0 },
    };
    const fetchFn: FetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(batch))
      .mockResolvedValueOnce(
        new Response('{"custom_id":"rd_a"}\n', { status: 200 }),
      );
    const client = makeOpenAIBatchClient({
      fetch: fetchFn as unknown as typeof fetch,
      apiKey: "sk-oa",
    });

    await expect(client.get("batch_1")).resolves.toMatchObject(batch);
    await expect(client.content("file_output")).resolves.toBe(
      '{"custom_id":"rd_a"}\n',
    );

    expect(fetchFn.mock.calls.map((call) => call[0])).toEqual([
      "https://api.openai.com/v1/batches/batch_1",
      "https://api.openai.com/v1/files/file_output/content",
    ]);
    for (const [, init] of fetchFn.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer sk-oa",
      );
    }
  });
});

describe("makeOpenAIEmbedClient", () => {
  const vec = (n: number) => Array.from({ length: 1536 }, () => n);

  it("embeds many inputs in one request and preserves order", async () => {
    const fetchFn: FetchMock = vi.fn(async () =>
      json({
        data: [
          { index: 1, embedding: vec(2) },
          { index: 0, embedding: vec(1) },
        ],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      }),
    );
    const client = makeOpenAIEmbedClient({ fetch: fetchFn as unknown as typeof fetch, apiKey: "sk-oa" });
    const { embeddings } = await client.embedMany(["a", "b"]);
    expect(embeddings).toHaveLength(2);
    // Sorted by `index`, not response order.
    expect(embeddings[0]![0]).toBe(1);
    expect(embeddings[1]![0]).toBe(2);
    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-oa");
    expect(JSON.parse(init.body as string).input).toEqual(["a", "b"]);
  });

  it("returns [] for no inputs without calling fetch", async () => {
    const fetchFn: FetchMock = vi.fn(async () => json({}));
    const client = makeOpenAIEmbedClient({ fetch: fetchFn as unknown as typeof fetch, apiKey: "sk" });
    expect(await client.embedMany([])).toEqual({ embeddings: [], tokensByInput: [] });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("attributes per-input tokens proportionally, summing to the request total", async () => {
    const fetchFn: FetchMock = vi.fn(async () =>
      json({
        data: [
          { index: 0, embedding: vec(1) },
          { index: 1, embedding: vec(2) },
        ],
        usage: { prompt_tokens: 9, total_tokens: 9 },
      }),
    );
    const client = makeOpenAIEmbedClient({ fetch: fetchFn as unknown as typeof fetch, apiKey: "sk" });
    // lengths 2 and 4 → shares floor(3) and floor(6); remainder 0 → [3, 6].
    const { tokensByInput } = await client.embedMany(["ab", "cdef"]);
    expect(tokensByInput).toEqual([3, 6]);
    expect(tokensByInput.reduce((a, b) => a + b, 0)).toBe(9);
  });

  it("chunks large input lists across multiple requests, preserving global order", async () => {
    let call = 0;
    const fetchFn: FetchMock = vi.fn(async (_url: any, init: any) => {
      const inputs = JSON.parse(init.body as string).input as string[];
      const base = call * 1000;
      call++;
      return json({
        data: inputs.map((_, i) => ({ index: i, embedding: vec(base + i) })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    });
    const client = makeOpenAIEmbedClient(
      { fetch: fetchFn as unknown as typeof fetch, apiKey: "sk" },
      { chunkSize: 2 },
    );
    const { embeddings } = await client.embedMany(["a", "b", "c"]);
    expect(embeddings).toHaveLength(3);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(embeddings[0]![0]).toBe(0); // chunk0 idx0
    expect(embeddings[1]![0]).toBe(1); // chunk0 idx1
    expect(embeddings[2]![0]).toBe(1000); // chunk1 idx0
  });

  it("rejects empty-string inputs (OpenAI 400s on them)", async () => {
    const fetchFn: FetchMock = vi.fn(async () => json({}));
    const client = makeOpenAIEmbedClient({ fetch: fetchFn as unknown as typeof fetch, apiKey: "sk" });
    await expect(client.embedMany(["ok", ""])).rejects.toThrow(/empty/i);
  });

  it("throws when a returned vector has the wrong dimension", async () => {
    const fetchFn: FetchMock = vi.fn(async () =>
      json({ data: [{ index: 0, embedding: [1, 2, 3] }], usage: { prompt_tokens: 1, total_tokens: 1 } }),
    );
    const client = makeOpenAIEmbedClient({ fetch: fetchFn as unknown as typeof fetch, apiKey: "sk" });
    await expect(client.embedMany(["a"])).rejects.toThrow();
  });
});
