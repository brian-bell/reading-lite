import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/index";
import { consumeRelationshipRefresh } from "../../src/relationship-refresh";
import { processRelationshipJudge } from "../../src/relationship-judge";
import { testReadingStore, FOUNDER_TENANT_ID } from "../helpers/tenant-fixtures";
import { buildKeyPrefix, manifestToIndexItem } from "../../src/modules/stores/reading-store";
import type { Manifest } from "../../src/schemas/manifest";
import { purgeReading } from "../../src/reading-purge";
import { deleteRefreshJob } from "../../src/control-plane/relationship-refresh-jobs";
import { fromD1 } from "../../src/control-plane/db";
import type { Services } from "../../src/services";

const createdAt = "2026-09-01T00:00:00.000Z";
const runAt = "2026-09-06T03:07:00.000Z";
const id = "rd_0000000001";
const other = "rd_0000000002";
const keyPrefix = buildKeyPrefix(id, createdAt);
const job = { version: 1 as const, kind: "judge" as const, tenantId: FOUNDER_TENANT_ID, runAt, readingId: id, keyPrefix };
let runtime: Env;
let services: Services;
let provider: ReturnType<typeof vi.fn<typeof fetch>>;
let original: Manifest;
function response() {
  return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ novelty_verdict: "familiar", connections: [{ id: other, reason: "Related evidence" }] }) }] }], usage: { input_tokens: 100, output_tokens: 30 } });
}
beforeEach(async () => {
  provider = vi.fn<typeof fetch>(async () => response());
  runtime = { ...env, RELATIONSHIP_REFRESH: "1", SUMMARIZER_PROVIDER: "openai", OPENAI_SUMMARIZATION_MODEL: "gpt-5.6-terra", OPENAI_SUMMARIZATION_REASONING_EFFORT: "low", RETRY_MAX_ATTEMPTS: "2", RETRY_BASE_DELAY_MS: "0", RETRY_MAX_DELAY_MS: "0",
    READINGS_INDEX: { getByIds: async (ids: string[]) => ids.map(id => ({ id })), queryById: async () => ({ matches: [{ id: `${FOUNDER_TENANT_ID}:${other}`, score: 0.8, metadata: { title: "Neighbour", tldr: "Useful context" } }] }) } as unknown as VectorizeIndex,
  } as unknown as Env;
  services = { fetch: provider, now: () => new Date().toISOString(), newId: () => crypto.randomUUID(), lookup: async () => [] };
  original = { id, url: "https://example.com/reading", url_hash: "a".repeat(64), status: "ready", title: "Reading", tldr: "Stored summary", summary_markdown: "Original summary", tags: ["test"], novelty_verdict: "novel", connections: [], content_type: "text/html", content_status: "captured", content_bytes: 100, content_sha256: "b".repeat(64), created_at: createdAt, updated_at: createdAt };
  const neighbour = { ...original, id: other, url: "https://example.com/neighbour", url_hash: "c".repeat(64) };
  const store = testReadingStore(env);
  for (const m of [original, neighbour]) {
    const prefix = buildKeyPrefix(m.id, createdAt);
    await store.writeManifest(prefix, m);
    await store.writeByIdPointer(m.id, { id: m.id, key_prefix: prefix });
    await store.appendOrReplaceListIndexItem(manifestToIndexItem(m, prefix));
  }
});

describe("hosted relationship judge", () => {
  it("updates only relationships and the list verdict, and does not rebill a duplicate", async () => {
    await processRelationshipJudge(job, runtime, services);
    const result = (await testReadingStore(env).readManifest(keyPrefix))!;
    expect(result).toEqual({ ...original, novelty_verdict: "familiar", connections: [{ id: other, reason: "Related evidence" }], connections_computed_at: expect.any(String), connections_neighbourhood_ids: [other] });
    expect((await testReadingStore(env).findListIndexItem(id))!.novelty_verdict).toBe("familiar");
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
    const checkpoint = await env.CONTROL_PLANE.prepare("SELECT result_json FROM relationship_refresh_jobs WHERE reading_id = ?").bind(id).first<{ result_json: string }>();
    expect(checkpoint!.result_json).not.toContain("Original summary");
  });
  it("leaves ready data untouched on a provider error and does not repeat an uncertain dispatch", async () => {
    provider.mockRejectedValue(new Error("transport lost"));
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow("transport lost");
    const calls = provider.mock.calls.length;
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledTimes(calls);
    expect(await testReadingStore(env).readManifest(keyPrefix)).toEqual(original);
  });
  it("honors spend denial before dispatch and before creating a job checkpoint", async () => {
    await env.CONTROL_PLANE.prepare("UPDATE tenant_limits SET daily_spend_microdollars = 1 WHERE tenant_id = ?").bind(FOUNDER_TENANT_ID).run();
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow(/spend admission/);
    expect(provider).not.toHaveBeenCalled();
    expect(await env.CONTROL_PLANE.prepare("SELECT * FROM relationship_refresh_jobs").all()).toMatchObject({ results: [] });
    expect(await testReadingStore(env).readManifest(keyPrefix)).toEqual(original);
  });
  it("does not write over a reprocess that wins during the provider call", async () => {
    const changed = { ...original, active_attempt: { id: "at_new", status: "running" as const, stage: "queued" as const, trigger: "reprocess" as const, started_at: new Date().toISOString() } };
    provider.mockImplementationOnce(async () => { await testReadingStore(env).writeManifest(keyPrefix, changed); return response(); });
    await processRelationshipJudge(job, runtime, services);
    expect(await testReadingStore(env).readManifest(keyPrefix)).toEqual(changed);
    expect((await testReadingStore(env).findListIndexItem(id))!.novelty_verdict).toBe("novel");
  });
  it("does no work while the gate is off", async () => {
    await processRelationshipJudge(job, { RELATIONSHIP_REFRESH: "0" } as Env, services);
    expect(provider).not.toHaveBeenCalled();
  });
  it("heals a committed result after a failed list write even if a neighbour changes", async () => {
    const bucket = env.READINGS_BUCKET;
    const root = `u/${FOUNDER_TENANT_ID}/`;
    let fail = true;
    runtime.READINGS_BUCKET = new Proxy(bucket, { get(target, key) {
      if (key === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
        if (args[0] === `${root}index/list.json` && fail) { fail = false; throw new Error("list unavailable"); }
        return bucket.put(...args);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow("list unavailable");
    expect((await testReadingStore(env).readManifest(keyPrefix))!.novelty_verdict).toBe("familiar");
    const neighbourPrefix = buildKeyPrefix(other, createdAt);
    const neighbour = (await testReadingStore(env).readManifest(neighbourPrefix))!;
    await testReadingStore(env).writeManifest(neighbourPrefix, { ...neighbour, title: "Reprocessed neighbour" });
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
    expect((await testReadingStore(env).findListIndexItem(id))!.novelty_verdict).toBe("familiar");
  });

  it("writes no list row after losing the manifest CAS", async () => {
    const bucket = env.READINGS_BUCKET;
    const winner = { ...original, title: "Concurrent update" };
    let lost = false;
    runtime.READINGS_BUCKET = new Proxy(bucket, { get(target, key) {
      if (key === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
        if (args[0].endsWith(`${keyPrefix}/manifest.json`) && !lost) {
          lost = true;
          await bucket.put(args[0], JSON.stringify(winner));
          return null;
        }
        return bucket.put(...args);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await processRelationshipJudge(job, runtime, services);
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
    expect(await testReadingStore(env).readManifest(keyPrefix)).toEqual(winner);
    expect((await testReadingStore(env).findListIndexItem(id))!.novelty_verdict).toBe("novel");
  });

  it.each(["purged", "running"])("skips an initially %s reading before any dispatch checkpoint", async kind => {
    const store = testReadingStore(env);
    if (kind === "purged") await store.removeListIndexItem(id);
    else await store.writeManifest(keyPrefix, { ...original, active_attempt: { id: "at_busy", trigger: "reprocess", stage: "queued", status: "running", started_at: new Date().toISOString() } });
    await processRelationshipJudge(job, runtime, services);
    expect(provider).not.toHaveBeenCalled();
    expect((await env.CONTROL_PLANE.prepare("SELECT * FROM relationship_refresh_jobs").all()).results).toEqual([]);
  });

  it("does not recreate a purged reading or its checkpoint after an in-flight call", async () => {
    const store = testReadingStore(env);
    provider.mockImplementationOnce(async () => {
      await purgeReading({ reader: store, similarity: null, deleteRefreshCheckpoint: id => deleteRefreshJob(fromD1(env.CONTROL_PLANE), FOUNDER_TENANT_ID, id) }, id, { now: services.now(), pendingTtlSeconds: 300 });
      return response();
    });
    await processRelationshipJudge(job, runtime, services);
    expect(await store.readManifest(keyPrefix)).toBeNull();
    expect(await store.findListIndexItem(id)).toBeNull();
    expect((await env.CONTROL_PLANE.prepare("SELECT * FROM relationship_refresh_jobs").all()).results).toEqual([]);
  });

  it("removes a checkpoint claimed after purge has already completed", async () => {
    const db = env.CONTROL_PLANE;
    const store = testReadingStore(env);
    runtime.CONTROL_PLANE = new Proxy(db, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = db.prepare(sql);
        if (!sql.startsWith("INSERT INTO relationship_refresh_jobs")) return statement;
        return { bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return { run: async () => {
            await purgeReading({ reader: store, similarity: null,
              deleteRefreshCheckpoint: id => deleteRefreshJob(fromD1(db), FOUNDER_TENANT_ID, id),
            }, id, { now: services.now(), pendingTtlSeconds: 300 });
            return bound.run();
          } };
        } };
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow("refresh input changed");
    expect(provider).not.toHaveBeenCalled();
    expect((await db.prepare("SELECT * FROM relationship_refresh_jobs").all()).results).toEqual([]);
  });

  it("retries a pre-fetch validation failure without an uncertain checkpoint", async () => {
    runtime.RETRY_MAX_ATTEMPTS = "1";
    const bucket = env.READINGS_BUCKET;
    let fail = true;
    runtime.READINGS_BUCKET = new Proxy(bucket, { get(target, key) {
      if (key === "get") return async (...args: Parameters<R2Bucket["get"]>) => {
        if (fail && await env.CONTROL_PLANE.prepare("SELECT owner FROM relationship_refresh_jobs WHERE reading_id = ?").bind(id).first()) {
          fail = false;
          throw new Error("temporary validation failure");
        }
        return bucket.get(...args);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow("temporary validation failure");
    expect(provider).not.toHaveBeenCalled();
    expect((await env.CONTROL_PLANE.prepare("SELECT * FROM relationship_refresh_jobs").all()).results).toEqual([]);
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
  });

  it("cleans up a claim when D1 commits but loses its response before fetch", async () => {
    runtime.RETRY_MAX_ATTEMPTS = "1";
    const db = env.CONTROL_PLANE;
    let fail = true;
    runtime.CONTROL_PLANE = new Proxy(db, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = db.prepare(sql);
        if (!sql.startsWith("INSERT INTO relationship_refresh_jobs")) return statement;
        return { bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return { run: async () => {
            const result = await bound.run();
            if (fail) { fail = false; throw new Error("lost D1 response"); }
            return result;
          } };
        } };
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow("lost D1 response");
    expect(provider).not.toHaveBeenCalled();
    expect((await db.prepare("SELECT * FROM relationship_refresh_jobs").all()).results).toEqual([]);
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
  });

  it("rechecks spend admission inside provider retries", async () => {
    provider.mockImplementationOnce(async () => {
      await env.CONTROL_PLANE.prepare("UPDATE system_policy SET paid_work_enabled = 0 WHERE id = 1").run();
      return new Response("temporary failure", { status: 500 });
    });
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow(/spend admission/);
    expect(provider).toHaveBeenCalledOnce();
    expect(await testReadingStore(env).readManifest(keyPrefix)).toEqual(original);
  });

  it("rechecks reading ownership inside provider retries", async () => {
    provider.mockImplementationOnce(async () => {
      await testReadingStore(env).removeListIndexItem(id);
      return new Response("temporary failure", { status: 500 });
    });
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow("refresh input changed");
    expect(provider).toHaveBeenCalledOnce();
    expect(await testReadingStore(env).readManifest(keyPrefix)).toEqual(original);
  });

  it("drops a result if a neighbour is purged during the call", async () => {
    provider.mockImplementationOnce(async () => {
      await testReadingStore(env).removeListIndexItem(other);
      return response();
    });
    await processRelationshipJudge(job, runtime, services);
    expect(await testReadingStore(env).readManifest(keyPrefix)).toEqual(original);
  });

  it("skips a deleting founder before any spend", async () => {
    await env.CONTROL_PLANE.prepare("UPDATE users SET status = 'deleting' WHERE id = ?").bind(FOUNDER_TENANT_ID).run();
    await processRelationshipJudge(job, runtime, services);
    expect(provider).not.toHaveBeenCalled();
  });

  it("uses the Anthropic adapter through the same paid admission seam", async () => {
    runtime.SUMMARIZER_PROVIDER = "anthropic";
    runtime.ANTHROPIC_MODEL = "claude-sonnet-5";
    provider.mockImplementationOnce(async () => Response.json({
      content: [{ type: "tool_use", name: "judge_relationships", input: { novelty_verdict: "familiar", connections: [{ id: other, reason: "Related evidence" }] } }],
      usage: { input_tokens: 100, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }));
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
    expect(provider.mock.calls[0]![0]).toBe("https://api.anthropic.com/v1/messages");
    expect((await testReadingStore(env).readManifest(keyPrefix))!.novelty_verdict).toBe("familiar");
  });

  it("retries a definitive 429 without treating it as an uncertain dispatch", async () => {
    provider.mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }));
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow(/rate limited/);
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledTimes(2);
    expect((await testReadingStore(env).readManifest(keyPrefix))!.novelty_verdict).toBe("familiar");
  });

  it("discards a result if a neighbour finishes reprocessing during the call", async () => {
    provider.mockImplementationOnce(async () => {
      const prefix = buildKeyPrefix(other, createdAt);
      const neighbour = (await testReadingStore(env).readManifest(prefix))!;
      await testReadingStore(env).writeManifest(prefix, { ...neighbour, summary_markdown: "Reprocessed content" });
      return response();
    });
    await processRelationshipJudge(job, runtime, services);
    expect(await testReadingStore(env).readManifest(keyPrefix)).toEqual(original);
    expect((await testReadingStore(env).findListIndexItem(id))!.novelty_verdict).toBe("novel");
  });

  it("does not let an early duplicate bypass Retry-After", async () => {
    provider.mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "120" } }));
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow(/rate limited/);
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toMatchObject({ name: "DeferPaidWorkError" });
    expect(provider).toHaveBeenCalledOnce();
  });

  it("does not apply a saved result after a neighbour version changes", async () => {
    const bucket = env.READINGS_BUCKET;
    let fail = true;
    runtime.READINGS_BUCKET = new Proxy(bucket, { get(target, key) {
      if (key === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
        if (args[0].endsWith(`${keyPrefix}/manifest.json`) && fail) { fail = false; throw new Error("manifest unavailable"); }
        return bucket.put(...args);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow("manifest unavailable");
    const prefix = buildKeyPrefix(other, createdAt);
    const neighbour = (await testReadingStore(env).readManifest(prefix))!;
    await testReadingStore(env).writeManifest(prefix, { ...neighbour, tldr: "Changed neighbour" });
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
    expect(await testReadingStore(env).readManifest(keyPrefix)).toEqual(original);
  });

  it("delays expected spend deferrals without consuming queue retries", async () => {
    await env.CONTROL_PLANE.prepare("UPDATE tenant_limits SET daily_spend_microdollars = 1 WHERE tenant_id = ?").bind(FOUNDER_TENANT_ID).run();
    const send = vi.fn(async () => {});
    runtime.RELATIONSHIP_REFRESH_JOBS = { send } as unknown as Queue;
    const ack = vi.fn(); const retry = vi.fn();
    await consumeRelationshipRefresh({ body: job, ack, retry } as unknown as Message<unknown>, runtime, undefined, services);
    expect(send).toHaveBeenCalledWith({ ...job, deferredAt: expect.any(String) }, { delaySeconds: 15 });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("falls back to retry if delayed enqueue fails", async () => {
    await env.CONTROL_PLANE.prepare("UPDATE tenant_limits SET daily_spend_microdollars = 1 WHERE tenant_id = ?").bind(FOUNDER_TENANT_ID).run();
    runtime.RELATIONSHIP_REFRESH_JOBS = { send: vi.fn(async () => { throw new Error("queue unavailable"); }) } as unknown as Queue;
    const ack = vi.fn(); const retry = vi.fn();
    await consumeRelationshipRefresh({ body: job, ack, retry } as unknown as Message<unknown>, runtime, undefined, services);
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 15 });
  });

  it("expires a repeatedly deferred job without touching the ready reading", async () => {
    const ack = vi.fn(); const retry = vi.fn();
    const body = { ...job, deferredAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
    await consumeRelationshipRefresh({ body, ack, retry } as unknown as Message<unknown>, runtime, undefined, services);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(await testReadingStore(env).readManifest(keyPrefix)).toEqual(original);
  });

});
