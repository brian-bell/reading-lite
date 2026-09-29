import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../../src/router";
import { type Env } from "../../src/index";
import {
  processReading,
  type ProcessReadingArgs,
} from "../../src/process-reading";
import {
  sha256Hex,
  type Services,
} from "../../src/services";
import { buildKeyPrefix } from "../../src/modules/stores/layout";
import { manifestToIndexItem } from "../../src/modules/stores/list-items";
import {
  founderTenant,
  reserveReadingSlot,
} from "../helpers/tenant-fixtures";
import { rowStore } from "../helpers/row-store";
import type { Manifest } from "../../src/schemas/manifest";
import {
  clearBucket,
  drainQueue,
  installQueueStub,
  installRejectingQueueStub,
  makeServices,
  makeStubFetch,
  queuedJobs,
  resendCalls,
  TOKEN,
} from "./readings-harness";

beforeEach(() => {
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

describe("POST /api/readings + GET /api/readings/:id (submit-and-poll)", () => {
  it("retrieves an X author's thread and uses it as the reading body", async () => {
    const baseFetch = makeStubFetch();
    const author = { id: "author-1", name: "Author Name", username: "author" };
    const root = {
      id: "100",
      text: "Root post",
      author_id: author.id,
      conversation_id: "100",
      created_at: "2026-04-26T12:00:00.000Z",
    };
    const child = {
      id: "200",
      text: "Thread continuation",
      author_id: author.id,
      conversation_id: "100",
      created_at: "2026-04-26T12:01:00.000Z",
      referenced_tweets: [{ type: "replied_to", id: "100" }],
    };
    const audience = {
      id: "300",
      text: "Audience text must stay out",
      author_id: "audience-1",
      conversation_id: "100",
      created_at: "2026-04-26T12:02:00.000Z",
      referenced_tweets: [{ type: "replied_to", id: "100" }],
    };
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.x.com/2/tweets/100?")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-x-token");
        return new Response(JSON.stringify({ data: root, includes: { users: [author] } }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://api.x.com/2/tweets/search/recent?")) {
        return new Response(
          JSON.stringify({
            data: [root, child, audience],
            includes: {
              users: [
                author,
                { id: "audience-1", name: "Audience", username: "audience" },
              ],
            },
            meta: {},
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return baseFetch(input, init);
    });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://x.com/author/status/100?s=46" }),
      }),
      env,
      ctx,
    );
    expect(submit.status).toBe(202);
    const { id } = (await submit.json()) as { id: string };

    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const manifestResponse = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const manifest = (await manifestResponse.json()) as {
      status: string;
      source_type: string;
      content_type: string;
    };
    expect(manifest).toMatchObject({
      status: "ready",
      source_type: "url",
      content_type: "application/json; charset=utf-8",
    });

    const content = await app.request(
      `/api/readings/${id}/content`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const markdown = await content.text();
    expect(markdown).toContain("# X thread by Author Name (@author)");
    expect(markdown).toContain("Root post");
    expect(markdown).toContain("Thread continuation");
    expect(markdown).not.toContain("Audience text must stay out");

    const summarizeCall = fetchFn.mock.calls.find(([input]) =>
      String(input).startsWith("https://api.openai.com/v1/responses"),
    );
    expect(String(summarizeCall?.[1]?.body)).toContain("Thread continuation");
  });

  // The provider's message is its own JSON error.message, with no status in
  // it, so the status has to travel as a field: 401 and 403 are what separate
  // a key problem from any other provider error for the reader. The key
  // fragment the provider echoes must not be stored or returned.
  it("records the provider's HTTP status on a summarize failure, without the echoed key", async () => {
    const message = "Incorrect API key provided: sk-test****1234. You can find your API key at https://platform.openai.com/account/api-keys.";
    const fetchFn = makeStubFetch({
      openaiResponses: { status: 401, body: { error: { message, type: "invalid_request_error", code: "invalid_api_key" } } },
    });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/rejected-key" }),
      }),
      env,
      ctx,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const get = await app.request(`/api/readings/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } }, env);
    const body = await get.json();
    expect(body).toMatchObject({
      status: "failed",
      error: {
        code: "OpenAIError",
        message: "Incorrect API key provided: [redacted key]. You can find your API key at https://platform.openai.com/account/api-keys.",
        stage: "summarize",
        http_status: 401,
        retryable: false,
      },
    });
    expect(JSON.stringify(body)).not.toContain("sk-test");
  });

  it("surfaces the recent-search window error on an old X reading", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.x.com/2/tweets/100?")) {
        return new Response(
          JSON.stringify({
            data: {
              id: "100",
              text: "Old root",
              author_id: "author-1",
              conversation_id: "100",
              created_at: "2026-04-18T12:00:00.000Z",
            },
            includes: {
              users: [{ id: "author-1", name: "Author Name", username: "author" }],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request after old-thread gate: ${url}`);
    });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://x.com/author/status/100" }),
      }),
      env,
      ctx,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const get = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const manifest = (await get.json()) as {
      status: string;
      error: { code: string; message: string; stage: string; retryable: boolean };
    };
    expect(manifest).toMatchObject({
      status: "failed",
      error: {
        code: "XThreadOutsideRecentWindowError",
        message:
          "This X thread is older than the 7-day recent-search window and cannot be imported.",
        stage: "fetch_source",
        retryable: false,
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("records a measured similarity snapshot on the terminal manifest", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });

    const submit = async (url: string) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request("http://t/api/readings", {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ url }),
        }),
        env,
        ctx,
      );
      await drainQueue(services);
      await waitOnExecutionContext(ctx);
      const { id } = (await res.json()) as { id: string };
      const detail = await app.fetch(
        new Request(`http://t/api/readings/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
        env,
        createExecutionContext(),
      );
      return (await detail.json()) as {
        id: string;
        status: string;
        similarity?: { count: number; max?: number; mean?: number; computed_at: string };
        connections_neighbourhood_ids?: string[];
      };
    };

    // First reading: nothing in the index yet, so the neighbourhood is empty.
    // That must be recorded as count 0 rather than a fabricated score, and as
    // an empty judged candidate set rather than omitting the baseline.
    const first = await submit("https://example.com/sim-first");
    expect(first.status).toBe("ready");
    expect(first.similarity?.count).toBe(0);
    expect(first.similarity?.max).toBeUndefined();
    expect(first.similarity?.computed_at).toEqual(expect.any(String));
    expect(first.connections_neighbourhood_ids).toEqual([]);

    // Second reading now has the first as a neighbour. The score is measured,
    // not scripted: both readings carry the stub embedding, so their cosine
    // similarity is 1.
    const second = await submit("https://example.com/sim-second");
    expect(second.similarity?.count).toBe(1);
    expect(second.similarity?.max).toBeCloseTo(1, 10);
    expect(second.similarity?.mean).toBeCloseTo(1, 10);
    expect(second.connections_neighbourhood_ids).toEqual([first.id]);
  });

  it("returns an old batch-owned pending reading without enqueueing realtime work", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = rowStore();
    const url = "https://example.com/offline-batch-pending";
    const urlHash = await sha256Hex(url);
    const pending: Manifest = {
      id: "rd_BATCH_PENDING",
      url,
      url_hash: urlHash,
      source_type: "markdown",
      status: "pending",
      active_attempt: {
        id: "batch_rd_BATCH_PENDING",
        trigger: "import",
        status: "running",
        stage: "summarize",
        started_at: "2026-04-26T18:00:00.000Z",
      },
      content_type: "text/markdown; charset=utf-8",
      content_status: "captured",
      content_bytes: 10,
      content_sha256: "b".repeat(64),
      created_at: "2026-04-26T18:00:00.000Z",
      updated_at: "2026-04-26T18:00:00.000Z",
    };
    const keyPrefix = buildKeyPrefix(pending.id, pending.created_at);
    await reader.writeManifest(keyPrefix, pending);
    await reader.writeByIdPointer(pending.id, { id: pending.id, key_prefix: keyPrefix });
    await reader.writeByUrlPointer(urlHash, { id: pending.id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(pending, keyPrefix));

    const customEnv = { ...env, PENDING_TTL_SECONDS: "300" } as unknown as typeof env;
    const response = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      customEnv,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: pending.id,
      status: "pending",
      active_attempt: { id: "batch_rd_BATCH_PENDING", status: "running" },
    });
    expect(queuedJobs).toHaveLength(0);
  });

  it("deduplicates Markdown imports for the same source URL while pending", async () => {
    const sourceUrl = "https://example.com/import-markdown-pending-dedupe";
    const markdown = "# Pending Import\n\nThis import has not been processed yet.";
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });

    const first = await app.fetch(
      new Request("http://t/api/readings/import-markdown", {
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
      new Request("http://t/api/readings/import-markdown", {
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

  it("imports Markdown over a failed URL reading for the same source URL", async () => {
    const sourceUrl = "https://example.com/failed-then-imported-markdown";
    const markdown = "# Imported Recovery\n\nThe user supplied the captured text.";
    const fetchFn = makeStubFetch({
      toolInput: {
        title: "Imported Recovery",
        tldr: "A failed URL was recovered with markdown.",
        tags: ["markdown"],
        keywords: ["markdown recovery", "failed reading", "manual import"],
        people: [],
        orgs: [],
        novelty_verdict: "novel",
        connections: [],
        summary_markdown: "Recovered summary",
      },
    });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const reader = rowStore();
    const urlHash = await sha256Hex(sourceUrl);
    const failed: Manifest = {
      id: "rd_0123456783",
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
      new Request("http://t/api/readings/import-markdown", {
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
      `/api/readings/${failed.id}`,
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
      `/api/readings/${failed.id}/content`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await content.text()).toBe(markdown);
  });

  it("imports Markdown over a stale pending URL reading for the same source URL", async () => {
    const sourceUrl = "https://example.com/stale-pending-then-imported-markdown";
    const markdown = "# Imported Stale Pending\n\nThe user supplied the captured text.";
    const fetchFn = makeStubFetch({
      toolInput: {
        title: "Imported Stale Pending",
        tldr: "A stale pending URL was recovered with markdown.",
        tags: ["markdown"],
        keywords: ["markdown recovery", "failed reading", "manual import"],
        people: [],
        orgs: [],
        novelty_verdict: "novel",
        connections: [],
        summary_markdown: "Recovered summary",
      },
    });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const reader = rowStore();
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
      new Request("http://t/api/readings/import-markdown", {
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

  it("rejects an invalid url body", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/api/readings",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "not a url" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("records started and succeeded events per stage on a successful run", async () => {
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
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

    // The persisted attempt's events list has both started and succeeded
    // entries per stage, so timings can be reasoned about in a post-mortem.
    const diag = await app.request(
      `/api/readings/${((await submit.json()) as { id: string }).id}/diagnostics`,
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
      new Request("http://t/api/readings", {
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
      new Request(`http://t/api/readings/${id}/reprocess`, {
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
      `/api/readings/${id}`,
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

  it("diagnostics returns attempt history and object inventory for a failure", async () => {
    const fetchFn = makeStubFetch({ source: { status: 404, body: "not found" } });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
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
      `/api/readings/${id}/diagnostics`,
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
    // The attempt history above is rows now, so it is no longer among the
    // objects; the source fetch failed, so nothing was captured either.
    expect(diagnostics.objects).toEqual([]);
    consoleErr.mockRestore();
  });

  it("rejects malformed and null reprocess bodies before enqueueing work", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });

    const malformed = await app.request(
      "/api/readings/rd_missing/reprocess",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: "{",
      },
      env,
    );
    expect(malformed.status).toBe(400);

    const nullBody = await app.request(
      "/api/readings/rd_missing/reprocess",
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
    const reader = rowStore();
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
      keywords: ["existing summary", "ready reading", "reprocess flow"],
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
      new Request(`http://t/api/readings/${staleReady.id}/reprocess`, {
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
          new Request("http://t/api/readings", {
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
      "/api/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await list.json()) as { readings: Array<{ status: string; url: string }> };
    expect(body.readings).toHaveLength(5);
    expect(body.readings.every((r) => r.status === "ready")).toBe(true);
  });
});

// A legacy failed reading (one written before by-url ownership) is recovered
// the same way whichever write path finds it: the request lands on the legacy
// id, the by-url pointer is rewritten to it, and one job is queued. Only the
// request shape and the queued trigger differ between the two routes.

describe("submit-time safe-url guard", () => {
  const CREDS_URL = "https://user:secretpass@example.com/creds";

  it("returns 400 unsupported_url for a userinfo url without claiming the slot", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: CREDS_URL }),
      }),
      env,
      ctx,
    );

    expect(submit.status).toBe(400);
    expect(await submit.json()).toMatchObject({
      error: expect.stringContaining("userinfo"),
      code: "unsupported_url",
    });
    expect(queuedJobs).toHaveLength(0);

    const lookup = await app.request(
      `/api/readings/lookup?url=${encodeURIComponent(CREDS_URL)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(lookup.status).toBe(404);
    await waitOnExecutionContext(ctx);
  });

  it("returns 400 unsupported_url for a loopback literal host", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "http://127.0.0.1/admin" }),
      }),
      env,
      ctx,
    );

    expect(submit.status).toBe(400);
    expect(await submit.json()).toMatchObject({ code: "unsupported_url" });
    expect(queuedJobs).toHaveLength(0);
    await waitOnExecutionContext(ctx);
  });

  it("returns 400 for a URL-backed reprocess of a ready userinfo reading and leaves it ready", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = rowStore();
    const urlHash = await sha256Hex(CREDS_URL);
    const createdAt = "2026-04-26T19:00:00.000Z";
    const id = "rd_CREDS_READY";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const ready: Manifest = {
      id,
      url: CREDS_URL,
      url_hash: urlHash,
      source_type: "url",
      status: "ready",
      content_type: "text/html; charset=utf-8",
      content_status: "captured",
      content_bytes: 10,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
    };
    await reader.writeManifest(keyPrefix, ready);
    await reader.writeByUrlPointer(urlHash, { id, key_prefix: keyPrefix });
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(ready, keyPrefix));

    const retry = await app.request(
      `/api/readings/${id}/reprocess`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
      createExecutionContext(),
    );

    expect(retry.status).toBe(400);
    expect(await retry.json()).toMatchObject({ code: "unsupported_url" });
    expect(queuedJobs).toHaveLength(0);

    const get = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await get.json()).toMatchObject({ id, status: "ready" });
  });

  it("still accepts import-markdown with a userinfo source_url because it is identity only", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const imported = await app.fetch(
      new Request("http://t/api/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ source_url: CREDS_URL, markdown: "# Imported\n\nbody" }),
      }),
      env,
      ctx,
    );

    expect(imported.status).toBe(202);
    expect(queuedJobs).toHaveLength(1);
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const { id } = (await imported.json()) as { id: string };
    const get = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await get.json()).toMatchObject({ url: CREDS_URL, status: "ready" });

    // The import owns the by-url slot; resubmitting the same userinfo URL
    // returns the existing manifest (200), not a 400.
    const resubmit = await app.request(
      "/api/readings",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: CREDS_URL }),
      },
      env,
      createExecutionContext(),
    );
    expect(resubmit.status).toBe(200);
    expect(await resubmit.json()).toMatchObject({ id, url: CREDS_URL, status: "ready" });
    expect(queuedJobs).toHaveLength(0);
  });
});

describe("POST /api/readings — email notifications", () => {
  it("fires one Resend email by default after a successful submit", async () => {
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
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
    expect(body.to).toBe("founder@test.example");
    expect(body.subject).toBe("Test Article");
    expect(body.html).toContain(`https://reading.test.example/readings/${id}`);
    expect(body.text).toContain("https://example.com/email-me");
    expect(body.text).toContain("A short summary.");

    const diagnostics = await app.request(
      `/api/readings/${id}/diagnostics`,
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
      new Request("http://t/api/readings", {
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
      new Request("http://t/api/readings", {
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
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const manifest = (await get.json()) as { status: string };
    expect(manifest.status).toBe("ready");

    const diagnostics = await app.request(
      `/api/readings/${id}/diagnostics`,
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

describe("POST /api/readings/:id/reprocess — email opt-in", () => {
  async function seedReady(
    services: Services,
    url: string,
    fetchFn: ReturnType<typeof makeStubFetch>,
  ): Promise<string> {
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const submit = await app.fetch(
      new Request("http://t/api/readings", {
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
        new Request(`http://t/api/readings/${id}/reprocess`, {
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

  it("emails on reprocess when body sets email:true, with or without force", async () => {
    const idCounter = { n: 0 };
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn, idCounter);
    const id = await seedReady(services, "https://example.com/loud-reprocess", fetchFn);

    const app = createApp({ services });
    let sent = 0;
    for (const body of [{ email: true }, { force: true, email: true }]) {
      const ctx = createExecutionContext();
      const retry = await app.fetch(
        new Request(`http://t/api/readings/${id}/reprocess`, {
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

      const calls = resendCalls(fetchFn);
      expect(calls).toHaveLength(++sent);
      const mail = JSON.parse(calls[sent - 1]![1]!.body as string) as { subject: string };
      expect(mail.subject).toBe("Test Article");
    }
  });
});

describe("processReading — backwards-compat for in-flight queue messages without `email`", () => {
  it("undefined email + trigger='submit' → fires email", async () => {
    const idCounter = { n: 0 };
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn, idCounter);
    const reader = rowStore();
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
    await reserveReadingSlot(env, founderTenant(), args);

    await processReading(args, env as unknown as Env, services, founderTenant());

    expect(resendCalls(fetchFn)).toHaveLength(1);
  });

  it("undefined email + trigger='reprocess' → no email", async () => {
    const idCounter = { n: 0 };
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn, idCounter);
    const reader = rowStore();
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

    await processReading(args, env as unknown as Env, services, founderTenant());

    expect(resendCalls(fetchFn)).toHaveLength(0);
  });
});
