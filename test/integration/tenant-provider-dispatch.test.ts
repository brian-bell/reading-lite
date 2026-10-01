import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProviderKeySecret } from "../../src/control-plane/crypto";
import {
  deleteProviderCredentials,
  markProviderCredentialInvalid,
  readProviderCredential,
  upsertProviderCredential,
} from "../../src/control-plane/provider-credentials";
import { updateProviderPreferences } from "../../src/control-plane/provider-settings";
import { dispatchQueueMessage, type Env } from "../../src/index";
import { RateLimitedError } from "../../src/modules/http-retry";
import { buildKeyPrefix } from "../../src/modules/stores/layout";
import { processReading, type ProcessReadingArgs } from "../../src/process-reading";
import type { Manifest } from "../../src/schemas/manifest";
import { mintReadingId, sha256Hex, type Services } from "../../src/services";
import { testControlPlane } from "../helpers/control-plane-db";
import { testReadingsFor } from "../helpers/test-readings";
import { insertQuotaTenant, PUBLIC_LOOKUP, reserveReadingSlot } from "../helpers/tenant-fixtures";
import { parseTenantId, type TenantContext } from "../../src/control-plane/ids";
import { createApp } from "../../src/router";
import { installQueueStub } from "./readings-harness";

const SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const DEPLOYMENT = "sk-deployment-do-not-send";
const MARKDOWN = "# Test Article\n\nA paragraph long enough to embed and summarize without fetching a URL.";
const createdAt = "2026-09-28T00:00:00.000Z";

function embeddingResponse(): Response {
  return Response.json({
    data: [{ embedding: new Array(1536).fill(0.1) }],
    usage: { prompt_tokens: 10, total_tokens: 10 },
  });
}

function summaryResponse(): Response {
  return Response.json({
    id: "resp_01",
    object: "response",
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      content: [{
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
      }],
    }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 150,
    },
  });
}

function runtime(): Env {
  return {
    ...env,
    TENANT_PROVIDER_KEYS: "1",
    PROVIDER_KEY_SECRET: SECRET,
    OPENAI_API_KEY: DEPLOYMENT,
    ANTHROPIC_API_KEY: "sk-anthropic-deployment",
    SUMMARIZER_PROVIDER: "anthropic",
    OPENAI_SUMMARIZATION_MODEL: "gpt-5.6-terra",
    OPENAI_SUMMARIZATION_REASONING_EFFORT: "low",
    RETRY_MAX_ATTEMPTS: "2",
    RETRY_BASE_DELAY_MS: "0",
    RETRY_MAX_DELAY_MS: "0",
  } as Env;
}

function services(fetchFn: typeof fetch): Services {
  return { fetch: fetchFn, lookup: PUBLIC_LOOKUP, now: () => "2026-09-28T00:00:01.000Z", newId: mintReadingId };
}

async function seed(tenant: TenantContext, url: string): Promise<ProcessReadingArgs> {
  const id = mintReadingId();
  const attemptId = `at_${id}`;
  const keyPrefix = buildKeyPrefix(id, createdAt);
  const urlHash = await sha256Hex(url);
  const manifest: Manifest = {
    id,
    url,
    url_hash: urlHash,
    source_type: "markdown",
    status: "pending",
    active_attempt: {
      id: attemptId,
      trigger: "submit",
      status: "running",
      stage: "queued",
      started_at: createdAt,
    },
    content_type: "text/markdown",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: createdAt,
    updated_at: createdAt,
  };
  await testReadingsFor(tenant).seed(manifest, { keyPrefix });
  const job: ProcessReadingArgs = {
    id,
    url,
    urlHash,
    createdAt,
    keyPrefix,
    attemptId,
    attemptStartedAt: createdAt,
    trigger: "submit",
    email: false,
    source: { kind: "markdown", markdown: MARKDOWN, title: "Test Article" },
  };
  await reserveReadingSlot(env, tenant, job);
  return job;
}

async function storeKey(tenantId: string, plaintext: string): Promise<void> {
  await upsertProviderCredential(testControlPlane(env), {
    tenantId,
    plaintext,
    root: { secret: parseProviderKeySecret(SECRET), version: 1 },
    nowMs: Date.parse(createdAt),
    validatedAtMs: Date.parse(createdAt),
  });
}

function authOf(init: RequestInit | undefined): string {
  return new Headers(init?.headers).get("authorization") ?? "";
}

afterEach(() => vi.restoreAllMocks());

describe("tenant provider key dispatch", () => {
  it("sends each tenant's own key through an HTTP retry and leaves it out of logs, checkpoints, and attempt rows", async () => {
    const first = await insertQuotaTenant(env as unknown as Env, { submissions_per_hour: 100, monthly_readings: 100 });
    const second = await insertQuotaTenant(env as unknown as Env, { submissions_per_hour: 100, monthly_readings: 100 });
    const keyA = "sk-tenant-a-aaaa";
    const keyB = "sk-tenant-b-bbbb";
    await storeKey(first.tenantId, keyA);
    await storeKey(second.tenantId, keyB);
    const logged: string[] = [];
    for (const method of ["info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    const seen: string[][] = [];
    async function run(tenantId: string, url: string): Promise<void> {
      const auths: string[] = [];
      let embeds = 0;
      const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
        const target = String(input);
        auths.push(authOf(init));
        if (!target.startsWith("https://api.openai.com/")) throw new Error(`unexpected ${target}`);
        if (target.startsWith("https://api.openai.com/v1/embeddings")) {
          embeds += 1;
          if (embeds === 1) return new Response("unavailable", { status: 500 });
          return embeddingResponse();
        }
        return summaryResponse();
      });
      const tenant = { tenantId: parseTenantId(tenantId)! };
      await processReading(await seed(tenant, url), runtime(), services(fetchFn), tenant);
      seen.push(auths);
    }
    await run(first.tenantId, "https://tenant-a.example/article");
    await run(second.tenantId, "https://tenant-b.example/article");
    expect(seen[0]).toEqual([
      "Bearer sk-tenant-a-aaaa",
      "Bearer sk-tenant-a-aaaa",
      "Bearer sk-tenant-a-aaaa",
      "Bearer sk-tenant-a-aaaa",
    ]);
    expect(seen[1]).toEqual([
      "Bearer sk-tenant-b-bbbb",
      "Bearer sk-tenant-b-bbbb",
      "Bearer sk-tenant-b-bbbb",
      "Bearer sk-tenant-b-bbbb",
    ]);
    const durable = logged.join("\n");
    expect(durable).not.toContain(keyA);
    expect(durable).not.toContain(keyB);
    expect(durable).not.toContain(DEPLOYMENT);
    for (const tenantId of [first.tenantId, second.tenantId]) {
      const row = await testControlPlane(env).first<{ checkpoint: string | null; error: string | null; events: string }>(
        `SELECT checkpoint::text AS checkpoint, error::text AS error, events::text AS events
         FROM reading_attempts WHERE tenant_id = ? ORDER BY started_at DESC LIMIT 1`,
        tenantId,
      );
      const text = `${row?.checkpoint ?? ""} ${row?.error ?? ""} ${row?.events ?? ""}`;
      expect(text).not.toContain(keyA);
      expect(text).not.toContain(keyB);
      expect(text).not.toContain(DEPLOYMENT);
    }
  });

  it("fails the attempt when the switch is on and the tenant has no key", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, { submissions_per_hour: 100, monthly_readings: 100 });
    const tenant = { tenantId: parseTenantId(tenantId)! };
    const fetchFn = vi.fn<typeof fetch>();
    const job = await seed(tenant, "https://missing-key.example/article");
    await processReading(job, runtime(), services(fetchFn), tenant);
    expect(fetchFn).not.toHaveBeenCalled();
    const manifest = await testReadingsFor(tenant).manifest(job.id);
    expect(manifest?.status).toBe("failed");
    expect(manifest?.error).toMatchObject({
      code: "provider_key_required",
      message: "connect a key, then retry",
      retryable: false,
    });
    expect(JSON.stringify(manifest)).not.toContain(DEPLOYMENT);
  });

  it("blocks the next dispatch after removal and uses a replacement on the next call", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, { submissions_per_hour: 100, monthly_readings: 100 });
    const tenant: TenantContext = { tenantId: parseTenantId(tenantId)! };
    const original = "sk-tenant-original-1111";
    const replaced = "sk-tenant-replaced-2222";
    await storeKey(tenantId, original);
    const auths: string[] = [];
    const removed = await seed(tenant, "https://removed-key.example/article");
    const removeFetch = vi.fn<typeof fetch>(async (input, init) => {
      auths.push(authOf(init));
      if (String(input).includes("/embeddings")) {
        await deleteProviderCredentials(testControlPlane(env), tenantId);
        return embeddingResponse();
      }
      throw new Error("provider called after the key was removed");
    });
    await processReading(removed, runtime(), services(removeFetch), tenant);
    expect(auths).toEqual(["Bearer sk-tenant-original-1111"]);
    expect((await testReadingsFor(tenant).manifest(removed.id))?.error?.code).toBe("provider_key_required");

    await storeKey(tenantId, original);
    const swapped: string[] = [];
    let embeds = 0;
    const replaceFetch = vi.fn<typeof fetch>(async (input, init) => {
      swapped.push(authOf(init));
      if (String(input).includes("/embeddings")) {
        embeds += 1;
        if (embeds === 1) {
          await upsertProviderCredential(testControlPlane(env), {
            tenantId,
            plaintext: replaced,
            root: { secret: parseProviderKeySecret(SECRET), version: 1 },
            nowMs: Date.parse(createdAt) + 1,
            validatedAtMs: Date.parse(createdAt) + 1,
          });
        }
        return embeddingResponse();
      }
      return summaryResponse();
    });
    const job = await seed(tenant, "https://replaced-key.example/article");
    await processReading(job, runtime(), services(replaceFetch), tenant);
    expect(swapped).toEqual([
      "Bearer sk-tenant-original-1111",
      `Bearer ${replaced}`,
      `Bearer ${replaced}`,
    ]);
    expect((await testReadingsFor(tenant).manifest(job.id))?.status).toBe("ready");
  });

  it("resolves the current key again when the queue redelivers the attempt", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, { submissions_per_hour: 100, monthly_readings: 100 });
    const tenant: TenantContext = { tenantId: parseTenantId(tenantId)! };
    const original = "sk-tenant-redeliver-3333";
    const replaced = "sk-tenant-redeliver-4444";
    await storeKey(tenantId, original);
    const job = await seed(tenant, "https://redelivery.example/article");
    const auths: string[] = [];
    let summaries = 0;
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      auths.push(authOf(init));
      const target = String(input);
      if (target.includes("/embeddings")) return embeddingResponse();
      summaries += 1;
      if (summaries === 1) return new Response("slow", { status: 429, headers: { "retry-after": "1" } });
      return summaryResponse();
    });
    await expect(processReading(job, runtime(), services(fetchFn), tenant)).rejects.toBeInstanceOf(RateLimitedError);
    await upsertProviderCredential(testControlPlane(env), {
      tenantId,
      plaintext: replaced,
      root: { secret: parseProviderKeySecret(SECRET), version: 1 },
      nowMs: Date.parse(createdAt) + 2,
      validatedAtMs: Date.parse(createdAt) + 2,
    });
    const envelope = {
      version: 1 as const,
      tenant: { tenantId: tenant.tenantId },
      actor: { kind: "operator" as const, operationId: "redelivery" },
      job,
    };
    const message = {
      id: "m_redelivery",
      timestamp: new Date(),
      body: envelope,
      attempts: 2,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await dispatchQueueMessage(message as unknown as Message<unknown>, () =>
      processReading(job, runtime(), services(fetchFn), tenant));
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(auths).toEqual([
      `Bearer ${original}`,
      `Bearer ${original}`,
      `Bearer ${replaced}`,
      `Bearer ${replaced}`,
    ]);
    expect(JSON.stringify(message.body)).not.toContain(original);
    expect(JSON.stringify(message.body)).not.toContain(replaced);
    expect((await testReadingsFor(tenant).manifest(job.id))?.status).toBe("ready");
  });

  it("summarizes a redelivered attempt again at the reader's changed effort", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, { submissions_per_hour: 100, monthly_readings: 100 });
    const tenant: TenantContext = { tenantId: parseTenantId(tenantId)! };
    await storeKey(tenantId, "sk-tenant-snapshot-5555");
    const job = await seed(tenant, "https://snapshot.example/article");
    const sent: string[] = [];
    let embeds = 0;
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("/embeddings")) {
        embeds += 1;
        // The summary embedding fails once, after the summary is checkpointed.
        if (embeds === 2) return new Response("slow", { status: 429, headers: { "retry-after": "1" } });
        return embeddingResponse();
      }
      sent.push(JSON.parse(String(init?.body)).reasoning.effort);
      return summaryResponse();
    });
    await expect(processReading(job, runtime(), services(fetchFn), tenant)).rejects.toBeInstanceOf(RateLimitedError);
    await updateProviderPreferences(testControlPlane(env), {
      userId: tenantId,
      nowMs: Date.parse(createdAt) + 1,
      effort: "medium",
    });
    await processReading(job, runtime(), services(fetchFn), tenant);
    expect(sent).toEqual(["high", "medium"]);
    expect(embeds).toBe(3);
    expect((await testReadingsFor(tenant).manifest(job.id))?.status).toBe("ready");
    await expect(
      testReadingsFor(tenant).writer.readCheckpoint({ id: job.id, attemptId: job.attemptId }),
    ).resolves.toMatchObject({ config: { provider: "openai", effort: "medium" } });
  });

  const QUOTA_BODY = JSON.stringify({ error: {
    message: "You exceeded your current quota, please check your plan and billing details.",
    type: "insufficient_quota", param: null, code: "insufficient_quota",
  } });
  it.each([
    { label: "401", status: 401, body: '{"error":{"message":"Incorrect API key provided: sk-proj-****zzzz","code":"invalid_api_key"}}',
      code: "provider_key_invalid", retryable: false, credential: "invalid", calls: 1 },
    { label: "403", status: 403, body: '{"error":{"message":"You have not been granted access to this model"}}',
      code: "provider_model_access", retryable: false, credential: "active", calls: 1 },
    { label: "429 insufficient_quota", status: 429, body: QUOTA_BODY,
      code: "provider_insufficient_quota", retryable: false, credential: "active", calls: 1 },
    { label: "429 rate limit", status: 429, body: '{"error":{"message":"Rate limit reached","code":"rate_limit_exceeded"}}',
      code: null, retryable: null, credential: "active", calls: 1 },
    { label: "5xx", status: 500, body: "unavailable",
      code: "OpenAIError", retryable: true, credential: "active", calls: 2 },
  ])("classifies a provider $label: code $code, credential $credential", async (row) => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, { submissions_per_hour: 100, monthly_readings: 100 });
    const tenant: TenantContext = { tenantId: parseTenantId(tenantId)! };
    await storeKey(tenantId, "sk-tenant-classify-7777");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(row.body, { status: row.status }));
    const job = await seed(tenant, `https://classify-${row.status}-${row.calls}.example/article`);
    const message = { id: "m_classify", timestamp: new Date(), body: job, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await dispatchQueueMessage(message as unknown as Message<unknown>, () =>
      processReading(job, runtime(), services(fetchFn), tenant));

    expect(fetchFn).toHaveBeenCalledTimes(row.calls);
    const manifest = await testReadingsFor(tenant).manifest(job.id);
    if (row.code === null) {
      expect(message.retry).toHaveBeenCalledOnce();
      expect(manifest?.status).toBe("pending");
    } else {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      expect(manifest?.status).toBe("failed");
      expect(manifest?.error).toMatchObject({ code: row.code, retryable: row.retryable, http_status: row.status, stage: "embed_source" });
      expect(JSON.stringify(manifest)).not.toContain("sk-tenant-classify-7777");
    }
    expect((await readProviderCredential(testControlPlane(env), tenantId))?.status).toBe(row.credential);
  });

  it("leaves a key replaced while the rejected request was in flight active", async () => {
    const { tenantId } = await insertQuotaTenant(env as unknown as Env, { submissions_per_hour: 100, monthly_readings: 100 });
    const tenant: TenantContext = { tenantId: parseTenantId(tenantId)! };
    await storeKey(tenantId, "sk-tenant-rejected-5555");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = vi.fn<typeof fetch>(async () => {
      await storeKey(tenantId, "sk-tenant-replacement-6666");
      return new Response('{"error":{"message":"invalid key"}}', { status: 401 });
    });
    const job = await seed(tenant, "https://replaced-in-flight.example/article");
    await processReading(job, runtime(), services(fetchFn), tenant);

    expect((await testReadingsFor(tenant).manifest(job.id))?.error?.code).toBe("provider_key_invalid");
    const credential = await readProviderCredential(testControlPlane(env), tenantId);
    expect(credential).toMatchObject({ status: "active", credentialVersion: 2, lastFour: "6666" });
  });
});

// Intake refuses up front, before claiming the URL, when the switch is on and
// the tenant has no active key; dispatch's own failure (above) still covers a
// key removed after intake.
describe("intake with tenant provider keys", () => {
  it.each([
    { name: "switch off, no key", switch: undefined, key: "none", status: 202 },
    { name: "switch on, no key", switch: "1", key: "none", status: 409 },
    { name: "switch on, invalid key", switch: "1", key: "invalid", status: 409 },
    { name: "switch on, active key", switch: "1", key: "active", status: 202 },
  ] as const)("answers a save with $status ($name)", async (row) => {
    const queued = installQueueStub();
    const { tenantId, token } = await insertQuotaTenant(env as unknown as Env, { submissions_per_hour: 100, monthly_readings: 100 });
    if (row.key !== "none") await storeKey(tenantId, "sk-tenant-intake-7777");
    if (row.key === "invalid") {
      await markProviderCredentialInvalid(testControlPlane(env), { tenantId, credentialVersion: 1, nowMs: Date.parse(createdAt) });
    }
    const url = "https://intake-gate.example/article";
    const res = await createApp({ services: services(vi.fn<typeof fetch>()) }).request(
      "/api/readings",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ url, email: false }),
      },
      { ...runtime(), TENANT_PROVIDER_KEYS: row.switch } as Env,
    );

    expect(res.status).toBe(row.status);
    const tenant: TenantContext = { tenantId: parseTenantId(tenantId)! };
    if (row.status === 409) {
      expect(await res.json()).toEqual({ error: "connect a key, then retry", code: "provider_key_required" });
      expect(queued).toHaveLength(0);
      await expect(testReadingsFor(tenant).urlOwnerId(url)).resolves.toBeNull();
    } else {
      expect(queued).toHaveLength(1);
    }
  });
});
