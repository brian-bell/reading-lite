import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/router";
import type { Env } from "../../src/index";
import { processReading, type ProcessReadingArgs } from "../../src/process-reading";
import { sha256Hex, type Services } from "../../src/services";
import { SimilarityStore } from "../../src/modules/stores/similarity-store";
import {
  buildKeyPrefix,
  manifestToIndexItem,
  ReadingStore,
} from "../../src/modules/stores/reading-store";
import type { Manifest } from "../../src/schemas/manifest";

// Vectorize is stubbed in the env at the integration boundary because Miniflare
// has no native Vectorize emulator. We mutate env.READINGS_INDEX in-place per test.
type AnyMock = ReturnType<typeof vi.fn>;
function installVectorizeStub(): {
  upsert: AnyMock;
  query: AnyMock;
  deleteByIds: AnyMock;
  vectors: Map<string, { values: number[]; metadata: Record<string, unknown> }>;
} {
  const vectors = new Map<string, { values: number[]; metadata: Record<string, unknown> }>();
  const upsert = vi.fn(async (vs: VectorizeVector[]) => {
    for (const v of vs) {
      vectors.set(v.id, { values: v.values as number[], metadata: (v.metadata ?? {}) as Record<string, unknown> });
    }
    return { mutationId: "m" } as VectorizeAsyncMutation;
  });
  const deleteByIds = vi.fn(async (ids: string[]) => {
    for (const id of ids) vectors.delete(id);
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
    deleteByIds,
    query,
  } as unknown as VectorizeIndex;
  return { upsert, query, deleteByIds, vectors };
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) {
    await env.READINGS_BUCKET.delete(obj.key);
  }
}

// Production sends ProcessReadingArgs through Cloudflare Queues. Miniflare has
// no native queue emulator (and per CLAUDE.md adding the binding to
// wrangler.test.toml hangs the runtime), so we install a stub that captures
// `send()` calls and a `drainQueue(services)` helper runs the worker's queue
// handler logic for each captured message.
let queuedJobs: ProcessReadingArgs[] = [];
function installQueueStub(): ProcessReadingArgs[] {
  queuedJobs = [];
  (env as unknown as { READING_JOBS: Queue<ProcessReadingArgs> }).READING_JOBS = {
    send: vi.fn(async (msg: ProcessReadingArgs) => {
      queuedJobs.push(msg);
    }),
  } as unknown as Queue<ProcessReadingArgs>;
  return queuedJobs;
}

function installRejectingQueueStub(error: unknown = new Error("queue send failed")) {
  (env as unknown as { READING_JOBS: Queue<ProcessReadingArgs> }).READING_JOBS = {
    send: vi.fn(async () => {
      throw error;
    }),
  } as unknown as Queue<ProcessReadingArgs>;
}

async function drainQueue(services: Services): Promise<void> {
  while (queuedJobs.length > 0) {
    const msg = queuedJobs.shift()!;
    await processReading(msg, env as unknown as Env, services);
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
  resendStatus?: number;
  resendBody?: unknown;
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
    if (url.startsWith("https://api.resend.com/emails")) {
      const status = opts.resendStatus ?? 200;
      const body = opts.resendBody ?? { id: "resend_01" };
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

function resendCalls(fetchFn: ReturnType<typeof makeStubFetch>) {
  return fetchFn.mock.calls.filter(([input]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return url.startsWith("https://api.resend.com/emails");
  });
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
  installQueueStub();
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
  it("returns 202 immediately and the manifest reaches ready after the queue drains", async () => {
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn);
    const app = createApp({ services });
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

    await drainQueue(services);
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

    const diagnostics = await app.request(
      `/readings/${submitJson.id}/diagnostics`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(diagnostics.status).toBe(200);
    const diagnosticBody = (await diagnostics.json()) as {
      attempts: Array<{ status: string; finished_at?: string; events: Array<{ at: string }> }>;
    };
    const attempt = diagnosticBody.attempts[0]!;
    expect(attempt.status).toBe("succeeded");
    expect(attempt.finished_at).toBeDefined();
    const finishedAt = Date.parse(attempt.finished_at!);
    expect(attempt.events.every((event) => Date.parse(event.at) <= finishedAt)).toBe(true);
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
    await drainQueue(services);
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
    await drainQueue(services);
    await waitOnExecutionContext(ctx2);

    expect(stub.upsert.mock.calls.length).toBe(upsertsAfterFirst);
  });

  it("makes a new URL discoverable by lookup before processing finishes", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });

    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/pending-lookup" }),
      }),
      env,
      createExecutionContext(),
    );
    expect(submit.status).toBe(202);
    const submitJson = (await submit.json()) as { id: string };

    const lookup = await app.request(
      `/readings/lookup?url=${encodeURIComponent("https://example.com/pending-lookup")}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual({ id: submitJson.id });
  });

  it("returns the existing pending reading for a duplicate submit without enqueueing duplicate work", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const url = "https://example.com/pending-duplicate";

    const first = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );
    expect(first.status).toBe(202);
    const firstJson = (await first.json()) as { id: string };

    const second = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as Manifest;
    expect(secondJson.id).toBe(firstJson.id);
    expect(secondJson.status).toBe("pending");
    expect(queuedJobs).toHaveLength(1);
  });

  it("converges simultaneous submits of one URL to one reading and one queued job", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const url = "https://example.com/burst-same-url";

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.fetch(
          new Request("http://t/readings", {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({ url }),
          }),
          env,
          ctx,
        ),
      ),
    );
    expect(responses.every((r) => r.status === 200 || r.status === 202)).toBe(true);
    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<{ id: string }>),
    );
    expect(new Set(bodies.map((body) => body.id)).size).toBe(1);
    expect(queuedJobs).toHaveLength(1);

    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const list = await app.request(
      "/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await list.json()) as { readings: Array<{ id: string; status: string; url: string }> };
    expect(body.readings.filter((reading) => reading.url === url)).toEqual([
      expect.objectContaining({ id: bodies[0]!.id, status: "ready", url }),
    ]);
  });

  it("does not steal ownership while the winning submit has claimed the URL but not written its manifest", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const url = "https://example.com/claim-gap";
    let releaseManifestWrite!: () => void;
    let manifestWriteStarted!: () => void;
    const manifestWriteStartedPromise = new Promise<void>((resolve) => {
      manifestWriteStarted = resolve;
    });
    const releaseManifestWritePromise = new Promise<void>((resolve) => {
      releaseManifestWrite = resolve;
    });
    const originalPut = env.READINGS_BUCKET.put.bind(env.READINGS_BUCKET);
    let delayed = false;
    const putSpy = vi.spyOn(env.READINGS_BUCKET, "put").mockImplementation(
      async (...args: Parameters<R2Bucket["put"]>) => {
        const [key] = args;
        if (!delayed && key.endsWith("/manifest.json")) {
          delayed = true;
          manifestWriteStarted();
          await releaseManifestWritePromise;
        }
        return originalPut(...args);
      },
    );

    const first = app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );
    await manifestWriteStartedPromise;

    const second = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      error: "reading owner is still initializing",
      poll: expect.stringMatching(/^\/readings\/rd_/),
    });
    expect(queuedJobs).toHaveLength(0);

    releaseManifestWrite();
    const firstResponse = await first;
    expect(firstResponse.status).toBe(202);
    const firstBody = (await firstResponse.json()) as { id: string };
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]!.id).toBe(firstBody.id);
    putSpy.mockRestore();
  });

  it("resubmitting a failed URL reprocesses the same reading id", async () => {
    const fetchFn = makeStubFetch({ source: { status: 404, body: "not found" } });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const url = "https://example.com/retry-failed-submit";

    const first = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      ctx,
    );
    const { id } = (await first.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx);
    expect(queuedJobs).toHaveLength(0);

    const retry = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );
    expect(retry.status).toBe(202);
    const retryJson = (await retry.json()) as { id: string; status: string; attempt_id: string };
    expect(retryJson).toMatchObject({ id, status: "pending" });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id, trigger: "reprocess", email: true });

    const list = await app.request(
      "/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await list.json()) as { readings: Array<{ id: string; url: string }> };
    expect(body.readings.filter((reading) => reading.url === url)).toEqual([
      expect.objectContaining({ id, url }),
    ]);
    consoleErr.mockRestore();
  });

  it("claims and reprocesses a legacy failed reading that has no by-url pointer", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/legacy-failed-no-pointer";
    const urlHash = await sha256Hex(url);
    const createdAt = "2026-04-26T19:00:00.000Z";
    const id = "rd_LEGACY";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const legacy: Manifest = {
      id,
      url,
      url_hash: urlHash,
      source_type: "url",
      status: "failed",
      error: { code: "BadStatusError", message: "bad response status 404" },
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
    };
    await reader.writeManifest(keyPrefix, legacy);
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(legacy, keyPrefix));

    const retry = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );

    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ id, status: "pending" });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id, trigger: "reprocess", email: true });

    const lookup = await app.request(
      `/readings/lookup?url=${encodeURIComponent(url)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual({ id });
  });

  it("claims and reprocesses a legacy failed reading when index/list.json is missing", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/legacy-failed-no-index";
    const urlHash = await sha256Hex(url);
    const createdAt = "2026-04-26T19:00:00.000Z";
    const id = "rd_LEGACY_NO_INDEX";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const legacy: Manifest = {
      id,
      url,
      url_hash: urlHash,
      source_type: "url",
      status: "failed",
      error: { code: "BadStatusError", message: "bad response status 404" },
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
    };
    await reader.writeManifest(keyPrefix, legacy);
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });

    const retry = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );

    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ id, status: "pending" });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id, trigger: "reprocess", email: true });
  });

  it("claims the newest legacy failed reading when index/list.json has an older same-url row", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/legacy-stale-index";
    const urlHash = await sha256Hex(url);
    const older: Manifest = {
      id: "rd_OLDER",
      url,
      url_hash: urlHash,
      source_type: "url",
      status: "failed",
      error: { code: "old", message: "older failed copy" },
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T18:00:00.000Z",
      updated_at: "2026-04-26T18:00:00.000Z",
    };
    const newer: Manifest = {
      ...older,
      id: "rd_NEWER",
      error: { code: "new", message: "newer failed copy" },
      created_at: "2026-04-26T19:00:00.000Z",
      updated_at: "2026-04-26T19:00:00.000Z",
    };
    const olderPrefix = buildKeyPrefix(older.id, older.created_at);
    const newerPrefix = buildKeyPrefix(newer.id, newer.created_at);
    await reader.writeManifest(olderPrefix, older);
    await reader.writeManifest(newerPrefix, newer);
    await reader.writeByIdPointer(older.id, { id: older.id, key_prefix: olderPrefix });
    await reader.writeByIdPointer(newer.id, { id: newer.id, key_prefix: newerPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(older, olderPrefix));

    const retry = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );

    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ id: newer.id, status: "pending" });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id: newer.id, trigger: "reprocess" });
  });

  it("repairs a damaged by-url owner from a legacy failed reading missing from index/list.json", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/legacy-missing-from-index";
    const urlHash = await sha256Hex(url);
    const indexedUrl = "https://example.com/other-indexed-url";
    const legacy: Manifest = {
      id: "rd_MISSING_FROM_INDEX",
      url,
      url_hash: urlHash,
      source_type: "url",
      status: "failed",
      error: { code: "old", message: "failed copy missing from index" },
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T19:00:00.000Z",
      updated_at: "2026-04-26T19:00:00.000Z",
    };
    const indexed: Manifest = {
      ...legacy,
      id: "rd_INDEXED_OTHER",
      url: indexedUrl,
      url_hash: await sha256Hex(indexedUrl),
    };
    const legacyPrefix = buildKeyPrefix(legacy.id, legacy.created_at);
    const indexedPrefix = buildKeyPrefix(indexed.id, indexed.created_at);
    await reader.writeManifest(legacyPrefix, legacy);
    await reader.writeManifest(indexedPrefix, indexed);
    await reader.writeByIdPointer(legacy.id, { id: legacy.id, key_prefix: legacyPrefix });
    await reader.writeByIdPointer(indexed.id, { id: indexed.id, key_prefix: indexedPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(indexed, indexedPrefix));
    await reader.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    });

    const retry = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );

    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ id: legacy.id, status: "pending" });
    expect(await reader.readByUrlPointer(urlHash)).toEqual({
      id: legacy.id,
      key_prefix: legacyPrefix,
    });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id: legacy.id, trigger: "reprocess" });
  });

  it("repairs a stale by-url pointer whose manifest is missing", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/damaged-pointer";
    const urlHash = await sha256Hex(url);
    await reader.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    });

    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );

    expect(submit.status).toBe(202);
    const body = (await submit.json()) as { id: string; status: string };
    expect(body).toMatchObject({ status: "pending" });
    expect(body.id).not.toBe("rd_ORPHAN");
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id: body.id, trigger: "submit" });

    const lookup = await app.request(
      `/readings/lookup?url=${encodeURIComponent(url)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual({ id: body.id });
  });

  it("repairs a stale by-url pointer to an existing manifest for the URL", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/damaged-pointer-existing-manifest";
    const urlHash = await sha256Hex(url);
    await reader.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    });
    const legacy: Manifest = {
      id: "rd_EXISTING",
      url,
      url_hash: urlHash,
      source_type: "url",
      status: "failed",
      error: { code: "BadStatusError", message: "bad response status 404" },
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T19:10:00.000Z",
      updated_at: "2026-04-26T19:10:00.000Z",
    };
    const legacyPrefix = buildKeyPrefix(legacy.id, legacy.created_at);
    await reader.writeManifest(legacyPrefix, legacy);
    await reader.writeByIdPointer(legacy.id, { id: legacy.id, key_prefix: legacyPrefix });

    const retry = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );

    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ id: legacy.id, status: "pending" });
    expect(await reader.readByUrlPointer(urlHash)).toEqual({
      id: legacy.id,
      key_prefix: legacyPrefix,
    });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id: legacy.id, trigger: "reprocess" });
  });

  it("repairs a missing by-id pointer when a duplicate submit finds the by-url owner", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/missing-by-id-pointer";
    const urlHash = await sha256Hex(url);
    const id = "rd_MISSING_BY_ID";
    const keyPrefix = buildKeyPrefix(id, "2026-04-26T19:00:00.000Z");
    const manifest: Manifest = {
      id,
      url,
      url_hash: urlHash,
      source_type: "url",
      status: "ready",
      title: "Recovered",
      tldr: "Recovered summary",
      content_type: "text/html",
      content_status: "captured",
      content_bytes: 123,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T19:00:00.000Z",
      updated_at: "2026-04-26T19:00:00.000Z",
    };
    const pointer = { id, key_prefix: keyPrefix };
    await reader.writeByUrlPointer(urlHash, pointer);
    await reader.writeManifest(keyPrefix, manifest);

    const duplicate = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ id, status: "ready" });

    const get = await app.request(
      `/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ id, status: "ready" });
  });

  it("repairs a by-url pointer that points to a manifest for a different URL", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/mismatched-by-url-owner";
    const urlHash = await sha256Hex(url);
    const otherUrl = "https://example.com/other-owned-reading";
    const otherHash = await sha256Hex(otherUrl);
    const otherId = "rd_OTHER_OWNER";
    const otherPrefix = buildKeyPrefix(otherId, "2026-04-26T19:00:00.000Z");
    const otherManifest: Manifest = {
      id: otherId,
      url: otherUrl,
      url_hash: otherHash,
      source_type: "url",
      status: "ready",
      title: "Other",
      tldr: "Other summary",
      content_type: "text/html",
      content_status: "captured",
      content_bytes: 123,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T19:00:00.000Z",
      updated_at: "2026-04-26T19:00:00.000Z",
    };
    await reader.writeManifest(otherPrefix, otherManifest);
    await reader.writeByIdPointer(otherId, { id: otherId, key_prefix: otherPrefix });
    await reader.writeByUrlPointer(urlHash, { id: otherId, key_prefix: otherPrefix });

    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );

    expect(submit.status).toBe(202);
    const body = (await submit.json()) as { id: string; status: string };
    expect(body).toMatchObject({ status: "pending" });
    expect(body.id).not.toBe(otherId);
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id: body.id, trigger: "submit" });
    expect(await reader.readByUrlPointer(urlHash)).toMatchObject({ id: body.id });

    const other = await app.request(
      `/readings/${otherId}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ id: otherId, url: otherUrl });
  });

  it("does not treat a future-dated missing-manifest owner as fresh", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/future-dated-pointer";
    const urlHash = await sha256Hex(url);
    await reader.writeByUrlPointer(urlHash, {
      id: "rd_FUTURE",
      key_prefix: "readings/2026/04/26T210000Z-rd_FUTURE",
    });

    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );

    expect(submit.status).toBe(202);
    const body = (await submit.json()) as { id: string; status: string };
    expect(body).toMatchObject({ status: "pending" });
    expect(body.id).not.toBe("rd_FUTURE");
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id: body.id, trigger: "submit" });
  });

  it("does not let a stale successful job overwrite a newer by-url owner", async () => {
    const services = makeServices(makeStubFetch());
    const vector = installVectorizeStub();
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/stale-job-success";
    const urlHash = await sha256Hex(url);
    const ownerCreatedAt = "2026-04-26T19:59:00.000Z";
    const ownerPrefix = buildKeyPrefix("rd_OWNER", ownerCreatedAt);
    await reader.writeByUrlPointer(urlHash, {
      id: "rd_OWNER",
      key_prefix: ownerPrefix,
    });

    const staleId = "rd_STALE";
    const staleCreatedAt = "2026-04-26T19:00:00.000Z";
    const stalePrefix = buildKeyPrefix(staleId, staleCreatedAt);
    vector.vectors.set(staleId, {
      values: new Array(1536).fill(0.42),
      metadata: { url, title: "Old stale vector" },
    });
    await reader.appendOrReplaceListIndexItem({
      id: staleId,
      key_prefix: stalePrefix,
      url,
      status: "pending",
      created_at: staleCreatedAt,
      updated_at: staleCreatedAt,
    });
    await processReading(
      {
        id: staleId,
        url,
        urlHash,
        createdAt: staleCreatedAt,
        keyPrefix: stalePrefix,
        trigger: "submit",
      },
      env as unknown as Env,
      services,
    );

    await expect(reader.readByUrlPointer(urlHash)).resolves.toEqual({
      id: "rd_OWNER",
      key_prefix: ownerPrefix,
    });
    await expect(reader.readManifest(stalePrefix)).resolves.toMatchObject({
      id: staleId,
      status: "ready",
    });
    await expect(reader.readListIndex()).resolves.toMatchObject({ items: [] });
    expect(vector.upsert).not.toHaveBeenCalled();
    expect(vector.deleteByIds).toHaveBeenCalledWith([staleId]);
    expect(vector.vectors.has(staleId)).toBe(false);
  });

  it("does not let a stale successful attempt overwrite a newer attempt for the same reading", async () => {
    const services = makeServices(makeStubFetch());
    const vector = installVectorizeStub();
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/stale-same-reading-success";
    const urlHash = await sha256Hex(url);
    const id = "rd_SAME_READING";
    const createdAt = "2026-04-26T19:00:00.000Z";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const newerPending: Manifest = {
      id,
      url,
      url_hash: urlHash,
      source_type: "url",
      status: "pending",
      active_attempt: {
        id: "at_NEW",
        trigger: "submit",
        status: "running",
        stage: "fetch_source",
        started_at: "2026-04-26T19:30:00.000Z",
      },
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: "2026-04-26T19:30:00.000Z",
    };
    vector.vectors.set(id, {
      values: new Array(1536).fill(0.24),
      metadata: { url, title: "Existing vector" },
    });
    await reader.writeManifest(keyPrefix, newerPending);
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });
    await reader.writeByUrlPointer(urlHash, { id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(newerPending, keyPrefix));

    await processReading(
      {
        id,
        url,
        urlHash,
        createdAt,
        keyPrefix,
        attemptId: "at_OLD",
        attemptStartedAt: "2026-04-26T19:00:00.000Z",
        trigger: "submit",
      },
      env as unknown as Env,
      services,
    );

    await expect(reader.readManifest(keyPrefix)).resolves.toMatchObject({
      id,
      status: "pending",
      active_attempt: { id: "at_NEW" },
    });
    await expect(reader.readListIndex()).resolves.toMatchObject({
      items: [{ id, status: "pending", active_attempt: { id: "at_NEW" } }],
    });
    expect(vector.upsert).not.toHaveBeenCalled();
    expect(vector.deleteByIds).not.toHaveBeenCalled();
    expect(vector.vectors.has(id)).toBe(true);
  });

  it("does not let a stale failed job publish a newer by-url owner's URL", async () => {
    const services = makeServices(makeStubFetch({ source: { status: 404, body: "not found" } }));
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/stale-job-failure";
    const urlHash = await sha256Hex(url);
    const ownerCreatedAt = "2026-04-26T19:59:00.000Z";
    const ownerPrefix = buildKeyPrefix("rd_OWNER", ownerCreatedAt);
    await reader.writeByUrlPointer(urlHash, {
      id: "rd_OWNER",
      key_prefix: ownerPrefix,
    });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const staleId = "rd_STALE_FAILED";
    const staleCreatedAt = "2026-04-26T19:00:00.000Z";
    const stalePrefix = buildKeyPrefix(staleId, staleCreatedAt);
    await reader.appendOrReplaceListIndexItem({
      id: staleId,
      key_prefix: stalePrefix,
      url,
      status: "pending",
      created_at: staleCreatedAt,
      updated_at: staleCreatedAt,
    });
    await processReading(
      {
        id: staleId,
        url,
        urlHash,
        createdAt: staleCreatedAt,
        keyPrefix: stalePrefix,
        trigger: "submit",
      },
      env as unknown as Env,
      services,
    );

    await expect(reader.readByUrlPointer(urlHash)).resolves.toEqual({
      id: "rd_OWNER",
      key_prefix: ownerPrefix,
    });
    await expect(reader.readManifest(stalePrefix)).resolves.toMatchObject({
      id: staleId,
      status: "failed",
    });
    await expect(reader.readListIndex()).resolves.toMatchObject({ items: [] });
    consoleErr.mockRestore();
  });

  it("does not let a stale failed attempt overwrite a newer attempt for the same reading", async () => {
    const services = makeServices(makeStubFetch({ source: { status: 404, body: "not found" } }));
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/stale-same-reading-failure";
    const urlHash = await sha256Hex(url);
    const id = "rd_SAME_READING_FAILED";
    const createdAt = "2026-04-26T19:00:00.000Z";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const newerPending: Manifest = {
      id,
      url,
      url_hash: urlHash,
      source_type: "url",
      status: "pending",
      active_attempt: {
        id: "at_NEW_FAILED",
        trigger: "submit",
        status: "running",
        stage: "fetch_source",
        started_at: "2026-04-26T19:30:00.000Z",
      },
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: "2026-04-26T19:30:00.000Z",
    };
    await reader.writeManifest(keyPrefix, newerPending);
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });
    await reader.writeByUrlPointer(urlHash, { id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(newerPending, keyPrefix));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await processReading(
      {
        id,
        url,
        urlHash,
        createdAt,
        keyPrefix,
        attemptId: "at_OLD_FAILED",
        attemptStartedAt: "2026-04-26T19:00:00.000Z",
        trigger: "submit",
      },
      env as unknown as Env,
      services,
    );

    await expect(reader.readManifest(keyPrefix)).resolves.toMatchObject({
      id,
      status: "pending",
      active_attempt: { id: "at_NEW_FAILED" },
    });
    await expect(reader.readListIndex()).resolves.toMatchObject({
      items: [{ id, status: "pending", active_attempt: { id: "at_NEW_FAILED" } }],
    });
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("imports Markdown without fetching the source URL", async () => {
    const sourceUrl = "https://x.com/example/status/2047312986696454584";
    const markdown = "# Imported Markdown\n\nThis is already captured local content.";
    const fetchFn = makeStubFetch({
      toolInput: {
        title: "Imported Markdown",
        tldr: "A local Markdown article was imported.",
        tags: ["markdown"],
        keywords: ["local markdown"],
        people: [],
        orgs: [],
        novelty_verdict: "novel",
        connections: [],
        summary_markdown: "Imported summary",
      },
    });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Imported Markdown",
          markdown,
        }),
      }),
      env,
      ctx,
    );
    expect(submit.status).toBe(202);
    expect(queuedJobs[0]).toMatchObject({
      url: sourceUrl,
      trigger: "import",
      email: false,
      source: { kind: "markdown", title: "Imported Markdown", markdown },
    });

    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const { id } = (await submit.clone().json()) as { id: string };
    const get = await app.request(
      `/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const manifest = (await get.json()) as {
      status: string;
      source_type?: string;
      content_type: string;
      title?: string;
      last_attempt?: { trigger: string };
    };
    expect(manifest).toMatchObject({
      status: "ready",
      source_type: "markdown",
      content_type: "text/markdown; charset=utf-8",
      title: "Imported Markdown",
      last_attempt: { trigger: "import" },
    });

    const content = await app.request(
      `/readings/${id}/content`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await content.text()).toBe(markdown);

    const diagnostics = await app.request(
      `/readings/${id}/diagnostics`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const diagnosticBody = (await diagnostics.json()) as {
      attempts: Array<{ events: Array<{ stage: string }> }>;
    };
    const stages = diagnosticBody.attempts[0]!.events.map((event) => event.stage);
    expect(stages).toContain("prepare_markdown");
    expect(stages).not.toContain("fetch_source");

    const calledUrls = fetchFn.mock.calls.map(([input]) =>
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    expect(calledUrls).not.toContain(sourceUrl);
    expect(resendCalls(fetchFn)).toHaveLength(0);
  });

  it("deduplicates Markdown imports for the same source URL while pending", async () => {
    const sourceUrl = "https://example.com/import-markdown-pending-dedupe";
    const markdown = "# Pending Import\n\nThis import has not been processed yet.";
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });

    const first = await app.fetch(
      new Request("http://t/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Pending Import",
          markdown,
        }),
      }),
      env,
      createExecutionContext(),
    );
    const firstBody = (await first.json()) as { id: string; status: string };

    const second = await app.fetch(
      new Request("http://t/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Pending Import",
          markdown,
        }),
      }),
      env,
      createExecutionContext(),
    );
    const secondBody = (await second.json()) as { id: string; status: string };

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(secondBody).toMatchObject({ id: firstBody.id, status: "pending" });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id: firstBody.id, trigger: "import" });
  });

  it("repairs a stale missing by-url owner during Markdown import", async () => {
    const sourceUrl = "https://example.com/import-repairs-missing-owner";
    const markdown = "# Repaired Import\n\nThis import replaces a stale owner.";
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const urlHash = await sha256Hex(sourceUrl);
    await reader.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN_IMPORT",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN_IMPORT",
    });

    const submit = await app.fetch(
      new Request("http://t/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Repaired Import",
          markdown,
        }),
      }),
      env,
      createExecutionContext(),
    );
    const body = (await submit.json()) as { id: string; status: string };

    expect(submit.status).toBe(202);
    expect(body).toMatchObject({ status: "pending" });
    expect(body.id).not.toBe("rd_ORPHAN_IMPORT");
    expect(await reader.readByUrlPointer(urlHash)).toMatchObject({ id: body.id });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id: body.id, trigger: "import" });
  });

  it("imports Markdown over a failed URL reading for the same source URL", async () => {
    const sourceUrl = "https://example.com/failed-then-imported-markdown";
    const markdown = "# Imported Recovery\n\nThe user supplied the captured text.";
    const fetchFn = makeStubFetch({
      toolInput: {
        title: "Imported Recovery",
        tldr: "A failed URL was recovered with markdown.",
        tags: ["markdown"],
        keywords: ["recovery"],
        people: [],
        orgs: [],
        novelty_verdict: "novel",
        connections: [],
        summary_markdown: "Recovered summary",
      },
    });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const urlHash = await sha256Hex(sourceUrl);
    const failed: Manifest = {
      id: "rd_FAILED_IMPORT",
      url: sourceUrl,
      url_hash: urlHash,
      source_type: "url",
      status: "failed",
      error: { code: "BadStatusError", message: "bad response status 404" },
      content_type: "application/octet-stream",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T19:00:00.000Z",
      updated_at: "2026-04-26T19:00:00.000Z",
    };
    const keyPrefix = buildKeyPrefix(failed.id, failed.created_at);
    await reader.writeManifest(keyPrefix, failed);
    await reader.writeByIdPointer(failed.id, { id: failed.id, key_prefix: keyPrefix });
    await reader.writeByUrlPointer(urlHash, { id: failed.id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(failed, keyPrefix));

    const submit = await app.fetch(
      new Request("http://t/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Imported Recovery",
          markdown,
        }),
      }),
      env,
      createExecutionContext(),
    );

    expect(submit.status).toBe(202);
    expect(await submit.clone().json()).toMatchObject({
      id: failed.id,
      status: "pending",
    });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({
      id: failed.id,
      trigger: "import",
      source: { kind: "markdown", title: "Imported Recovery", markdown },
    });

    await drainQueue(services);

    const get = await app.request(
      `/readings/${failed.id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      id: failed.id,
      status: "ready",
      source_type: "markdown",
      title: "Imported Recovery",
      last_attempt: { trigger: "import" },
    });

    const content = await app.request(
      `/readings/${failed.id}/content`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await content.text()).toBe(markdown);
  });

  it("imports Markdown over a legacy failed reading that has no by-url pointer", async () => {
    const sourceUrl = "https://example.com/legacy-failed-import-markdown";
    const markdown = "# Legacy Import\n\nThe user supplied text for an old failed URL.";
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const urlHash = await sha256Hex(sourceUrl);
    const legacy: Manifest = {
      id: "rd_LEGACY_IMPORT",
      url: sourceUrl,
      url_hash: urlHash,
      source_type: "url",
      status: "failed",
      error: { code: "BadStatusError", message: "bad response status 404" },
      content_type: "application/octet-stream",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T19:00:00.000Z",
      updated_at: "2026-04-26T19:00:00.000Z",
    };
    const keyPrefix = buildKeyPrefix(legacy.id, legacy.created_at);
    await reader.writeManifest(keyPrefix, legacy);
    await reader.writeByIdPointer(legacy.id, { id: legacy.id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(legacy, keyPrefix));

    const submit = await app.fetch(
      new Request("http://t/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Legacy Import",
          markdown,
        }),
      }),
      env,
      createExecutionContext(),
    );

    expect(submit.status).toBe(202);
    expect(await submit.json()).toMatchObject({ id: legacy.id, status: "pending" });
    expect(await reader.readByUrlPointer(urlHash)).toEqual({
      id: legacy.id,
      key_prefix: keyPrefix,
    });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({
      id: legacy.id,
      trigger: "import",
      source: { kind: "markdown", title: "Legacy Import", markdown },
    });
  });

  it("imports Markdown over a legacy failed reading when the by-url pointer is damaged", async () => {
    const sourceUrl = "https://example.com/legacy-import-damaged-owner";
    const markdown = "# Legacy Damaged Owner\n\nThe user supplied text for the old failed URL.";
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const urlHash = await sha256Hex(sourceUrl);
    const legacy: Manifest = {
      id: "rd_LEGACY_DAMAGED_IMPORT",
      url: sourceUrl,
      url_hash: urlHash,
      source_type: "url",
      status: "failed",
      error: { code: "BadStatusError", message: "bad response status 404" },
      content_type: "application/octet-stream",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T19:00:00.000Z",
      updated_at: "2026-04-26T19:00:00.000Z",
    };
    const keyPrefix = buildKeyPrefix(legacy.id, legacy.created_at);
    await reader.writeManifest(keyPrefix, legacy);
    await reader.writeByIdPointer(legacy.id, { id: legacy.id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(legacy, keyPrefix));
    await reader.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN_IMPORT",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN_IMPORT",
    });

    const submit = await app.fetch(
      new Request("http://t/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Legacy Damaged Owner",
          markdown,
        }),
      }),
      env,
      createExecutionContext(),
    );

    expect(submit.status).toBe(202);
    expect(await submit.json()).toMatchObject({ id: legacy.id, status: "pending" });
    expect(await reader.readByUrlPointer(urlHash)).toEqual({
      id: legacy.id,
      key_prefix: keyPrefix,
    });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({
      id: legacy.id,
      trigger: "import",
      source: { kind: "markdown", title: "Legacy Damaged Owner", markdown },
    });
  });

  it("imports Markdown over a legacy failed reading missing from a stale list index", async () => {
    const sourceUrl = "https://example.com/legacy-import-stale-index";
    const markdown = "# Legacy Stale Index\n\nThe user supplied text for an unindexed old failed URL.";
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const urlHash = await sha256Hex(sourceUrl);
    const indexedUrl = "https://example.com/other-import-index-row";
    const legacy: Manifest = {
      id: "rd_LEGACY_IMPORT_STALE_INDEX",
      url: sourceUrl,
      url_hash: urlHash,
      source_type: "url",
      status: "failed",
      error: { code: "BadStatusError", message: "bad response status 404" },
      content_type: "application/octet-stream",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T19:00:00.000Z",
      updated_at: "2026-04-26T19:00:00.000Z",
    };
    const indexed: Manifest = {
      ...legacy,
      id: "rd_IMPORT_INDEXED_OTHER",
      url: indexedUrl,
      url_hash: await sha256Hex(indexedUrl),
    };
    const legacyPrefix = buildKeyPrefix(legacy.id, legacy.created_at);
    const indexedPrefix = buildKeyPrefix(indexed.id, indexed.created_at);
    await reader.writeManifest(legacyPrefix, legacy);
    await reader.writeManifest(indexedPrefix, indexed);
    await reader.writeByIdPointer(legacy.id, { id: legacy.id, key_prefix: legacyPrefix });
    await reader.writeByIdPointer(indexed.id, { id: indexed.id, key_prefix: indexedPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(indexed, indexedPrefix));
    await reader.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN_IMPORT_STALE_INDEX",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN_IMPORT_STALE_INDEX",
    });

    const submit = await app.fetch(
      new Request("http://t/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Legacy Stale Index",
          markdown,
        }),
      }),
      env,
      createExecutionContext(),
    );

    expect(submit.status).toBe(202);
    expect(await submit.json()).toMatchObject({ id: legacy.id, status: "pending" });
    expect(await reader.readByUrlPointer(urlHash)).toEqual({
      id: legacy.id,
      key_prefix: legacyPrefix,
    });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({
      id: legacy.id,
      trigger: "import",
      source: { kind: "markdown", title: "Legacy Stale Index", markdown },
    });
  });

  it("keeps markdown import retryable when queue send fails", async () => {
    const sourceUrl = "https://example.com/import-queue-send-fails";
    const markdown = "# Retryable Import\n\nThe markdown body should survive queue failure.";
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const urlHash = await sha256Hex(sourceUrl);
    const failed: Manifest = {
      id: "rd_IMPORT_QUEUE_FAIL",
      url: sourceUrl,
      url_hash: urlHash,
      source_type: "url",
      status: "failed",
      error: { code: "BadStatusError", message: "bad response status 404" },
      content_type: "application/octet-stream",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T19:00:00.000Z",
      updated_at: "2026-04-26T19:00:00.000Z",
    };
    const keyPrefix = buildKeyPrefix(failed.id, failed.created_at);
    await reader.writeManifest(keyPrefix, failed);
    await reader.writeByIdPointer(failed.id, { id: failed.id, key_prefix: keyPrefix });
    await reader.writeByUrlPointer(urlHash, { id: failed.id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(failed, keyPrefix));
    installRejectingQueueStub();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const importAttempt = await app.fetch(
      new Request("http://t/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Retryable Import",
          markdown,
        }),
      }),
      env,
      createExecutionContext(),
    );

    expect(importAttempt.status).toBe(503);
    const extracted = await reader.readExtracted(keyPrefix);
    expect(await extracted?.text()).toBe(markdown);

    installQueueStub();
    const retry = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: sourceUrl }),
      }),
      env,
      createExecutionContext(),
    );

    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ id: failed.id, status: "pending" });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({
      id: failed.id,
      trigger: "reprocess",
      source: { kind: "markdown", title: "Retryable Import", markdown },
    });
    consoleErr.mockRestore();
  });

  it("imports Markdown over a stale pending URL reading for the same source URL", async () => {
    const sourceUrl = "https://example.com/stale-pending-then-imported-markdown";
    const markdown = "# Imported Stale Pending\n\nThe user supplied the captured text.";
    const fetchFn = makeStubFetch({
      toolInput: {
        title: "Imported Stale Pending",
        tldr: "A stale pending URL was recovered with markdown.",
        tags: ["markdown"],
        keywords: ["recovery"],
        people: [],
        orgs: [],
        novelty_verdict: "novel",
        connections: [],
        summary_markdown: "Recovered summary",
      },
    });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const urlHash = await sha256Hex(sourceUrl);
    const stalePending: Manifest = {
      id: "rd_STALE_IMPORT",
      url: sourceUrl,
      url_hash: urlHash,
      source_type: "url",
      status: "pending",
      active_attempt: {
        id: "at_STALE",
        trigger: "submit",
        status: "running",
        stage: "fetch_source",
        started_at: "2026-04-26T18:00:00.000Z",
      },
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T18:00:00.000Z",
      updated_at: "2026-04-26T18:00:00.000Z",
    };
    const keyPrefix = buildKeyPrefix(stalePending.id, stalePending.created_at);
    await reader.writeManifest(keyPrefix, stalePending);
    await reader.writeByIdPointer(stalePending.id, {
      id: stalePending.id,
      key_prefix: keyPrefix,
    });
    await reader.writeByUrlPointer(urlHash, {
      id: stalePending.id,
      key_prefix: keyPrefix,
    });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(stalePending, keyPrefix));

    const customEnv = { ...env, PENDING_TTL_SECONDS: "300" } as unknown as typeof env;
    const submit = await app.fetch(
      new Request("http://t/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Imported Stale Pending",
          markdown,
        }),
      }),
      customEnv,
      createExecutionContext(),
    );

    expect(submit.status).toBe(202);
    expect(await submit.json()).toMatchObject({
      id: stalePending.id,
      status: "pending",
    });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({
      id: stalePending.id,
      trigger: "import",
      source: { kind: "markdown", title: "Imported Stale Pending", markdown },
    });
  });

  it("failure path: source returns 404 -> manifest ends failed with by-url ownership, error logged", async () => {
    const fetchFn = makeStubFetch({ source: { status: 404, body: "not found" } });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
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
    await drainQueue(services);
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
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual({ id });

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

  it("writes one attempt object per stage (not one per started/succeeded event) on a successful run", async () => {
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const putSpy = vi.spyOn(env.READINGS_BUCKET, "put");

    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/attempt-writes" }),
      }),
      env,
      ctx,
    );
    expect(submit.status).toBe(202);
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const attemptPuts = putSpy.mock.calls.filter(([key]) =>
      typeof key === "string" && key.includes("/attempts/"),
    ).length;
    // Initial queued + 10 stages (write_extracted included for HTML) + final
    // post-success write = 12. Pre-fix this was ~22 (started + finished per
    // stage). The exact upper bound below guards against regressing back to
    // started+finished writes for every stage.
    expect(attemptPuts).toBeLessThanOrEqual(13);

    // Diagnostic visibility must survive the de-amplification: the persisted
    // attempt's events list still has both started and succeeded entries per
    // stage so we can reason about timings during failure post-mortems.
    const diag = await app.request(
      `/readings/${((await submit.json()) as { id: string }).id}/diagnostics`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(diag.status).toBe(200);
    const body = (await diag.json()) as {
      attempts: Array<{ events: Array<{ stage: string; status: string }> }>;
    };
    const events = body.attempts[0]!.events;
    expect(events.some((e) => e.stage === "summarize" && e.status === "started")).toBe(true);
    expect(events.some((e) => e.stage === "summarize" && e.status === "succeeded")).toBe(true);

    putSpy.mockRestore();
  });

  it("returns 503 from POST /readings when the queue binding is missing", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    (env as unknown as { READING_JOBS?: Queue<ProcessReadingArgs> }).READING_JOBS =
      undefined;
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/no-queue" }),
      }),
      env,
      createExecutionContext(),
    );
    expect(submit.status).toBe(503);
    const body = (await submit.json()) as { error: string };
    expect(body.error).toMatch(/queue/i);
    const lookup = await app.request(
      `/readings/lookup?url=${encodeURIComponent("https://example.com/no-queue")}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(lookup.status).toBe(404);
    consoleErr.mockRestore();
  });

  it("marks a submit as retryable failed when queue send rejects after the pending write", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const url = "https://example.com/queue-send-reject";
    installRejectingQueueStub();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );

    expect(submit.status).toBe(503);
    const lookup = await app.request(
      `/readings/lookup?url=${encodeURIComponent(url)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(lookup.status).toBe(200);
    const { id } = (await lookup.json()) as { id: string };
    const failed = await app.request(
      `/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({
      id,
      status: "failed",
      error: { code: "QueueSendError", retryable: true },
    });

    installQueueStub();
    const retry = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ id, status: "pending" });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id, trigger: "reprocess" });
    consoleErr.mockRestore();
  });

  it("marks a failed reading retryable failed when reprocess queue send rejects", async () => {
    const idCounter = { n: 0 };
    const failingServices = makeServices(
      makeStubFetch({ source: { status: 404, body: "not found" } }),
      idCounter,
    );
    const failingApp = createApp({ services: failingServices });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await failingApp.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/reprocess-send-reject-failed" }),
      }),
      env,
      createExecutionContext(),
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(failingServices);

    installRejectingQueueStub();
    const retryingServices = makeServices(makeStubFetch(), idCounter);
    const retryingApp = createApp({ services: retryingServices });
    const retry = await retryingApp.fetch(
      new Request(`http://t/readings/${id}/reprocess`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      env,
      createExecutionContext(),
    );

    expect(retry.status).toBe(503);
    const get = await retryingApp.request(
      `/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const failed = (await get.json()) as Record<string, unknown>;
    expect(failed.active_attempt).toBeUndefined();
    expect(failed).toMatchObject({
      id,
      status: "failed",
      last_attempt: { status: "failed", error: { code: "QueueSendError", retryable: true } },
      error: { code: "QueueSendError", retryable: true },
    });
    consoleErr.mockRestore();
  });

  it("keeps a ready reading ready when reprocess queue send rejects", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/reprocess-send-reject-ready" }),
      }),
      env,
      createExecutionContext(),
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);

    installRejectingQueueStub();
    const retry = await app.fetch(
      new Request(`http://t/readings/${id}/reprocess`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      env,
      createExecutionContext(),
    );

    expect(retry.status).toBe(503);
    const get = await app.request(
      `/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const ready = (await get.json()) as Record<string, unknown>;
    expect(ready.active_attempt).toBeUndefined();
    expect(ready).toMatchObject({
      id,
      status: "ready",
      title: "Test Article",
      last_attempt: { status: "failed", error: { code: "QueueSendError", retryable: true } },
    });
    consoleErr.mockRestore();
  });

  it("returns 503 from reprocess when the queue binding is missing", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/will-reprocess" }),
      }),
      env,
      createExecutionContext(),
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);

    (env as unknown as { READING_JOBS?: Queue<ProcessReadingArgs> }).READING_JOBS =
      undefined;
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const retry = await app.fetch(
      new Request(`http://t/readings/${id}/reprocess`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      env,
      createExecutionContext(),
    );
    expect(retry.status).toBe(503);
    const body = (await retry.json()) as { error: string };
    expect(body.error).toMatch(/queue/i);
    consoleErr.mockRestore();
  });

  it("diagnostics returns attempt history and object inventory for a failure", async () => {
    const fetchFn = makeStubFetch({ source: { status: 404, body: "not found" } });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
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
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const res = await app.request(
      `/readings/${id}/diagnostics`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    const diagnostics = (await res.json()) as {
      attempts: Array<{ status: string; error?: { stage?: string } }>;
      pointers: { by_url: { exists: boolean } };
      objects: Array<{ key: string }>;
    };
    expect(diagnostics.attempts[0]!.status).toBe("failed");
    expect(diagnostics.attempts[0]!.error?.stage).toBe("fetch_source");
    expect(diagnostics.pointers.by_url.exists).toBe(true);
    expect(diagnostics.objects.some((o) => o.key.endsWith("/attempts/at_rd_TEST02.json"))).toBe(true);
    consoleErr.mockRestore();
  });

  it("reprocesses a failed reading in-place and updates it to ready", async () => {
    const idCounter = { n: 0 };
    const failingServices = makeServices(
      makeStubFetch({ source: { status: 404, body: "not found" } }),
      idCounter,
    );
    const failingApp = createApp({ services: failingServices });
    const ctx1 = createExecutionContext();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await failingApp.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/retry-me" }),
      }),
      env,
      ctx1,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(failingServices);
    await waitOnExecutionContext(ctx1);

    const succeedingServices = makeServices(makeStubFetch(), idCounter);
    const succeedingApp = createApp({ services: succeedingServices });
    const ctx2 = createExecutionContext();
    const retry = await succeedingApp.fetch(
      new Request(`http://t/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
      ctx2,
    );
    expect(retry.status).toBe(202);
    const retryJson = (await retry.json()) as { id: string; attempt_id: string };
    expect(retryJson.id).toBe(id);
    expect(retryJson.attempt_id).toMatch(/^at_/);
    await drainQueue(succeedingServices);
    await waitOnExecutionContext(ctx2);

    const get = await succeedingApp.request(
      `/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const manifest = (await get.json()) as { id: string; status: string; title?: string; last_attempt?: { trigger: string; status: string } };
    expect(manifest.id).toBe(id);
    expect(manifest.status).toBe("ready");
    expect(manifest.title).toBe("Test Article");
    expect(manifest.last_attempt).toMatchObject({ trigger: "reprocess", status: "succeeded" });
    consoleErr.mockRestore();
  });

  it("preserves a ready manifest when reprocess fails", async () => {
    const idCounter = { n: 0 };
    const services = makeServices(makeStubFetch(), idCounter);
    const app = createApp({ services });
    const ctx1 = createExecutionContext();
    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/stays-ready" }),
      }),
      env,
      ctx1,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx1);

    const failingServices = makeServices(
      makeStubFetch({ source: { status: 404, body: "not found" } }),
      idCounter,
    );
    const failingApp = createApp({ services: failingServices });
    const ctx2 = createExecutionContext();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = await failingApp.fetch(
      new Request(`http://t/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
      ctx2,
    );
    expect(retry.status).toBe(202);
    await drainQueue(failingServices);
    await waitOnExecutionContext(ctx2);

    const get = await failingApp.request(
      `/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const manifest = (await get.json()) as { status: string; title?: string; last_attempt?: { status: string; error?: { stage?: string } } };
    expect(manifest.status).toBe("ready");
    expect(manifest.title).toBe("Test Article");
    expect(manifest.last_attempt?.status).toBe("failed");
    expect(manifest.last_attempt?.error?.stage).toBe("fetch_source");
    consoleErr.mockRestore();
  });

  it("rejects reprocess when another attempt is active", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/active" }),
      }),
      env,
      ctx,
    );
    const { id } = (await submit.json()) as { id: string };

    // Deliberately do not drain — the reading must still look pending+running
    // when the reprocess request lands so that the 409 guard fires.
    const retry = await app.fetch(
      new Request(`http://t/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
      createExecutionContext(),
    );
    expect(retry.status).toBe(409);
    await drainQueue(services);
    await waitOnExecutionContext(ctx);
  });

  it("rejects malformed and null reprocess bodies before enqueueing work", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });

    const malformed = await app.request(
      "/readings/rd_missing/reprocess",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: "{",
      },
      env,
    );
    expect(malformed.status).toBe(400);

    const nullBody = await app.request(
      "/readings/rd_missing/reprocess",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: "null",
      },
      env,
    );
    expect(nullBody.status).toBe(400);
  });

  it("allows reprocess when a running active attempt is stale", async () => {
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const createdAt = "2026-04-26T18:00:00.000Z";
    const prefix = buildKeyPrefix("rd_STALE_ACTIVE", createdAt);
    const staleReady: Manifest = {
      id: "rd_STALE_ACTIVE",
      url: "https://example.com/stale-active",
      url_hash: "c".repeat(64),
      status: "ready",
      title: "Existing Ready",
      tldr: "Existing summary.",
      tags: ["ops"],
      keywords: [],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: "Existing summary.",
      content_type: "text/html",
      content_status: "captured",
      content_bytes: 1,
      content_sha256: "d".repeat(64),
      fetched_at: "2026-04-26T18:00:01.000Z",
      created_at: createdAt,
      updated_at: "2026-04-26T18:00:02.000Z",
      active_attempt: {
        id: "at_stale",
        trigger: "reprocess",
        status: "running",
        stage: "summarize",
        started_at: "2026-04-26T19:00:00.000Z",
      },
    };
    await reader.writeManifest(prefix, staleReady);
    await reader.writeByIdPointer(staleReady.id, { id: staleReady.id, key_prefix: prefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(staleReady, prefix));

    const idCounter = { n: 0 };
    const services = makeServices(makeStubFetch(), idCounter, "2026-04-26T20:00:00.000Z");
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const retry = await app.fetch(
      new Request(`http://t/readings/${staleReady.id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
      ctx,
    );

    expect(retry.status).toBe(202);
    await drainQueue(services);
    await waitOnExecutionContext(ctx);
  });

  it("a burst of 5 simultaneous submits all enqueue and drain to ready", async () => {
    const idCounter = { n: 0 };
    const services = makeServices(makeStubFetch(), idCounter);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        app.fetch(
          new Request("http://t/readings", {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({ url: `https://example.com/burst-${i}` }),
          }),
          env,
          ctx,
        ),
      ),
    );
    expect(responses.every((r) => r.status === 202)).toBe(true);
    expect(queuedJobs.length).toBe(5);

    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const list = await app.request(
      "/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await list.json()) as { readings: Array<{ status: string; url: string }> };
    expect(body.readings).toHaveLength(5);
    expect(body.readings.every((r) => r.status === "ready")).toBe(true);
  });
});

describe("POST /readings — email notifications", () => {
  it("fires one Resend email by default after a successful submit", async () => {
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/email-me" }),
      }),
      env,
      ctx,
    );
    expect(submit.status).toBe(202);
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const calls = resendCalls(fetchFn);
    expect(calls).toHaveLength(1);
    const init = calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-resend-key");
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(init.body as string) as {
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(body.from).toBe("reading-lite@test.example");
    expect(body.to).toBe("reader@test.example");
    expect(body.subject).toBe("Test Article");
    expect(body.html).toContain(`https://reading.test.example/readings/${id}`);
    expect(body.text).toContain("https://example.com/email-me");
    expect(body.text).toContain("A short summary.");

    const diagnostics = await app.request(
      `/readings/${id}/diagnostics`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const diag = (await diagnostics.json()) as {
      manifest: { status: string };
      attempts: Array<{ events: Array<{ stage: string; status: string }> }>;
    };
    expect(diag.manifest.status).toBe("ready");
    const events = diag.attempts[0]!.events;
    const sendEmail = events.find((e) => e.stage === "send_email");
    expect(sendEmail).toBeDefined();
    expect(sendEmail!.status).toBe("succeeded");
  });

  it("does not fire an email when the submit body sets email:false", async () => {
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/silent", email: false }),
      }),
      env,
      ctx,
    );
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    expect(resendCalls(fetchFn)).toHaveLength(0);
  });

  it("keeps the manifest ready when Resend returns 500 and logs a failed send_email event", async () => {
    const fetchFn = makeStubFetch({ resendStatus: 500, resendBody: { message: "boom" } });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/resend-down" }),
      }),
      env,
      ctx,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    // processReading must NOT throw on email failure; the manifest must remain ready.
    const get = await app.request(
      `/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const manifest = (await get.json()) as { status: string };
    expect(manifest.status).toBe("ready");

    const diagnostics = await app.request(
      `/readings/${id}/diagnostics`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const diag = (await diagnostics.json()) as {
      attempts: Array<{ status: string; events: Array<{ stage: string; status: string; error?: { code: string } }> }>;
    };
    const attempt = diag.attempts[0]!;
    expect(attempt.status).toBe("succeeded");
    const sendEmail = attempt.events.find((e) => e.stage === "send_email");
    expect(sendEmail).toBeDefined();
    expect(sendEmail!.status).toBe("failed");
    expect(sendEmail!.error?.code).toBe("ResendError");
    consoleErr.mockRestore();
  });
});

describe("POST /readings/:id/reprocess — email opt-in", () => {
  async function seedReady(
    services: Services,
    url: string,
    fetchFn: ReturnType<typeof makeStubFetch>,
  ): Promise<string> {
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const submit = await app.fetch(
      new Request("http://t/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url, email: false }),
      }),
      env,
      ctx,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx);
    expect(resendCalls(fetchFn)).toHaveLength(0);
    return id;
  }

  it("does not email by default on reprocess (force present, force absent)", async () => {
    const idCounter = { n: 0 };
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn, idCounter);
    const id = await seedReady(services, "https://example.com/silent-reprocess", fetchFn);

    const app = createApp({ services });
    for (const body of [{}, { force: true }]) {
      const ctx = createExecutionContext();
      const retry = await app.fetch(
        new Request(`http://t/readings/${id}/reprocess`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
        ctx,
      );
      expect(retry.status).toBe(202);
      await drainQueue(services);
      await waitOnExecutionContext(ctx);
    }
    expect(resendCalls(fetchFn)).toHaveLength(0);
  });

  it("emails on reprocess when body sets email:true", async () => {
    const idCounter = { n: 0 };
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn, idCounter);
    const id = await seedReady(services, "https://example.com/loud-reprocess", fetchFn);

    const app = createApp({ services });
    const ctx = createExecutionContext();
    const retry = await app.fetch(
      new Request(`http://t/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ email: true }),
      }),
      env,
      ctx,
    );
    expect(retry.status).toBe(202);
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const calls = resendCalls(fetchFn);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]![1]!.body as string) as { subject: string };
    expect(body.subject).toBe("Test Article");
  });

  it("emails on reprocess with both force:true and email:true", async () => {
    const idCounter = { n: 0 };
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn, idCounter);
    const id = await seedReady(services, "https://example.com/force-and-email", fetchFn);

    const app = createApp({ services });
    const ctx = createExecutionContext();
    const retry = await app.fetch(
      new Request(`http://t/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ force: true, email: true }),
      }),
      env,
      ctx,
    );
    expect(retry.status).toBe(202);
    await drainQueue(services);
    await waitOnExecutionContext(ctx);
    expect(resendCalls(fetchFn)).toHaveLength(1);
  });
});

describe("processReading — backwards-compat for in-flight queue messages without `email`", () => {
  it("undefined email + trigger='submit' → fires email", async () => {
    const idCounter = { n: 0 };
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn, idCounter);
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const id = "rd_PRE01";
    const createdAt = "2026-04-26T20:00:00.000Z";
    const prefix = buildKeyPrefix(id, createdAt);
    // Synthesize a pre-deploy queue message: email field absent.
    const args: ProcessReadingArgs = {
      id,
      url: "https://example.com/pre-deploy-submit",
      urlHash: "e".repeat(64),
      createdAt,
      keyPrefix: prefix,
      attemptId: "at_pre01",
      attemptStartedAt: createdAt,
      trigger: "submit",
    };
    await reader.writeManifest(prefix, {
      id,
      url: args.url,
      url_hash: args.urlHash,
      status: "pending",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
    });
    await reader.writeByIdPointer(id, { id, key_prefix: prefix });

    await processReading(args, env as unknown as Env, services);

    expect(resendCalls(fetchFn)).toHaveLength(1);
  });

  it("undefined email + trigger='reprocess' → no email", async () => {
    const idCounter = { n: 0 };
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn, idCounter);
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const id = "rd_PRE02";
    const createdAt = "2026-04-26T20:00:00.000Z";
    const prefix = buildKeyPrefix(id, createdAt);
    const args: ProcessReadingArgs = {
      id,
      url: "https://example.com/pre-deploy-reprocess",
      urlHash: "f".repeat(64),
      createdAt,
      keyPrefix: prefix,
      attemptId: "at_pre02",
      attemptStartedAt: createdAt,
      trigger: "reprocess",
    };
    await reader.writeManifest(prefix, {
      id,
      url: args.url,
      url_hash: args.urlHash,
      status: "pending",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
    });
    await reader.writeByIdPointer(id, { id, key_prefix: prefix });

    await processReading(args, env as unknown as Env, services);

    expect(resendCalls(fetchFn)).toHaveLength(0);
  });
});

describe("GET /readings/lookup", () => {
  it("returns the id for a known URL", async () => {
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn);
    const app = createApp({ services });
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
    await drainQueue(services);
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

  it("returns an empty result set when the Vectorize binding is absent (local dev)", async () => {
    // `wrangler dev` runs without a READINGS_INDEX binding (no local emulator).
    // The route must degrade to empty results, not throw a 500.
    delete (env as unknown as { READINGS_INDEX?: VectorizeIndex }).READINGS_INDEX;
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
    const json = (await res.json()) as { items: unknown[] };
    expect(json.items).toEqual([]);
  });
});

describe("GET /readings — list with q, tag, offset, limit", () => {
  async function postOne(
    app: ReturnType<typeof createApp>,
    url: string,
    services: Services,
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
    await drainQueue(services);
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
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const id = await postOne(app, "https://example.com/article-1", services);

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
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    await postOne(app, "https://example.com/missing", services);

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
    await postOne(app, "https://example.com/rust", services);

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
    await postOne(app2, "https://example.com/go", services2);

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

    const services1 = mkServices({
      title: "AI piece",
      tldr: "About AI",
      tags: ["AI", "infra"],
      keywords: [],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: "summary body",
    });
    const app1 = createApp({ services: services1 });
    await postOne(app1, "https://example.com/ai", services1);

    const services2 = mkServices({
      title: "ML piece",
      tldr: "About ML",
      tags: ["ml"],
      keywords: [],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: "summary body",
    });
    const app2 = createApp({ services: services2 });
    await postOne(app2, "https://example.com/ml", services2);

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
      const services = mkServices({
        title: a.title,
        tldr: "x",
        tags: a.tags,
        keywords: [],
        people: [],
        orgs: [],
        novelty_verdict: "novel",
        connections: [],
        summary_markdown: "summary body",
      });
      const app = createApp({ services });
      await postOne(app, a.url, services);
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
      const services = makeServices(makeStubFetch(), idCounter);
      const app = createApp({ services });
      await postOne(app, `https://example.com/p${i}`, services);
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
