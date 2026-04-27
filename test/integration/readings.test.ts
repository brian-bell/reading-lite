import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/router";
import type { Services } from "../../src/services";
import { SimilarityStore } from "../../src/modules/stores/similarity-store";

// Vectorize is stubbed in the env at the integration boundary because Miniflare
// has no native Vectorize emulator. We mutate env.READINGS_INDEX in-place per test.
type AnyMock = ReturnType<typeof vi.fn>;
function installVectorizeStub(): { upsert: AnyMock; query: AnyMock; vectors: Map<string, { values: number[]; metadata: Record<string, unknown> }> } {
  const vectors = new Map<string, { values: number[]; metadata: Record<string, unknown> }>();
  const upsert = vi.fn(async (vs: VectorizeVector[]) => {
    for (const v of vs) {
      vectors.set(v.id, { values: v.values as number[], metadata: (v.metadata ?? {}) as Record<string, unknown> });
    }
    return { mutationId: "m" } as VectorizeAsyncMutation;
  });
  const query = vi.fn(async (_v: number[], opts: VectorizeQueryOptions) => {
    const k = opts.topK ?? 5;
    const matches = Array.from(vectors.entries())
      .slice(0, k)
      .map(([id, v]) => ({ id, score: 0.9, values: v.values, metadata: v.metadata }));
    return { count: matches.length, matches } as unknown as VectorizeMatches;
  });
  (env as unknown as { READINGS_INDEX: VectorizeIndex }).READINGS_INDEX = {
    upsert,
    query,
  } as unknown as VectorizeIndex;
  return { upsert, query, vectors };
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) {
    await env.READINGS_BUCKET.delete(obj.key);
  }
}

const HTML = `<!doctype html><html><head><title>Test Article</title></head><body>
<main><article><h1>Test Article</h1>
<p>This is a paragraph with enough words to be picked up by readability as the main content body of the article.</p>
<p>This is a second paragraph that adds more content so the article passes the readability character threshold.</p>
</article></main></body></html>`;

function makeStubFetch(opts: {
  source?: { status?: number; body?: string; contentType?: string };
  embedding?: number[];
  toolInput?: Record<string, unknown>;
  anthropicStatus?: number;
  anthropicBody?: unknown;
} = {}) {
  const source = opts.source ?? {
    status: 200,
    body: HTML,
    contentType: "text/html; charset=utf-8",
  };
  const embedding = opts.embedding ?? new Array(1536).fill(0.1);
  const toolInput = opts.toolInput ?? {
    title: "Test Article",
    tldr: "A short summary.",
    tags: ["test"],
    keywords: ["test", "article"],
    people: [],
    orgs: [],
    novelty_verdict: "novel",
    connections: [],
    summary_markdown: "summary body",
  };
  const fetchFn = vi.fn<typeof fetch>(async (input, _init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://api.openai.com/v1/embeddings")) {
      return new Response(
        JSON.stringify({
          data: [{ embedding }],
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://api.anthropic.com/v1/messages")) {
      const status = opts.anthropicStatus ?? 200;
      const body = opts.anthropicBody ?? {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_01", name: "emit_reading", input: toolInput }],
        usage: { input_tokens: 100, output_tokens: 50 },
      };
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    // Source URL (or anything else) falls through to the source stub.
    return new Response(source.body, {
      status: source.status,
      headers: source.contentType ? { "content-type": source.contentType } : {},
    });
  });
  return fetchFn;
}

function makeServices(fetchFn: typeof fetch, idCounter = { n: 0 }, baseTime = "2026-04-26T20:00:00.000Z"): Services {
  const start = Date.parse(baseTime);
  return {
    fetch: fetchFn,
    now: () => new Date(start + idCounter.n * 1000).toISOString(),
    newId: () => `rd_TEST${String(++idCounter.n).padStart(2, "0")}`,
  };
}

const TOKEN = "test-token";

beforeEach(() => {
  installVectorizeStub();
});
afterEach(clearBucket);

describe("GET /health", () => {
  it("returns 200 ok without auth", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("auth", () => {
  it("rejects /readings without bearer", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request("/readings", {}, env);
    expect(res.status).toBe(401);
  });

  it("rejects with wrong token", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/readings",
      { headers: { authorization: "Bearer wrong" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("accepts with correct token", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /readings + GET /readings/:id (submit-and-poll)", () => {
  it("returns 202 immediately and the manifest reaches ready after waitUntil settles", async () => {
    const fetchFn = makeStubFetch();
    const app = createApp({ services: makeServices(fetchFn) });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/article" }),
      }),
      env,
      ctx,
    );
    expect(submit.status).toBe(202);
    const submitJson = (await submit.json()) as { id: string; status: string };
    expect(submitJson.id).toMatch(/^rd_/);
    expect(submitJson.status).toBe("pending");

    await waitOnExecutionContext(ctx);

    const get = await app.request(
      `/readings/${submitJson.id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(get.status).toBe(200);
    const manifest = (await get.json()) as Record<string, unknown>;
    expect(manifest.status).toBe("ready");
    expect(manifest.title).toBe("Test Article");
    expect(manifest.tldr).toBe("A short summary.");
    expect(manifest.usage).toMatchObject({
      anthropic_input_tokens: 100,
      anthropic_output_tokens: 50,
      openai_embedding_tokens: 20,
    });
  });

  it("dedups: second POST with same URL returns the existing manifest, no second Vectorize upsert", async () => {
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const stub = installVectorizeStub();

    // wire the fresh stub through process-reading's SimilarityStore via env mutation
    void new SimilarityStore(env.READINGS_INDEX);

    const ctx1 = createExecutionContext();
    const r1 = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/dup" }),
      }),
      env,
      ctx1,
    );
    expect(r1.status).toBe(202);
    await waitOnExecutionContext(ctx1);

    const upsertsAfterFirst = stub.upsert.mock.calls.length;

    const ctx2 = createExecutionContext();
    const r2 = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/dup" }),
      }),
      env,
      ctx2,
    );
    expect(r2.status).toBe(200);
    await waitOnExecutionContext(ctx2);

    expect(stub.upsert.mock.calls.length).toBe(upsertsAfterFirst);
  });

  it("failure path: source returns 404 → manifest ends failed, no by-url pointer, error logged", async () => {
    const fetchFn = makeStubFetch({ source: { status: 404, body: "not found" } });
    const app = createApp({ services: makeServices(fetchFn) });
    const ctx = createExecutionContext();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/missing" }),
      }),
      env,
      ctx,
    );
    expect(submit.status).toBe(202);
    const { id } = (await submit.json()) as { id: string };
    await waitOnExecutionContext(ctx);

    const get = await app.request(
      `/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(get.status).toBe(200);
    const manifest = (await get.json()) as Record<string, unknown>;
    expect(manifest.status).toBe("failed");
    expect(manifest.error).toMatchObject({ code: "BadStatusError" });

    const lookup = await app.request(
      `/readings/lookup?url=${encodeURIComponent("https://example.com/missing")}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(lookup.status).toBe(404);

    // The background failure should be logged for the operator (wrangler tail),
    // not silently swallowed.
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("rejects an invalid url body", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/readings",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "not a url" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /readings/lookup", () => {
  it("returns the id for a known URL", async () => {
    const fetchFn = makeStubFetch();
    const app = createApp({ services: makeServices(fetchFn) });
    const ctx = createExecutionContext();
    await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/find-me" }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const res = await app.request(
      `/readings/lookup?url=${encodeURIComponent("https://example.com/find-me")}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string };
    expect(json.id).toMatch(/^rd_/);
  });

  it("returns 404 for an unknown URL", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      `/readings/lookup?url=${encodeURIComponent("https://example.com/nope")}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /readings/similar", () => {
  it("calls Vectorize and returns mapped items", async () => {
    const stub = installVectorizeStub();
    stub.vectors.set("rd_seed", {
      values: new Array(1536).fill(0.1),
      metadata: { url: "https://example.com/seed", title: "Seed", created_at: "2026-04-25T00:00:00.000Z" },
    });
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/readings/similar",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ query_embedding: new Array(1536).fill(0.1), k: 5 }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { items: Array<{ id: string; url: string }> };
    expect(json.items).toHaveLength(1);
    expect(json.items[0]!.id).toBe("rd_seed");
  });
});

describe("GET /readings — list with q, tag, offset, limit", () => {
  async function postOne(
    app: ReturnType<typeof createApp>,
    url: string,
  ): Promise<string> {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(202);
    const json = (await res.json()) as { id: string };
    await waitOnExecutionContext(ctx);
    return json.id;
  }

  it("returns the new response shape {readings, limit, offset, has_more}", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ readings: [], limit: 20, offset: 0, has_more: false });
  });

  it("POST /readings writes a pending index entry; processReading replaces it with ready", async () => {
    const fetchFn = makeStubFetch();
    const app = createApp({ services: makeServices(fetchFn) });
    const id = await postOne(app, "https://example.com/article-1");

    const list = await app.request(
      "/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { readings: Array<{ id: string; status: string }> };
    expect(body.readings).toHaveLength(1);
    expect(body.readings[0]!.id).toBe(id);
    expect(body.readings[0]!.status).toBe("ready");
  });

  it("failure path: index entry ends up failed", async () => {
    const fetchFn = makeStubFetch({ source: { status: 404, body: "not found" } });
    const app = createApp({ services: makeServices(fetchFn) });
    await postOne(app, "https://example.com/missing");

    const list = await app.request(
      "/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await list.json()) as { readings: Array<{ status: string; error?: { code: string } }> };
    expect(body.readings).toHaveLength(1);
    expect(body.readings[0]!.status).toBe("failed");
    expect(body.readings[0]!.error?.code).toBe("BadStatusError");
  });

  it("?q= filters across title, tldr, url (case-insensitive substring)", async () => {
    const idCounter = { n: 0 };
    const services = makeServices(
      makeStubFetch({
        toolInput: {
          title: "Rust async story",
          tldr: "How async works in Rust",
          tags: ["rust", "async"],
          keywords: [],
          people: [],
          orgs: [],
          novelty_verdict: "novel",
          connections: [],
          summary_markdown: "summary body",
        },
      }),
      idCounter,
    );
    const app = createApp({ services });
    await postOne(app, "https://example.com/rust");

    // Submit a second reading with different content via a fresh stub.
    const services2 = makeServices(
      makeStubFetch({
        toolInput: {
          title: "Go concurrency",
          tldr: "Goroutines",
          tags: ["go"],
          keywords: [],
          people: [],
          orgs: [],
          novelty_verdict: "novel",
          connections: [],
          summary_markdown: "summary body",
        },
      }),
      idCounter,
    );
    const app2 = createApp({ services: services2 });
    await postOne(app2, "https://example.com/go");

    const res = await app.request(
      "/readings?q=rust",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await res.json()) as { readings: Array<{ url: string }> };
    expect(body.readings).toHaveLength(1);
    expect(body.readings[0]!.url).toBe("https://example.com/rust");
  });

  it("?tag= filters by exact tag match (case-insensitive)", async () => {
    const idCounter = { n: 0 };
    const mkServices = (toolInput: Record<string, unknown>) =>
      makeServices(makeStubFetch({ toolInput }), idCounter);

    const app1 = createApp({
      services: mkServices({
        title: "AI piece",
        tldr: "About AI",
        tags: ["AI", "infra"],
        keywords: [],
        people: [],
        orgs: [],
        novelty_verdict: "novel",
        connections: [],
        summary_markdown: "summary body",
      }),
    });
    await postOne(app1, "https://example.com/ai");

    const app2 = createApp({
      services: mkServices({
        title: "ML piece",
        tldr: "About ML",
        tags: ["ml"],
        keywords: [],
        people: [],
        orgs: [],
        novelty_verdict: "novel",
        connections: [],
        summary_markdown: "summary body",
      }),
    });
    await postOne(app2, "https://example.com/ml");

    const res = await app1.request(
      "/readings?tag=ai",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await res.json()) as { readings: Array<{ url: string }> };
    expect(body.readings).toHaveLength(1);
    expect(body.readings[0]!.url).toBe("https://example.com/ai");
  });

  it("?q= and ?tag= AND together", async () => {
    const idCounter = { n: 0 };
    const mkServices = (toolInput: Record<string, unknown>) =>
      makeServices(makeStubFetch({ toolInput }), idCounter);

    const apps = [
      { url: "https://example.com/rust-ai", title: "Rust AI", tags: ["rust", "ai"] },
      { url: "https://example.com/rust-web", title: "Rust web", tags: ["rust"] },
      { url: "https://example.com/go-ai", title: "Go AI", tags: ["ai"] },
    ];
    for (const a of apps) {
      const app = createApp({
        services: mkServices({
          title: a.title,
          tldr: "x",
          tags: a.tags,
          keywords: [],
          people: [],
          orgs: [],
          novelty_verdict: "novel",
          connections: [],
          summary_markdown: "summary body",
        }),
      });
      await postOne(app, a.url);
    }

    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/readings?q=rust&tag=ai",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await res.json()) as { readings: Array<{ url: string }> };
    expect(body.readings.map((r) => r.url)).toEqual(["https://example.com/rust-ai"]);
  });

  it("offset+limit slices results and toggles has_more correctly", async () => {
    const idCounter = { n: 0 };
    for (let i = 0; i < 3; i++) {
      const app = createApp({ services: makeServices(makeStubFetch(), idCounter) });
      await postOne(app, `https://example.com/p${i}`);
    }
    const app = createApp({ services: makeServices(makeStubFetch()) });

    const page1 = await app.request(
      "/readings?offset=0&limit=2",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body1 = (await page1.json()) as {
      readings: unknown[];
      offset: number;
      limit: number;
      has_more: boolean;
    };
    expect(body1.readings).toHaveLength(2);
    expect(body1.offset).toBe(0);
    expect(body1.limit).toBe(2);
    expect(body1.has_more).toBe(true);

    const page2 = await app.request(
      "/readings?offset=2&limit=2",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body2 = (await page2.json()) as { readings: unknown[]; has_more: boolean };
    expect(body2.readings).toHaveLength(1);
    expect(body2.has_more).toBe(false);
  });

  it("rejects negative offset with 400", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/readings?offset=-1",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("staleness uses updated_at, not created_at", async () => {
    // Seed an index entry whose created_at is ancient but updated_at is fresh.
    // The staleness annotator must trust updated_at and leave it as pending
    // (matches the manifest-level annotateStale semantics).
    const reader = new (await import("../../src/modules/stores/reading-store")).ReadingStore(
      env.READINGS_BUCKET,
    );
    await reader.writeListIndex({
      version: 1,
      items: [
        {
          id: "rd_fresh",
          key_prefix: "readings/2020/01/01T000000Z-rd_fresh",
          url: "https://example.com/fresh",
          status: "pending",
          created_at: "2020-01-01T00:00:00.000Z",
          updated_at: "2026-04-26T20:00:00.000Z",
        },
      ],
    });
    const customEnv = { ...env, PENDING_TTL_SECONDS: "300" } as unknown as typeof env;
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const res = await app.request(
      "/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      customEnv,
    );
    const body = (await res.json()) as { readings: Array<{ status: string; error?: { code: string } }> };
    expect(body.readings).toHaveLength(1);
    expect(body.readings[0]!.status).toBe("pending");
  });

  it("staleness flips a long-stale pending to failed via updated_at", async () => {
    // updated_at older than TTL → annotator must mark it failed in the
    // response (the underlying manifest stays pending; this is presentation
    // only, same contract as the manifest-level annotateStale).
    const reader = new (await import("../../src/modules/stores/reading-store")).ReadingStore(
      env.READINGS_BUCKET,
    );
    await reader.writeListIndex({
      version: 1,
      items: [
        {
          id: "rd_stale",
          key_prefix: "readings/2020/01/01T000000Z-rd_stale",
          url: "https://example.com/stale",
          status: "pending",
          created_at: "2026-04-26T20:00:00.000Z",
          updated_at: "2020-01-01T00:00:00.000Z",
        },
      ],
    });
    const customEnv = { ...env, PENDING_TTL_SECONDS: "300" } as unknown as typeof env;
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const res = await app.request(
      "/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      customEnv,
    );
    const body = (await res.json()) as { readings: Array<{ status: string; error?: { code: string } }> };
    expect(body.readings).toHaveLength(1);
    expect(body.readings[0]!.status).toBe("failed");
    expect(body.readings[0]!.error?.code).toBe("stale_pending");
  });
});

describe("error handling", () => {
  it("returns a generic 500 (no internals leaked) when a route handler throws", async () => {
    const faultyBucket = {
      get: vi.fn(async () => {
        throw new Error("simulated R2 outage with internal stack info");
      }),
      put: vi.fn(),
      head: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    } as unknown as R2Bucket;
    const customEnv = { ...env, READINGS_BUCKET: faultyBucket } as unknown as typeof env;
    const app = createApp({ services: makeServices(makeStubFetch()) });

    // Route reaches into the bucket to look up the id pointer; the throw
    // should be caught by the router's onError and surfaced as a generic 500.
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request(
      "/readings/rd_DOES_NOT_EXIST",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      customEnv,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "internal" });
    // The underlying error message must NOT appear in the response body.
    const text = JSON.stringify(body);
    expect(text).not.toContain("simulated R2 outage");
    expect(text).not.toContain("stack");
    // But it should be logged for the operator to see.
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});

describe("CORS", () => {
  it("allows preflight from an allowed origin", async () => {
    const allowedEnv = { ...env, CORS_ALLOWED_ORIGINS: "https://allowed.example" } as unknown as typeof env;
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/readings",
      { method: "OPTIONS", headers: { origin: "https://allowed.example" } },
      allowedEnv,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
  });

  it("rejects preflight from a non-allowed origin", async () => {
    const allowedEnv = { ...env, CORS_ALLOWED_ORIGINS: "https://allowed.example" } as unknown as typeof env;
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/readings",
      { method: "OPTIONS", headers: { origin: "https://attacker.example" } },
      allowedEnv,
    );
    expect(res.status).toBe(403);
  });
});
