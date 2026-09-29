import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/index";
import { consumeRelationshipRefresh } from "../../src/relationship-refresh";
import { processRelationshipJudge } from "../../src/relationship-judge";
import { founderTenant, FOUNDER_TENANT_ID } from "../helpers/tenant-fixtures";
import { testReadingsFor } from "../helpers/test-readings";
import { buildKeyPrefix } from "../../src/modules/stores/layout";
import { PgReadingStore } from "../../src/modules/stores/postgres/reading-store";
import { PgReadingWriter } from "../../src/modules/stores/postgres/reading-writer";
import { PgSimilarityStore } from "../../src/modules/stores/postgres/similarity-store";
import type { SimilarityMatch } from "../../src/modules/stores/similarity";
import type { Manifest } from "../../src/schemas/manifest";
import { purgeReading } from "../../src/reading-purge";
import type { Services } from "../../src/services";
import { parseProviderKeySecret } from "../../src/control-plane/crypto";
import { upsertProviderCredential } from "../../src/control-plane/provider-credentials";
import { testControlPlane } from "../helpers/control-plane-db";
import { interceptSql } from "../helpers/sql-faults";

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
// The reading's neighbourhood as pgvector would answer it (see beforeEach).
let neighbourhood: ReturnType<typeof vi.fn<(id: string, topK: number) => Promise<SimilarityMatch[] | null>>>;

// The tests arrange and inspect readings by key prefix, as they did when a
// reading was a manifest object. A reading is rows now, so these verbs resolve
// the prefix to its id and go through the row-backed facade. `writeManifest`
// rewrites attempt state in place when the reading exists, so a test that
// simulates a concurrent reprocess does not also wipe the reading's children.
const idOf = (prefix: string) => prefix.slice(prefix.lastIndexOf("-") + 1);
function testStore() {
  const readings = testReadingsFor(founderTenant());
  return {
    readings,
    readManifest: (prefix: string) => readings.manifest(idOf(prefix)),
    writeManifest: (prefix: string, manifest: Manifest) => readings.seed(manifest, { keyPrefix: prefix }),
    findListIndexItem: async (readingId: string) => (await readings.store.relationshipTargets([readingId]))[0] ?? null,
  };
}

function response() {
  return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ novelty_verdict: "familiar", connections: [{ id: other, reason: "Related evidence" }] }) }] }], usage: { input_tokens: 100, output_tokens: 30 } });
}
beforeEach(async () => {
  provider = vi.fn<typeof fetch>(async () => response());
  runtime = { ...env, RELATIONSHIP_REFRESH: "1", SUMMARIZER_PROVIDER: "openai", OPENAI_SUMMARIZATION_MODEL: "gpt-5.6-terra", OPENAI_SUMMARIZATION_REASONING_EFFORT: "low", RETRY_MAX_ATTEMPTS: "2", RETRY_BASE_DELAY_MS: "0", RETRY_MAX_DELAY_MS: "0",
  } as unknown as Env;
  services = { fetch: provider, now: () => new Date().toISOString(), newId: () => crypto.randomUUID(), lookup: async () => [] };
  original = { id, url: "https://example.com/reading", url_hash: "a".repeat(64), status: "ready", title: "Reading", tldr: "Stored summary", summary_markdown: "Original summary", tags: ["test"], novelty_verdict: "novel", connections: [], content_type: "text/html", content_status: "captured", content_bytes: 100, content_sha256: "b".repeat(64), created_at: createdAt, updated_at: createdAt };
  const neighbour = { ...original, id: other, url: "https://example.com/neighbour", url_hash: "c".repeat(64) };
  const store = testStore();
  for (const m of [original, neighbour]) await store.writeManifest(buildKeyPrefix(m.id, createdAt), m);
  // Neighbourhoods come from pgvector. These tests are about what the judge
  // does with a neighbourhood, so `neighbourhood` scripts one. The similarity
  // store has its own suite.
  neighbourhood = vi.fn(async () => [{ id: other, score: 0.8, url: "" }]);
  vi.spyOn(PgSimilarityStore.prototype, "queryByVectorId").mockImplementation((readingId, topK) => neighbourhood(readingId, topK));
});
afterEach(() => vi.restoreAllMocks());

describe("hosted relationship judge", () => {
  it("judges the fifth ready neighbour behind a stale vector", async () => {
    const store = testStore();
    const neighbours = Array.from({ length: 5 }, (_, i) => `rd_${String(i + 2).padStart(10, "0")}`);
    for (const neighbourId of neighbours) {
      const m = { ...original, id: neighbourId, url: `https://example.com/${neighbourId}` };
      const prefix = buildKeyPrefix(neighbourId, createdAt);
      await store.writeManifest(prefix, m);
    }
    const known = neighbours.slice(0, 4);
    await store.writeManifest(keyPrefix, { ...original, novelty_verdict: "familiar",
      connections: known.map(id => ({ id, reason: "Known" })), connections_neighbourhood_ids: known,
    });
    neighbourhood.mockImplementation(async (self, topK) => [
      { id: self, score: 1, url: "" }, { id: "rd_9999999999", score: 0.99, url: "" },
      ...neighbours.map((id, i) => ({ id, score: 0.9 - i * 0.01, url: "" })),
    ].slice(0, topK));
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
    expect((await store.readManifest(keyPrefix))!.connections_neighbourhood_ids).toEqual(neighbours);
  });

  it("updates only relationships and the list verdict, and does not rebill a duplicate", async () => {
    await processRelationshipJudge(job, runtime, services);
    const result = (await testStore().readManifest(keyPrefix))!;
    expect(result).toEqual({ ...original, novelty_verdict: "familiar", connections: [{ id: other, reason: "Related evidence" }], connections_computed_at: expect.any(String), connections_neighbourhood_ids: [other] });
    expect((await testStore().findListIndexItem(id))!.novelty_verdict).toBe("familiar");
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
    const checkpoint = await testControlPlane(env).first<{ result_json: string }>(
      "SELECT result_json::text AS result_json FROM relationship_refresh_jobs WHERE reading_id = ?",
      id,
    );
    expect(checkpoint!.result_json).not.toContain("Original summary");
  });
  it("leaves ready data untouched on a provider error and does not repeat an uncertain dispatch", async () => {
    provider.mockRejectedValue(new Error("transport lost"));
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow("transport lost");
    const calls = provider.mock.calls.length;
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledTimes(calls);
    expect(await testStore().readManifest(keyPrefix)).toEqual(original);
  });
  it("honors spend denial before dispatch and before creating a job checkpoint", async () => {
    await testControlPlane(env).run(
      "UPDATE tenant_limits SET daily_spend_microdollars = 1 WHERE tenant_id = ?",
      FOUNDER_TENANT_ID,
    );
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow(/spend admission/);
    expect(provider).not.toHaveBeenCalled();
    expect(await testControlPlane(env).all("SELECT * FROM relationship_refresh_jobs")).toEqual([]);
    expect(await testStore().readManifest(keyPrefix)).toEqual(original);
  });
  it("does not write over a reprocess that wins during the provider call", async () => {
    const changed = { ...original, active_attempt: { id: "at_new", status: "running" as const, stage: "queued" as const, trigger: "reprocess" as const, started_at: new Date().toISOString() } };
    provider.mockImplementationOnce(async () => { await testStore().writeManifest(keyPrefix, changed); return response(); });
    await processRelationshipJudge(job, runtime, services);
    expect(await testStore().readManifest(keyPrefix)).toEqual(changed);
    expect((await testStore().findListIndexItem(id))!.novelty_verdict).toBe("novel");
  });
  it("does no work while the gate is off", async () => {
    await processRelationshipJudge(job, { RELATIONSHIP_REFRESH: "0" } as Env, services);
    expect(provider).not.toHaveBeenCalled();
  });
  it("applies nothing after losing the compare-and-replace", async () => {
    const winner = { ...original, title: "Concurrent update" };
    const replace = PgReadingWriter.prototype.replacePublishedIf;
    let lost = false;
    vi.spyOn(PgReadingWriter.prototype, "replacePublishedIf").mockImplementation(async function (this: PgReadingWriter, ...args) {
      if (!lost) {
        lost = true;
        await testStore().writeManifest(keyPrefix, winner);
      }
      return replace.apply(this, args);
    });
    await processRelationshipJudge(job, runtime, services);
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
    expect(await testStore().readManifest(keyPrefix)).toEqual(winner);
    expect((await testStore().findListIndexItem(id))!.novelty_verdict).toBe("novel");
  });

  it("skips an initially purged reading before any dispatch checkpoint", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await testStore().readings.purge(id);
    await processRelationshipJudge(job, runtime, services);
    expect(provider).not.toHaveBeenCalled();
    expect((await testControlPlane(env).all("SELECT * FROM relationship_refresh_jobs"))).toEqual([]);
    const logged = warn.mock.calls.map(call => String(call[0])).join("\n");
    expect(logged).toContain(`"readingId":"${id}"`);
    expect(logged).toContain('"reason":"purged"');
  });

  it.each([
    { kind: "target" as const, reason: "target_running" },
    { kind: "neighbour" as const, reason: "neighbour_running" },
  ])("defers an initially in-TTL running $kind without a dispatch checkpoint", async ({ kind, reason }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowIso = "2026-09-06T03:07:00.000Z";
    services.now = () => nowIso;
    const store = testStore();
    const busy = { id: "at_busy", trigger: "reprocess" as const, stage: "queued" as const, status: "running" as const, started_at: nowIso };
    if (kind === "target") await store.writeManifest(keyPrefix, { ...original, active_attempt: busy });
    else {
      const neighbourPrefix = buildKeyPrefix(other, createdAt);
      const neighbour = (await store.readManifest(neighbourPrefix))!;
      await store.writeManifest(neighbourPrefix, { ...neighbour, active_attempt: busy });
    }
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toMatchObject({ name: "DeferPaidWorkError" });
    expect(provider).not.toHaveBeenCalled();
    expect((await testControlPlane(env).all("SELECT * FROM relationship_refresh_jobs"))).toEqual([]);
    const logged = warn.mock.calls.map(call => String(call[0])).join("\n");
    expect(logged).toContain(id);
    expect(logged).toContain(reason);
    if (kind === "neighbour") expect(logged).toContain(other);
  });

  it.each([
    { kind: "target" as const },
    { kind: "neighbour" as const },
  ])("judges when the $kind's running attempt has expired", async ({ kind }) => {
    const nowIso = "2026-09-06T03:07:00.000Z";
    services.now = () => nowIso;
    const store = testStore();
    const zombie = { id: "at_zombie", trigger: "reprocess" as const, stage: "queued" as const, status: "running" as const, started_at: "2026-09-06T02:00:00.000Z" };
    if (kind === "target") await store.writeManifest(keyPrefix, { ...original, active_attempt: zombie });
    else {
      const neighbourPrefix = buildKeyPrefix(other, createdAt);
      const neighbour = (await store.readManifest(neighbourPrefix))!;
      await store.writeManifest(neighbourPrefix, { ...neighbour, active_attempt: zombie });
    }
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
    expect(await testControlPlane(env).first(
      "SELECT reading_id FROM relationship_refresh_jobs WHERE reading_id = ?",
      id,
    )).toEqual({ reading_id: id });
    expect((await store.readManifest(keyPrefix))!.novelty_verdict).toBe("familiar");
  });

  it.each([
    { kind: "target" as const, reason: "target_running" },
    { kind: "neighbour" as const, reason: "neighbour_running" },
  ])("re-enqueues the same judge identity when consume sees in-TTL $kind running", async ({ kind, reason }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const nowIso = "2026-09-06T03:07:00.000Z";
    services.now = () => nowIso;
    const store = testStore();
    const busy = { id: "at_busy", trigger: "reprocess" as const, stage: "queued" as const, status: "running" as const, started_at: nowIso };
    if (kind === "target") await store.writeManifest(keyPrefix, { ...original, active_attempt: busy });
    else {
      const neighbourPrefix = buildKeyPrefix(other, createdAt);
      const neighbour = (await store.readManifest(neighbourPrefix))!;
      await store.writeManifest(neighbourPrefix, { ...neighbour, active_attempt: busy });
    }
    const send = vi.fn(async () => {});
    runtime.RELATIONSHIP_REFRESH_JOBS = { send } as unknown as Queue;
    const ack = vi.fn(); const retry = vi.fn();
    await consumeRelationshipRefresh({ body: job, ack, retry } as unknown as Message<unknown>, runtime, undefined, services);
    expect(send).toHaveBeenCalledWith({ ...job, deferredAt: expect.any(String) }, { delaySeconds: 15 });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect((await testControlPlane(env).all("SELECT * FROM relationship_refresh_jobs"))).toEqual([]);
    const logged = warn.mock.calls.map(call => String(call[0])).join("\n");
    expect(logged).toContain(id);
    expect(logged).toContain(reason);
    if (kind === "neighbour") expect(logged).toContain(other);
  });

  it("does not recreate a purged reading or its checkpoint after an in-flight call", async () => {
    const store = testStore();
    provider.mockImplementationOnce(async () => {
      await purgeReading({ writer: store.readings.writer, content: store.readings.content }, id, { now: services.now(), pendingTtlSeconds: 300 });
      return response();
    });
    await processRelationshipJudge(job, runtime, services);
    expect(await store.readManifest(keyPrefix)).toBeNull();
    expect(await store.findListIndexItem(id)).toBeNull();
    expect((await testControlPlane(env).all("SELECT * FROM relationship_refresh_jobs"))).toEqual([]);
  });

  it("removes a checkpoint claimed after purge has already completed", async () => {
    const store = testStore();
    interceptSql(/^INSERT INTO relationship_refresh_jobs/, async (): Promise<"pass"> => {
      await purgeReading({ writer: store.readings.writer, content: store.readings.content }, id, { now: services.now(), pendingTtlSeconds: 300 });
      return "pass";
    });
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow("refresh input changed");
    expect(provider).not.toHaveBeenCalled();
    expect(await testControlPlane(env).all("SELECT * FROM relationship_refresh_jobs")).toEqual([]);
  });

  it("retries a pre-fetch validation failure without an uncertain checkpoint", async () => {
    runtime.RETRY_MAX_ATTEMPTS = "1";
    // The first read of a reading after the dispatch claim exists fails.
    const load = PgReadingStore.prototype.loadReadingById;
    let fail = true;
    vi.spyOn(PgReadingStore.prototype, "loadReadingById").mockImplementation(async function (this: PgReadingStore, readingId) {
      if (fail && await testControlPlane(env).first(
        "SELECT owner FROM relationship_refresh_jobs WHERE reading_id = ?",
        id,
      )) {
        fail = false;
        throw new Error("temporary validation failure");
      }
      return load.call(this, readingId);
    });
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow("temporary validation failure");
    expect(provider).not.toHaveBeenCalled();
    expect((await testControlPlane(env).all("SELECT * FROM relationship_refresh_jobs"))).toEqual([]);
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
  });

  it("cleans up a claim when the database commits but loses its response before fetch", async () => {
    runtime.RETRY_MAX_ATTEMPTS = "1";
    interceptSql(/^INSERT INTO relationship_refresh_jobs/, (call) =>
      call === 1 ? { afterRunning: new Error("lost database response") } : "pass",
    );
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow("lost database response");
    expect(provider).not.toHaveBeenCalled();
    expect(await testControlPlane(env).all("SELECT * FROM relationship_refresh_jobs")).toEqual([]);
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
  });

  it("rechecks spend admission inside provider retries", async () => {
    provider.mockImplementationOnce(async () => {
      await testControlPlane(env).run("UPDATE system_policy SET paid_work_enabled = false WHERE id = 1");
      return new Response("temporary failure", { status: 500 });
    });
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow(/spend admission/);
    expect(provider).toHaveBeenCalledOnce();
    expect(await testStore().readManifest(keyPrefix)).toEqual(original);
  });

  it("rechecks reading ownership inside provider retries", async () => {
    provider.mockImplementationOnce(async () => {
      await testStore().readings.purge(id);
      return new Response("temporary failure", { status: 500 });
    });
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow("refresh input changed");
    expect(provider).toHaveBeenCalledOnce();
    // Purged mid-call: the retry is refused and nothing is recreated.
    expect(await testStore().readManifest(keyPrefix)).toBeNull();
  });

  it("drops a result if a neighbour is purged during the call", async () => {
    provider.mockImplementationOnce(async () => {
      await testStore().readings.purge(other);
      return response();
    });
    await processRelationshipJudge(job, runtime, services);
    expect(await testStore().readManifest(keyPrefix)).toEqual(original);
  });

  it("skips a deleting founder before any spend", async () => {
    await testControlPlane(env).run("UPDATE users SET status = 'deleting' WHERE id = ?", FOUNDER_TENANT_ID);
    await processRelationshipJudge(job, runtime, services);
    expect(provider).not.toHaveBeenCalled();
  });

  it("soft-acks without taking a lease when the gate turns off after neighbourhood capture", async () => {
    let reads = 0;
    Object.defineProperty(runtime, "RELATIONSHIP_REFRESH", {
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? "1" : "0";
      },
    });
    await processRelationshipJudge(job, runtime, services);
    expect(neighbourhood).toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect((await testControlPlane(env).all("SELECT * FROM relationship_refresh_jobs"))).toEqual([]);
  });

  it("soft-acks without taking a lease when the founder is suppressed after neighbourhood capture", async () => {
    neighbourhood.mockImplementation(async () => {
      await testControlPlane(env).run(
        "UPDATE users SET status = 'deleting' WHERE id = ?",
        FOUNDER_TENANT_ID,
      );
      return [{ id: other, score: 0.8, url: "" }];
    });
    await processRelationshipJudge(job, runtime, services);
    expect(provider).not.toHaveBeenCalled();
    expect((await testControlPlane(env).all("SELECT * FROM relationship_refresh_jobs"))).toEqual([]);
  });

  it("logs neighbours_changed when a neighbour version drifts before admission", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const neighbourPrefix = buildKeyPrefix(other, createdAt);
    const load = PgReadingStore.prototype.loadReadingById;
    let captured = false;
    vi.spyOn(PgReadingStore.prototype, "loadReadingById").mockImplementation(async function (this: PgReadingStore, readingId) {
      const result = await load.call(this, readingId);
      if (!captured && readingId === other) {
        captured = true;
        const neighbour = (await testStore().readManifest(neighbourPrefix))!;
        await testStore().writeManifest(neighbourPrefix, { ...neighbour, title: "Drifted neighbour" });
      }
      return result;
    });
    await processRelationshipJudge(job, runtime, services);
    expect(provider).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(call => String(call[0])).join("\n")).toContain("neighbours_changed");
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
    expect((await testStore().readManifest(keyPrefix))!.novelty_verdict).toBe("familiar");
  });

  it("retries a definitive 429 without treating it as an uncertain dispatch", async () => {
    provider.mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }));
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow(/rate limited/);
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledTimes(2);
    expect((await testStore().readManifest(keyPrefix))!.novelty_verdict).toBe("familiar");
  });

  it("discards a result if a neighbour finishes reprocessing during the call", async () => {
    provider.mockImplementationOnce(async () => {
      const prefix = buildKeyPrefix(other, createdAt);
      const neighbour = (await testStore().readManifest(prefix))!;
      await testStore().writeManifest(prefix, { ...neighbour, summary_markdown: "Reprocessed content" });
      return response();
    });
    await processRelationshipJudge(job, runtime, services);
    expect(await testStore().readManifest(keyPrefix)).toEqual(original);
    expect((await testStore().findListIndexItem(id))!.novelty_verdict).toBe("novel");
  });

  it("does not let an early duplicate bypass Retry-After", async () => {
    provider.mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "120" } }));
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow(/rate limited/);
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toMatchObject({ name: "DeferPaidWorkError" });
    expect(provider).toHaveBeenCalledOnce();
  });

  it("does not apply a saved result after a neighbour version changes", async () => {
    const replace = PgReadingWriter.prototype.replacePublishedIf;
    let fail = true;
    vi.spyOn(PgReadingWriter.prototype, "replacePublishedIf").mockImplementation(async function (this: PgReadingWriter, ...args) {
      if (fail) { fail = false; throw new Error("manifest unavailable"); }
      return replace.apply(this, args);
    });
    await expect(processRelationshipJudge(job, runtime, services)).rejects.toThrow("manifest unavailable");
    const prefix = buildKeyPrefix(other, createdAt);
    const neighbour = (await testStore().readManifest(prefix))!;
    await testStore().writeManifest(prefix, { ...neighbour, tldr: "Changed neighbour" });
    await processRelationshipJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
    expect(await testStore().readManifest(keyPrefix)).toEqual(original);
  });

  it("delays expected spend deferrals without consuming queue retries", async () => {
    await testControlPlane(env).run(
      "UPDATE tenant_limits SET daily_spend_microdollars = 1 WHERE tenant_id = ?",
      FOUNDER_TENANT_ID,
    );
    const send = vi.fn(async () => {});
    runtime.RELATIONSHIP_REFRESH_JOBS = { send } as unknown as Queue;
    const ack = vi.fn(); const retry = vi.fn();
    await consumeRelationshipRefresh({ body: job, ack, retry } as unknown as Message<unknown>, runtime, undefined, services);
    expect(send).toHaveBeenCalledWith({ ...job, deferredAt: expect.any(String) }, { delaySeconds: 15 });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("falls back to retry if delayed enqueue fails", async () => {
    await testControlPlane(env).run(
      "UPDATE tenant_limits SET daily_spend_microdollars = 1 WHERE tenant_id = ?",
      FOUNDER_TENANT_ID,
    );
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
    expect(await testStore().readManifest(keyPrefix)).toEqual(original);
  });

  it("acks a missing founder key without a provider call or a deployment-key request", async () => {
    runtime.TENANT_PROVIDER_KEYS = "1";
    runtime.OPENAI_API_KEY = "sk-deployment-not-used";
    runtime.PROVIDER_KEY_SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    const ack = vi.fn();
    const retry = vi.fn();
    await consumeRelationshipRefresh({ body: job, ack, retry } as unknown as Message<unknown>, runtime, undefined, services);
    expect(provider).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(logged.join("\n")).toContain("connect a key, then retry");
    expect(logged.join("\n")).not.toContain("sk-deployment-not-used");
  });

  it("pays the founder refresh with the founder's stored key", async () => {
    const founderKey = "sk-founder-refresh-4242";
    runtime.TENANT_PROVIDER_KEYS = "1";
    runtime.OPENAI_API_KEY = "sk-deployment-not-used";
    runtime.PROVIDER_KEY_SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    await upsertProviderCredential(testControlPlane(env), {
      tenantId: FOUNDER_TENANT_ID,
      plaintext: founderKey,
      root: { secret: parseProviderKeySecret(runtime.PROVIDER_KEY_SECRET), version: 1 },
      nowMs: Date.parse(runAt),
      validatedAtMs: Date.parse(runAt),
    });
    await processRelationshipJudge(job, runtime, services);
    expect(provider.mock.calls.map((call) => new Headers(call[1]?.headers).get("authorization"))).toEqual([
      "Bearer sk-founder-refresh-4242",
    ]);
    const checkpoint = await testControlPlane(env).first<{ result_json: string }>(
      "SELECT result_json::text AS result_json FROM relationship_refresh_jobs WHERE reading_id = ?",
      id,
    );
    expect(checkpoint?.result_json ?? "").not.toContain(founderKey);
    expect(checkpoint?.result_json ?? "").not.toContain("sk-deployment-not-used");
  });

});
