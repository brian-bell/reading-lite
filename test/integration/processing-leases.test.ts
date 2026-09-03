import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTenantId, type TenantContext } from "../../src/control-plane/ids";
import { dispatchQueueMessage, type Env } from "../../src/index";
import { DeferPaidWorkError } from "../../src/control-plane/processing-leases";
import { PROCESSING_DEFER_DELAY_SECONDS } from "../../src/control-plane/constants";
import { processReading, type ProcessReadingArgs } from "../../src/process-reading";
import { RateLimitedError } from "../../src/modules/http-retry";
import { mintReadingId, sha256Hex, type Services } from "../../src/services";
import { buildKeyPrefix } from "../../src/modules/stores/reading-store";
import type { Manifest } from "../../src/schemas/manifest";
import { insertQuotaTenant, testReadingStore } from "../helpers/tenant-fixtures";

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

async function seedPending(
  tenant: TenantContext,
  opts: { id: string; url: string; attemptId: string },
): Promise<ProcessReadingArgs> {
  const createdAt = "2026-09-03T00:00:00.000Z";
  const keyPrefix = buildKeyPrefix(opts.id, createdAt);
  const urlHash = await sha256Hex(opts.url);
  const reader = testReadingStore(env, tenant);
  const manifest: Manifest = {
    id: opts.id,
    url: opts.url,
    url_hash: urlHash,
    source_type: "url",
    status: "pending",
    active_attempt: {
      id: opts.attemptId,
      trigger: "submit",
      status: "running",
      stage: "queued",
      started_at: createdAt,
    },
    content_type: "application/octet-stream",
    content_status: "captured",
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
  };
}

async function holdTenantLease(tenantId: string, attemptId: string, nowMs = Date.now()): Promise<Record<string, unknown>> {
  const ns = (env as unknown as Env).TENANT_USAGE_GUARD!;
  const stub = ns.get(ns.idFromName(tenantId));
  const res = await stub.fetch("https://tenant-usage-guard/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "acquire_lease", tenantId, attemptId, nowMs }),
  });
  return (await res.json()) as Record<string, unknown>;
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

  it("duplicate delivery of the same attempt performs one paid dispatch", async () => {
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
    });

    let releaseEmbed!: (value: Response) => void;
    let embedStarted = 0;
    const fetchFn = makeFetch({
      onEmbed: () => {
        embedStarted += 1;
        if (embedStarted === 1) {
          return new Promise<Response>((resolve) => {
            releaseEmbed = resolve;
          });
        }
        return embeddingResponse();
      },
    });
    const svc = services(fetchFn);
    const first = processReading(job, env as unknown as Env, svc, tenant);
    await vi.waitFor(() => expect(embedStarted).toBe(1));
    await processReading(job, env as unknown as Env, svc, tenant);
    expect(embedStarted).toBe(1);
    releaseEmbed(embeddingResponse());
    await first;
  });

  it("expired lease does not block a later attempt", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
      max_concurrent_work: 1,
    });
    const tenant = tenantOf(tenantId);
    expect(await holdTenantLease(tenantId, "at_expired", 1_000)).toMatchObject({ ok: true });

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
});
