import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTenantId, type TenantContext } from "../../src/control-plane/ids";
import { dispatchQueueMessage, type Env } from "../../src/index";
import { DeferPaidWorkError } from "../../src/control-plane/processing-leases";
import {
  GLOBAL_USAGE_GUARD_NAME,
  PROCESSING_DEFER_DELAY_SECONDS,
  PROCESSING_DEFER_MAX_AGE_MS,
} from "../../src/control-plane/constants";
import { processReading, type ProcessReadingArgs, type ProcessReadingSource } from "../../src/process-reading";
import { RateLimitedError } from "../../src/modules/http-retry";
import { mintReadingId, sha256Hex, type Services } from "../../src/services";
import { buildKeyPrefix } from "../../src/modules/stores/reading-store";
import type { Manifest } from "../../src/schemas/manifest";
import { insertQuotaTenant, PUBLIC_LOOKUP, testReadingStore } from "../helpers/tenant-fixtures";

const HTML = `<!doctype html><html><head><title>Test Article</title></head><body>
<main><article><h1>Test Article</h1>
<p>This is a paragraph with enough words to be picked up by readability as the main content body of the article.</p>
<p>This is a second paragraph that adds more content so the article passes the readability character threshold.</p>
</article></main></body></html>`;

function installVectorizeStub(): void {
  (env as unknown as { READINGS_INDEX: VectorizeIndex }).READINGS_INDEX = {
    upsert: vi.fn(async () => ({ mutationId: "m" })),
    deleteByIds: vi.fn(async () => ({ mutationId: "m" })),
    query: vi.fn(async () => ({ count: 0, matches: [] })),
  } as unknown as VectorizeIndex;
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) {
    await env.READINGS_BUCKET.delete(obj.key);
  }
}

beforeEach(() => {
  installVectorizeStub();
});
afterEach(clearBucket);

function embeddingResponse(): Response {
  return new Response(
    JSON.stringify({
      data: [{ embedding: new Array(1536).fill(0.1) }],
      usage: { prompt_tokens: 10, total_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function summaryResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "resp_01",
      object: "response",
      status: "completed",
      output: [
        {
          id: "msg_01",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                title: "Test Article",
                tldr: "A short summary.",
                tags: ["test"],
                keywords: ["test", "article", "integration"],
                people: [],
                orgs: [],
                novelty_verdict: "novel",
                connections: [],
                summary_markdown: "summary body",
              }),
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 150,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeFetch(opts: {
  onEmbed?: () => Promise<Response> | Response;
} = {}): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://api.openai.com/v1/embeddings")) {
      if (opts.onEmbed) return opts.onEmbed();
      return embeddingResponse();
    }
    if (url.startsWith("https://api.openai.com/v1/responses")) return summaryResponse();
    return new Response(HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  });
}

function services(fetchFn: typeof fetch): Services {
  return {
    fetch: fetchFn,
    lookup: PUBLIC_LOOKUP,
    now: () => "2026-09-03T00:00:01.000Z",
    newId: mintReadingId,
  };
}

function tenantOf(tenantId: string): TenantContext {
  return { tenantId: parseTenantId(tenantId)! };
}

function embedCalls(fetchFn: ReturnType<typeof makeFetch>): number {
  return fetchFn.mock.calls.filter(([input]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return url.startsWith("https://api.openai.com/v1/embeddings");
  }).length;
}

function summaryCalls(fetchFn: ReturnType<typeof makeFetch>): number {
  return fetchFn.mock.calls.filter(([input]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return url.startsWith("https://api.openai.com/v1/responses");
  }).length;
}

function interceptDurableObjectFetch(
  binding: "GLOBAL_USAGE_GUARD" | "TENANT_USAGE_GUARD",
  handler: (body: Record<string, unknown>, next: () => Promise<Response>) => Promise<Response>,
): () => void {
  const orig = (env as unknown as Env)[binding]!;
  const realGet = orig.get.bind(orig);
  (env as unknown as Record<string, DurableObjectNamespace>)[binding] = {
    idFromName: orig.idFromName.bind(orig),
    get: (id: DurableObjectId) => {
      const stub = realGet(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const raw = typeof init?.body === "string" ? init.body : "{}";
          const body = JSON.parse(raw) as Record<string, unknown>;
          return handler(body, () => stub.fetch(input as never, init));
        },
      } as DurableObjectStub;
    },
  } as DurableObjectNamespace;
  return () => {
    (env as unknown as Record<string, DurableObjectNamespace>)[binding] = orig;
  };
}

function interceptGlobalLeaseFetch(
  handler: (body: Record<string, unknown>, next: () => Promise<Response>) => Promise<Response>,
): () => void {
  return interceptDurableObjectFetch("GLOBAL_USAGE_GUARD", handler);
}

function interceptTenantUsageFetch(
  handler: (body: Record<string, unknown>, next: () => Promise<Response>) => Promise<Response>,
): () => void {
  return interceptDurableObjectFetch("TENANT_USAGE_GUARD", handler);
}

// workers-pool isolated storage pops with 500 if an unawaited processReading is
// still in I/O when the test ends. vi.waitFor's 1s default also expires in CI
// before extract/lease acquire reach embed. Park on supplied markdown (skip URL
// extract) and wait with scheduler.wait so workerd can flush DO/R2 between polls.
const IN_FLIGHT_EMBED_TIMEOUT_MS = 15_000;
const PARKED_MARKDOWN: Extract<ProcessReadingSource, { kind: "markdown" }> = {
  kind: "markdown",
  markdown: "# Test Article\n\nIn-flight embed park fixture. Skips URL extract in the workers pool.",
  title: "Test Article",
};

async function waitForCondition(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + IN_FLIGHT_EMBED_TIMEOUT_MS;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error(`${label} (timed out after ${IN_FLIGHT_EMBED_TIMEOUT_MS}ms)`);
    }
    await scheduler.wait(25);
  }
}

function parkAtFirstEmbed(): {
  fetchFn: ReturnType<typeof makeFetch>;
  started: () => number;
  waitUntilStarted: () => Promise<void>;
  release: (value?: Response) => void;
} {
  let releaseEmbed!: (value: Response) => void;
  const firstEmbed = new Promise<Response>((resolve) => {
    releaseEmbed = resolve;
  });
  let embedStarted = 0;
  const fetchFn = makeFetch({
    onEmbed: () => {
      embedStarted += 1;
      if (embedStarted === 1) return firstEmbed;
      return embeddingResponse();
    },
  });
  return {
    fetchFn,
    started: () => embedStarted,
    waitUntilStarted: () =>
      waitForCondition(
        () => embedStarted === 1,
        `expected embedStarted to be 1, received ${embedStarted}`,
      ),
    release: (value = embeddingResponse()) => {
      releaseEmbed(value);
    },
  };
}

async function seedReading(
  tenant: TenantContext,
  opts: {
    id: string;
    url: string;
    attemptId: string;
    status?: Manifest["status"];
    source?: ProcessReadingSource;
  },
): Promise<ProcessReadingArgs> {
  const createdAt = "2026-09-03T00:00:00.000Z";
  const keyPrefix = buildKeyPrefix(opts.id, createdAt);
  const urlHash = await sha256Hex(opts.url);
  const reader = testReadingStore(env, tenant);
  const status = opts.status ?? "pending";
  const manifest: Manifest = {
    id: opts.id,
    url: opts.url,
    url_hash: urlHash,
    source_type: "url",
    status,
    active_attempt: {
      id: opts.attemptId,
      trigger: "submit",
      status: status === "pending" ? "running" : status === "ready" ? "succeeded" : "failed",
      stage: status === "pending" ? "queued" : "write_indexes",
      started_at: createdAt,
      ...(status === "pending" ? {} : { finished_at: createdAt }),
    },
    ...(status === "failed"
      ? { error: { code: "TestError", message: "seeded failure", retryable: true } }
      : {}),
    ...(status === "ready" ? { title: "Seeded", tldr: "Already done." } : {}),
    content_type: "application/octet-stream",
    content_status: status === "failed" ? "failed" : "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: createdAt,
    updated_at: createdAt,
  };
  await reader.writeManifest(keyPrefix, manifest);
  await reader.writeByIdPointer(opts.id, { id: opts.id, key_prefix: keyPrefix });
  await reader.writeByUrlPointer(urlHash, { id: opts.id, key_prefix: keyPrefix });
  return {
    id: opts.id,
    url: opts.url,
    urlHash,
    createdAt,
    keyPrefix,
    attemptId: opts.attemptId,
    attemptStartedAt: createdAt,
    trigger: "submit",
    email: false,
    ...(opts.source ? { source: opts.source } : {}),
  };
}

async function seedPending(
  tenant: TenantContext,
  opts: { id: string; url: string; attemptId: string; source?: ProcessReadingSource },
): Promise<ProcessReadingArgs> {
  return seedReading(tenant, opts);
}

async function tenantLease(
  tenantId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ns = (env as unknown as Env).TENANT_USAGE_GUARD!;
  const stub = ns.get(ns.idFromName(tenantId));
  const res = await stub.fetch("https://tenant-usage-guard/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function globalLease(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ns = (env as unknown as Env).GLOBAL_USAGE_GUARD!;
  const stub = ns.get(ns.idFromName(GLOBAL_USAGE_GUARD_NAME));
  const res = await stub.fetch("https://global-usage-guard/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function holdTenantLease(tenantId: string, attemptId: string, nowMs = Date.now()): Promise<Record<string, unknown>> {
  return tenantLease(tenantId, { kind: "acquire_lease", tenantId, attemptId, nowMs });
}

function fakeMessage(body: unknown): Message<unknown> {
  return {
    id: "m_1",
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<unknown>;
}

describe("processing leases (Workers pool)", () => {
  it("defers a second attempt when the tenant cap is 1 without draining pending", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 1,
    });
    const tenant = tenantOf(tenantId);
    expect(await holdTenantLease(tenantId, "at_holder")).toMatchObject({ ok: true });

    const fetchFn = makeFetch();
    const job = await seedPending(tenant, {
      id: "rd_LEASE_DEFER",
      url: "https://lease.test/defer",
      attemptId: "at_defer",
    });
    const sendDelayed = vi.fn(async () => {});
    const msg = fakeMessage({ version: 1, job });
    await dispatchQueueMessage(
      msg,
      () => processReading(job, env as unknown as Env, services(fetchFn), tenant),
      { sendDelayed },
    );

    expect(sendDelayed).toHaveBeenCalledOnce();
    expect(sendDelayed).toHaveBeenCalledWith(expect.anything(), PROCESSING_DEFER_DELAY_SECONDS);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(embedCalls(fetchFn)).toBe(0);
    await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
      status: "pending",
      active_attempt: { id: "at_defer" },
    });
  });

  it("duplicate delivery of the same in-flight attempt defers without a second embed", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 2,
    });
    const tenant = tenantOf(tenantId);
    const job = await seedPending(tenant, {
      id: "rd_LEASE_DUP",
      url: "https://lease.test/dup",
      attemptId: "at_dup",
      source: PARKED_MARKDOWN,
    });

    const parked = parkAtFirstEmbed();
    const svc = services(parked.fetchFn);
    const first = processReading(job, env as unknown as Env, svc, tenant);
    try {
      await parked.waitUntilStarted();
      const sendDelayed = vi.fn(async () => {});
      const msg = fakeMessage({ version: 1, job });
      await dispatchQueueMessage(
        msg,
        () => processReading(job, env as unknown as Env, svc, tenant),
        { sendDelayed },
      );
      expect(sendDelayed).toHaveBeenCalledOnce();
      expect(msg.ack).toHaveBeenCalledOnce();
      expect(msg.retry).not.toHaveBeenCalled();
      expect(parked.started()).toBe(1);
      await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
        status: "pending",
      });
    } finally {
      parked.release();
      await first.catch(() => {});
    }
  }, 20_000);

  it("already_running on a ready reading acks as done without requeue", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 1,
    });
    const tenant = tenantOf(tenantId);
    const job = await seedReading(tenant, {
      id: "rd_LEASE_DONE",
      url: "https://lease.test/done",
      attemptId: "at_done",
      status: "ready",
    });
    expect(await holdTenantLease(tenantId, "at_done")).toMatchObject({ ok: true });
    const fetchFn = makeFetch();
    const sendDelayed = vi.fn(async () => {});
    const msg = fakeMessage({ version: 1, job });
    await dispatchQueueMessage(
      msg,
      () => processReading(job, env as unknown as Env, services(fetchFn), tenant),
      { sendDelayed },
    );
    expect(sendDelayed).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(embedCalls(fetchFn)).toBe(0);
    await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("already_running on a failed reading acks as done without requeue", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 1,
    });
    const tenant = tenantOf(tenantId);
    const job = await seedReading(tenant, {
      id: "rd_LEASE_FAILDONE",
      url: "https://lease.test/faildone",
      attemptId: "at_faildone",
      status: "failed",
    });
    expect(await holdTenantLease(tenantId, "at_faildone")).toMatchObject({ ok: true });
    const fetchFn = makeFetch();
    const sendDelayed = vi.fn(async () => {});
    const msg = fakeMessage({ version: 1, job });
    await dispatchQueueMessage(
      msg,
      () => processReading(job, env as unknown as Env, services(fetchFn), tenant),
      { sendDelayed },
    );
    expect(sendDelayed).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(embedCalls(fetchFn)).toBe(0);
    await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("incomplete already_running defers instead of success-ack or markFailed", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 1,
    });
    const tenant = tenantOf(tenantId);
    expect(await holdTenantLease(tenantId, "at_duphold")).toMatchObject({ ok: true });
    const fetchFn = makeFetch();
    const job = await seedPending(tenant, {
      id: "rd_LEASE_DUPHOLD",
      url: "https://lease.test/duphold",
      attemptId: "at_duphold",
    });
    const sendDelayed = vi.fn(async () => {});
    const msg = fakeMessage({ version: 1, job });
    await dispatchQueueMessage(
      msg,
      () => processReading(job, env as unknown as Env, services(fetchFn), tenant),
      { sendDelayed },
    );
    expect(sendDelayed).toHaveBeenCalledOnce();
    expect(sendDelayed).toHaveBeenCalledWith(expect.anything(), PROCESSING_DEFER_DELAY_SECONDS);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(embedCalls(fetchFn)).toBe(0);
    await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
      status: "pending",
      active_attempt: { id: "at_duphold" },
    });
  });

  it("incomplete stale fence defers, releases leftover leases, and a retry can acquire", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 2,
    });
    const tenant = tenantOf(tenantId);
    const job = await seedPending(tenant, {
      id: "rd_LEASE_STALE",
      url: "https://lease.test/stale",
      attemptId: "at_stale",
      source: PARKED_MARKDOWN,
    });
    const parked = parkAtFirstEmbed();
    const sendDelayed = vi.fn(async () => {});
    const msg = fakeMessage({ version: 1, job });
    const dispatched = dispatchQueueMessage(
      msg,
      () => processReading(job, env as unknown as Env, services(parked.fetchFn), tenant),
      { sendDelayed },
    );
    try {
      await parked.waitUntilStarted();
      const tenantHeld = await holdTenantLease(tenantId, "at_stale");
      const globalHeld = await globalLease({
        kind: "acquire_lease",
        tenantId,
        attemptId: "at_stale",
        nowMs: Date.now(),
      });
      expect(tenantHeld).toMatchObject({ ok: true, already_running: true });
      expect(globalHeld).toMatchObject({ ok: true, already_running: true });
      // Drop only the tenant row so presentLease hits stale_fence without
      // touching global — the leftover in-flight global is what must be released.
      await tenantLease(tenantId, {
        kind: "release_lease",
        attemptId: "at_stale",
        fence: tenantHeld.fence,
        nowMs: Date.now(),
      });
      parked.release();
      await dispatched;
      expect(sendDelayed).toHaveBeenCalledOnce();
      expect(msg.ack).toHaveBeenCalledOnce();
      expect(msg.retry).not.toHaveBeenCalled();
      expect(parked.started()).toBe(1);
      await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
        status: "pending",
        active_attempt: { id: "at_stale" },
      });

      const retryTenant = await holdTenantLease(tenantId, "at_stale_retry");
      expect(retryTenant).toMatchObject({ ok: true, already_running: false });
      const leftoverGlobal = await globalLease({
        kind: "acquire_lease",
        tenantId,
        attemptId: "at_stale",
        nowMs: Date.now(),
      });
      expect(leftoverGlobal).toMatchObject({ ok: true, already_running: false });
      const retryGlobal = await globalLease({
        kind: "acquire_lease",
        tenantId,
        attemptId: "at_stale_retry",
        nowMs: Date.now(),
      });
      expect(retryGlobal).toMatchObject({ ok: true, already_running: false });
    } finally {
      parked.release();
      await dispatched.catch(() => {});
    }
  }, 20_000);

  it("paused expired lease does not block a later attempt", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 1,
    });
    const tenant = tenantOf(tenantId);
    const held = await holdTenantLease(tenantId, "at_expired", 1_000);
    expect(held).toMatchObject({ ok: true });
    expect(
      await tenantLease(tenantId, {
        kind: "pause_lease",
        attemptId: "at_expired",
        fence: held.fence,
        nowMs: 1_000,
      }),
    ).toMatchObject({ ok: true });

    const fetchFn = makeFetch();
    const job = await seedPending(tenant, {
      id: "rd_LEASE_EXP",
      url: "https://lease.test/exp",
      attemptId: "at_exp",
    });
    await processReading(job, env as unknown as Env, services(fetchFn), tenant);
    expect(embedCalls(fetchFn)).toBeGreaterThan(0);
    await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("in-flight lease past TTL still defers a later attempt", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 1,
    });
    const tenant = tenantOf(tenantId);
    expect(await holdTenantLease(tenantId, "at_inflight_old", 1_000)).toMatchObject({ ok: true });

    const fetchFn = makeFetch();
    const job = await seedPending(tenant, {
      id: "rd_LEASE_INFLIGHT",
      url: "https://lease.test/inflight",
      attemptId: "at_inflight_new",
    });
    const sendDelayed = vi.fn(async () => {});
    const msg = fakeMessage({ version: 1, job });
    await dispatchQueueMessage(
      msg,
      () => processReading(job, env as unknown as Env, services(fetchFn), tenant),
      { sendDelayed },
    );
    expect(sendDelayed).toHaveBeenCalledOnce();
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(embedCalls(fetchFn)).toBe(0);
    await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("foreign active_attempt drops without taking a lease", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 1,
    });
    const tenant = tenantOf(tenantId);
    const job = await seedPending(tenant, {
      id: "rd_LEASE_FOREIGN",
      url: "https://lease.test/foreign",
      attemptId: "at_NEW",
    });
    const fetchFn = makeFetch();
    await processReading(
      { ...job, attemptId: "at_OLD" },
      env as unknown as Env,
      services(fetchFn),
      tenant,
    );
    expect(embedCalls(fetchFn)).toBe(0);
    await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
      status: "pending",
      active_attempt: { id: "at_NEW" },
    });
    expect(await holdTenantLease(tenantId, "at_probe")).toMatchObject({ ok: true });
  });

  it("fail-closed missing DO defers instead of paid work", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 2,
    });
    const tenant = tenantOf(tenantId);
    const job = await seedPending(tenant, {
      id: "rd_LEASE_NODO",
      url: "https://lease.test/nodo",
      attemptId: "at_nodo",
    });
    const fetchFn = makeFetch();
    const orig = (env as unknown as Env).GLOBAL_USAGE_GUARD;
    (env as unknown as { GLOBAL_USAGE_GUARD?: DurableObjectNamespace }).GLOBAL_USAGE_GUARD = undefined;
    try {
      await expect(
        processReading(job, env as unknown as Env, services(fetchFn), tenant),
      ).rejects.toBeInstanceOf(DeferPaidWorkError);
    } finally {
      (env as unknown as { GLOBAL_USAGE_GUARD?: DurableObjectNamespace }).GLOBAL_USAGE_GUARD = orig;
    }
    expect(embedCalls(fetchFn)).toBe(0);
    await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
      status: "pending",
      active_attempt: { id: "at_nodo" },
    });
  });

  it("fail-closed missing tenant concurrency limit defers instead of paid work", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 2,
    });
    await env.CONTROL_PLANE.prepare("DELETE FROM tenant_limits WHERE tenant_id = ?").bind(tenantId).run();
    const tenant = tenantOf(tenantId);
    const job = await seedPending(tenant, {
      id: "rd_LEASE_NOLIMIT",
      url: "https://lease.test/nolimit",
      attemptId: "at_nolimit",
    });
    const fetchFn = makeFetch();
    await expect(
      processReading(job, env as unknown as Env, services(fetchFn), tenant),
    ).rejects.toBeInstanceOf(DeferPaidWorkError);
    expect(embedCalls(fetchFn)).toBe(0);
  });

  it("RateLimitedError retries without releasing the lease", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 1,
    });
    const tenant = tenantOf(tenantId);
    const firstJob = await seedPending(tenant, {
      id: "rd_LEASE_429",
      url: "https://lease.test/429",
      attemptId: "at_429",
    });
    const fetchFn = makeFetch({
      onEmbed: () =>
        new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
    });
    await expect(
      processReading(firstJob, env as unknown as Env, services(fetchFn), tenant),
    ).rejects.toBeInstanceOf(RateLimitedError);

    const retrySame = await holdTenantLease(tenantId, "at_429");
    expect(retrySame).toMatchObject({ ok: true, already_running: false });

    const secondFetch = makeFetch();
    const second = await seedPending(tenant, {
      id: "rd_LEASE_429B",
      url: "https://lease.test/429-b",
      attemptId: "at_429b",
    });
    await expect(
      processReading(second, env as unknown as Env, services(secondFetch), tenant),
    ).rejects.toBeInstanceOf(DeferPaidWorkError);
    expect(embedCalls(secondFetch)).toBe(0);
  });

  it("application error acks after terminal fail and releases the lease", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 1,
    });
    const tenant = tenantOf(tenantId);
    const firstJob = await seedPending(tenant, {
      id: "rd_LEASE_APP",
      url: "https://lease.test/app",
      attemptId: "at_app",
    });
    const fetchFn = makeFetch({
      onEmbed: () => {
        throw new Error("embed exploded");
      },
    });
    const msg = fakeMessage(firstJob);
    await dispatchQueueMessage(msg, () =>
      processReading(firstJob, env as unknown as Env, services(fetchFn), tenant),
    );
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    await expect(testReadingStore(env, tenant).readManifest(firstJob.keyPrefix)).resolves.toMatchObject({
      status: "failed",
    });

    const secondFetch = makeFetch();
    const second = await seedPending(tenant, {
      id: "rd_LEASE_APP2",
      url: "https://lease.test/app2",
      attemptId: "at_app2",
    });
    await processReading(second, env as unknown as Env, services(secondFetch), tenant);
    expect(embedCalls(secondFetch)).toBeGreaterThan(0);
    await expect(testReadingStore(env, tenant).readManifest(second.keyPrefix)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("lost global-acquire response then retry adopts the orphan and frees capacity", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 2,
    });
    const tenant = tenantOf(tenantId);
    const job = await seedPending(tenant, {
      id: "rd_LEASE_ORPHAN",
      url: "https://lease.test/orphan",
      attemptId: "at_orphan",
      source: PARKED_MARKDOWN,
    });
    // Persist-without-response: global row exists for this attempt, tenant does not.
    expect(
      await globalLease({
        kind: "acquire_lease",
        tenantId,
        attemptId: "at_orphan",
        nowMs: Date.parse("2026-09-03T00:00:01.000Z"),
      }),
    ).toMatchObject({ ok: true, already_running: false });
    const fetchFn = makeFetch();
    await processReading(job, env as unknown as Env, services(fetchFn), tenant);
    expect(embedCalls(fetchFn)).toBeGreaterThan(0);
    await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
      status: "ready",
    });
    expect(
      await globalLease({
        kind: "acquire_lease",
        tenantId,
        attemptId: "at_orphan_probe",
        nowMs: Date.parse("2026-09-03T00:00:01.000Z"),
      }),
    ).toMatchObject({ ok: true, already_running: false });
  });

  it("defers when a foreign live global occupies the cap", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 2,
    });
    const tenant = tenantOf(tenantId);
    const previous = await env.CONTROL_PLANE.prepare(
      "SELECT max_concurrent_work FROM system_policy WHERE id = 1",
    ).first<{ max_concurrent_work: number }>();
    await env.CONTROL_PLANE.prepare("UPDATE system_policy SET max_concurrent_work = 1 WHERE id = 1").run();
    let holderFence: string | undefined;
    try {
      const held = await globalLease({
        kind: "acquire_lease",
        tenantId,
        attemptId: "at_foreign_holder",
        nowMs: Date.parse("2026-09-03T00:00:01.000Z"),
      });
      expect(held).toMatchObject({ ok: true, already_running: false });
      holderFence = typeof held.fence === "string" ? held.fence : undefined;
      const fetchFn = makeFetch();
      const job = await seedPending(tenant, {
        id: "rd_LEASE_FOREIGN_G",
        url: "https://lease.test/foreign-g",
        attemptId: "at_foreign_job",
        source: PARKED_MARKDOWN,
      });
      const sendDelayed = vi.fn(async () => {});
      const msg = fakeMessage({ version: 1, job });
      await dispatchQueueMessage(
        msg,
        () => processReading(job, env as unknown as Env, services(fetchFn), tenant),
        { sendDelayed },
      );
      expect(sendDelayed).toHaveBeenCalledOnce();
      expect(msg.ack).toHaveBeenCalledOnce();
      expect(embedCalls(fetchFn)).toBe(0);
      await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
        status: "pending",
        active_attempt: { id: "at_foreign_job" },
      });
    } finally {
      if (holderFence) {
        await globalLease({
          kind: "release_lease",
          tenantId,
          attemptId: "at_foreign_holder",
          fence: holderFence,
          nowMs: Date.parse("2026-09-03T00:00:01.000Z"),
        });
      }
      await env.CONTROL_PLANE.prepare("UPDATE system_policy SET max_concurrent_work = ? WHERE id = 1")
        .bind(previous?.max_concurrent_work ?? 3)
        .run();
    }
  });

  it("does not re-pay summarize when lease unavailable hits after summarize succeeds", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 2,
    });
    const tenant = tenantOf(tenantId);
    const job = await seedPending(tenant, {
      id: "rd_LEASE_SKIP_SUM",
      url: "https://lease.test/skip-sum",
      attemptId: "at_skip_sum",
      source: PARKED_MARKDOWN,
    });
    const fetchFn = makeFetch();
    const svc = services(fetchFn);
    let globalRenews = 0;
    const restore = interceptGlobalLeaseFetch(async (body, next) => {
      if (body.kind === "renew_lease") {
        globalRenews += 1;
        if (globalRenews === 3) {
          return new Response(JSON.stringify({ ok: false, reason: "unavailable" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return next();
    });
    const sendDelayed = vi.fn(async () => {});
    const msg = fakeMessage({ version: 1, job });
    try {
      await dispatchQueueMessage(
        msg,
        () => processReading(job, env as unknown as Env, svc, tenant),
        { sendDelayed },
      );
      expect(sendDelayed).toHaveBeenCalledOnce();
      expect(summaryCalls(fetchFn)).toBe(1);
      expect(embedCalls(fetchFn)).toBe(1);
    } finally {
      restore();
    }
    await processReading(job, env as unknown as Env, svc, tenant);
    expect(summaryCalls(fetchFn)).toBe(1);
    expect(embedCalls(fetchFn)).toBe(2);
    await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("retries commit_reading on the cached summarize path after a swallowed first commit", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 1,
      max_concurrent_work: 2,
    });
    const tenant = tenantOf(tenantId);
    expect(
      await tenantLease(tenantId, {
        kind: "reserve_reading",
        tenantId,
        opId: "at_commit_skip",
        nowMs: Date.parse("2026-09-03T00:00:01.000Z"),
      }),
    ).toMatchObject({ ok: true });
    const job = await seedPending(tenant, {
      id: "rd_LEASE_COMMIT_SKIP",
      url: "https://lease.test/commit-skip",
      attemptId: "at_commit_skip",
      source: PARKED_MARKDOWN,
    });
    const fetchFn = makeFetch();
    const svc = services(fetchFn);
    let globalRenews = 0;
    let commitAttempts = 0;
    const restoreGlobal = interceptGlobalLeaseFetch(async (body, next) => {
      if (body.kind === "renew_lease") {
        globalRenews += 1;
        if (globalRenews === 3) {
          return new Response(JSON.stringify({ ok: false, reason: "unavailable" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return next();
    });
    const restoreTenant = interceptTenantUsageFetch(async (body, next) => {
      if (body.kind === "commit_reading") {
        commitAttempts += 1;
        if (commitAttempts === 1) {
          return new Response(JSON.stringify({ error: "simulated" }), { status: 500 });
        }
      }
      return next();
    });
    const sendDelayed = vi.fn(async () => {});
    const msg = fakeMessage({ version: 1, job });
    try {
      await dispatchQueueMessage(
        msg,
        () => processReading(job, env as unknown as Env, svc, tenant),
        { sendDelayed },
      );
      expect(sendDelayed).toHaveBeenCalledOnce();
      expect(summaryCalls(fetchFn)).toBe(1);
      expect(commitAttempts).toBe(1);
    } finally {
      restoreGlobal();
      restoreTenant();
    }
    await processReading(job, env as unknown as Env, svc, tenant);
    expect(summaryCalls(fetchFn)).toBe(1);
    await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
      status: "ready",
    });
    expect(
      await tenantLease(tenantId, { kind: "release_reading", opId: "at_commit_skip" }),
    ).toMatchObject({ ok: true });
    expect(
      await tenantLease(tenantId, {
        kind: "reserve_reading",
        tenantId,
        opId: "at_after_commit_skip",
        nowMs: Date.parse("2026-09-03T00:00:01.000Z"),
      }),
    ).toMatchObject({ ok: false, reason: "monthly" });
  });

  it("does not re-pay summarize when a neighbour is missing url metadata", async () => {
    (env as unknown as { READINGS_INDEX: VectorizeIndex }).READINGS_INDEX = {
      upsert: vi.fn(async () => ({ mutationId: "m" })),
      deleteByIds: vi.fn(async () => ({ mutationId: "m" })),
      query: vi.fn(async () => ({
        count: 1,
        matches: [{ id: "rd_NEIGHBOUR", score: 0.9, metadata: { title: "Neighbour" } }],
      })),
    } as unknown as VectorizeIndex;
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 2,
    });
    const tenant = tenantOf(tenantId);
    const job = await seedPending(tenant, {
      id: "rd_LEASE_SKIP_SUM_URL",
      url: "https://lease.test/skip-sum-url",
      attemptId: "at_skip_sum_url",
      source: PARKED_MARKDOWN,
    });
    const fetchFn = makeFetch();
    const svc = services(fetchFn);
    let globalRenews = 0;
    const restore = interceptGlobalLeaseFetch(async (body, next) => {
      if (body.kind === "renew_lease") {
        globalRenews += 1;
        if (globalRenews === 3) {
          return new Response(JSON.stringify({ ok: false, reason: "unavailable" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return next();
    });
    const sendDelayed = vi.fn(async () => {});
    const msg = fakeMessage({ version: 1, job });
    try {
      await dispatchQueueMessage(
        msg,
        () => processReading(job, env as unknown as Env, svc, tenant),
        { sendDelayed },
      );
      expect(sendDelayed).toHaveBeenCalledOnce();
      expect(summaryCalls(fetchFn)).toBe(1);
      await expect(
        testReadingStore(env, tenant).readProcessingCheckpoint(job.keyPrefix, "at_skip_sum_url"),
      ).resolves.toMatchObject({
        summarize: { similar_context: [{ id: "rd_NEIGHBOUR", url: "" }] },
      });
    } finally {
      restore();
    }
    await processReading(job, env as unknown as Env, svc, tenant);
    expect(summaryCalls(fetchFn)).toBe(1);
    expect(embedCalls(fetchFn)).toBe(2);
    await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("refreshes a held reading reservation on defer and commits quota after success", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 1,
      max_concurrent_work: 1,
    });
    const tenant = tenantOf(tenantId);
    expect(
      await tenantLease(tenantId, {
        kind: "reserve_reading",
        tenantId,
        opId: "at_quota",
        nowMs: Date.parse("2026-09-03T00:00:01.000Z"),
      }),
    ).toMatchObject({ ok: true });
    const blocker = await holdTenantLease(tenantId, "at_blocker");
    expect(blocker).toMatchObject({ ok: true, already_running: false });
    const job = await seedPending(tenant, {
      id: "rd_LEASE_QUOTA",
      url: "https://lease.test/quota",
      attemptId: "at_quota",
      source: PARKED_MARKDOWN,
    });
    const fetchFn = makeFetch();
    const sendDelayed = vi.fn(async () => {});
    const msg = fakeMessage({ version: 1, job });
    await dispatchQueueMessage(
      msg,
      () => processReading(job, env as unknown as Env, services(fetchFn), tenant),
      { sendDelayed },
    );
    expect(sendDelayed).toHaveBeenCalledOnce();
    expect(
      await tenantLease(tenantId, {
        kind: "reserve_reading",
        tenantId,
        opId: "at_other",
        nowMs: Date.parse("2026-09-03T00:00:01.000Z"),
      }),
    ).toMatchObject({ ok: false, reason: "monthly" });

    expect(
      await tenantLease(tenantId, {
        kind: "release_lease",
        attemptId: "at_blocker",
        fence: blocker.fence,
        nowMs: Date.parse("2026-09-03T00:00:01.000Z"),
      }),
    ).toMatchObject({ ok: true });

    await processReading(job, env as unknown as Env, services(fetchFn), tenant);
    await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
      status: "ready",
    });
    expect(
      await tenantLease(tenantId, {
        kind: "reserve_reading",
        tenantId,
        opId: "at_after",
        nowMs: Date.parse("2026-09-03T00:00:01.000Z"),
      }),
    ).toMatchObject({ ok: false, reason: "monthly" });
  });

  it("markFailed when a defer loop exceeds PROCESSING_DEFER_MAX_AGE_MS", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 1,
    });
    const tenant = tenantOf(tenantId);
    expect(await holdTenantLease(tenantId, "at_age_blocker")).toMatchObject({ ok: true });
    const job = await seedPending(tenant, {
      id: "rd_LEASE_AGE",
      url: "https://lease.test/age",
      attemptId: "at_age",
      source: PARKED_MARKDOWN,
    });
    job.attemptStartedAt = new Date(
      Date.parse("2026-09-03T00:00:01.000Z") - PROCESSING_DEFER_MAX_AGE_MS - 1,
    ).toISOString();
    const fetchFn = makeFetch();
    const sendDelayed = vi.fn(async () => {});
    const msg = fakeMessage({ version: 1, job });
    await dispatchQueueMessage(
      msg,
      () => processReading(job, env as unknown as Env, services(fetchFn), tenant),
      { sendDelayed },
    );
    expect(sendDelayed).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(embedCalls(fetchFn)).toBe(0);
    await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
      status: "failed",
      error: { code: "ProcessingDeferExpiredError" },
    });
  });

  it("keeps deferring when under PROCESSING_DEFER_MAX_AGE_MS", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 1,
    });
    const tenant = tenantOf(tenantId);
    expect(await holdTenantLease(tenantId, "at_under_blocker")).toMatchObject({ ok: true });
    const job = await seedPending(tenant, {
      id: "rd_LEASE_UNDER",
      url: "https://lease.test/under",
      attemptId: "at_under",
      source: PARKED_MARKDOWN,
    });
    const fetchFn = makeFetch();
    const sendDelayed = vi.fn(async () => {});
    const msg = fakeMessage({ version: 1, job });
    await dispatchQueueMessage(
      msg,
      () => processReading(job, env as unknown as Env, services(fetchFn), tenant),
      { sendDelayed },
    );
    expect(sendDelayed).toHaveBeenCalledOnce();
    expect(msg.ack).toHaveBeenCalledOnce();
    await expect(testReadingStore(env, tenant).readManifest(job.keyPrefix)).resolves.toMatchObject({
      status: "pending",
      active_attempt: { id: "at_under" },
    });
  });
});
