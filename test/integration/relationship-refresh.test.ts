import { env } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../../src/index";
import { REFRESH_CRON, REFRESH_SCAN_SIZE, consumeRelationshipRefresh, scheduleRelationshipRefresh, type RefreshEnvelope } from "../../src/relationship-refresh";
import { buildKeyPrefix, r2KeyLayout } from "../../src/modules/stores/layout";
import { PgSimilarityStore } from "../../src/modules/stores/postgres/similarity-store";
import type { SimilarityMatch } from "../../src/modules/stores/similarity";
import { FOUNDER_TENANT_ID, OTHER_TENANT_ID, founderTenant } from "../helpers/tenant-fixtures";
import { testReadingsFor } from "../helpers/test-readings";
import type { Manifest } from "../../src/schemas/manifest";
import { testControlPlane } from "../helpers/control-plane-db";

const NOW = Date.parse("2026-09-06T03:07:00Z");
const ROOT = `u/${FOUNDER_TENANT_ID}/`;
const KEY = () => r2KeyLayout(ROOT).refreshCursorKey();
let runtime: Env;
let queued: RefreshEnvelope[];
let query: ReturnType<typeof vi.fn<(id: string, topK: number) => Promise<SimilarityMatch[] | null>>>;
let sendBatch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  queued = [];
  query = vi.fn(async (id: string) => [{ id, score: 1, url: "" }]);
  sendBatch = vi.fn(async (batch: { body: RefreshEnvelope }[]) => {
    queued.push(...batch.map(x => x.body));
  });
  runtime = {
    ...env,
    RELATIONSHIP_REFRESH: "1", REFRESH_MAX_JUDGEMENTS: "2",
    RELATIONSHIP_REFRESH_JOBS: {
      send: vi.fn(async (body: RefreshEnvelope) => { queued.push(body); }), sendBatch,
    } as unknown as Queue<RefreshEnvelope>,
  } as unknown as Env;
  // Neighbourhoods come from pgvector. These tests are about what the scan does
  // with a neighbourhood, so `query` scripts one: its matches, or null for a
  // reading with no embedding. The similarity store has its own suite.
  vi.spyOn(PgSimilarityStore.prototype, "queryByVectorId").mockImplementation((id, topK) => query(id, topK));
});
afterEach(() => vi.restoreAllMocks());

async function seed(n: number): Promise<Manifest[]> {
  const store = testReadingsFor(founderTenant());
  const manifests: Manifest[] = [];
  for (let i = 0; i < n; i++) {
    const id = `rd_${String(i).padStart(10, "0")}`;
    const m: Manifest = {
      id, url: `https://example.com/${i}`, url_hash: "a".repeat(64), status: "ready",
      novelty_verdict: "familiar", connections: [],
      content_type: "text/html", content_status: "captured", content_bytes: 1,
      content_sha256: "b".repeat(64), created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
    };
    manifests.push(m);
    await store.seed(m);
  }
  return manifests;
}

async function deliver(body: RefreshEnvelope) {
  const ack = vi.fn(); const retry = vi.fn();
  await worker.queue({ queue: "reading-lite-staging-refresh", messages: [{ body, ack, retry }] } as unknown as MessageBatch<unknown>, runtime);
  return { ack, retry };
}
async function drainScans() {
  for (let count = 0; count < 100; count++) {
    const idx = queued.findIndex(x => x.kind === "scan");
    if (idx < 0) return;
    const result = await deliver(queued.splice(idx, 1)[0]!);
    expect(result.retry).not.toHaveBeenCalled();
  }
  throw new Error("scan continuation loop");
}
const judges = () => queued.filter(x => x.kind === "judge");
const tensions = () => queued.flatMap(x => x.kind === "tension" ? [`${x.a.id}|${x.b.id}`] : []);

// Readings the tension pre-filter admits: summary text and shared keywords.
async function seedTensionable(n: number, overrides: (i: number) => Partial<Manifest> = () => ({})): Promise<Manifest[]> {
  const manifests = await seed(n);
  const store = testReadingsFor(founderTenant());
  return Promise.all(manifests.map(async (m, i) => {
    const next = { ...m, title: `Reading ${i}`, tldr: `Summary ${i}`, summary_markdown: `Stored summary ${i}.`,
      keywords: ["alpha", "beta", "gamma"], ...overrides(i) };
    await store.seed(next);
    return next;
  }));
}
// Every reading is every other reading's floored neighbour.
function allNeighbours(manifests: Manifest[]) {
  query.mockImplementation(async (id) => [
    { id, score: 1, url: "" },
    ...manifests.filter(m => m.id !== id).map(m => ({ id: m.id, score: 0.9, url: "" })),
  ]);
}

describe("relationship refresh scan", () => {
  it("finishes all scan shards before enqueueing capped judges, and resumes next night", async () => {
    const manifests = await seed(REFRESH_SCAN_SIZE + 2);
    await scheduleRelationshipRefresh(runtime, NOW);
    const first = queued.shift()!;
    await deliver(first);
    expect(query).toHaveBeenCalledTimes(REFRESH_SCAN_SIZE);
    expect(judges()).toHaveLength(0);
    await deliver(first); // stale duplicate must not repeat a shard
    expect(query).toHaveBeenCalledTimes(REFRESH_SCAN_SIZE);
    await drainScans();
    expect(query).toHaveBeenCalledTimes(manifests.length);
    expect(judges()).toHaveLength(2);
    await scheduleRelationshipRefresh(runtime, NOW);
    await drainScans();
    expect(judges()).toHaveLength(2);
    await scheduleRelationshipRefresh(runtime, NOW + 86_400_000);
    await drainScans();
    expect(judges()).toHaveLength(4);
    expect(query).toHaveBeenCalledTimes(manifests.length);
    expect(new Set(judges().map(x => x.kind === "judge" && x.readingId)).size).toBe(4);
    const store = testReadingsFor(founderTenant());
    for (const m of manifests) expect(await store.manifest(m.id)).toEqual(m);
  });

  it("finds a fifth ready neighbour behind a stale vector", async () => {
    const manifests = await seed(6);
    const target = manifests[0]!;
    const known = manifests.slice(1, 5).map(m => m.id);
    const store = testReadingsFor(founderTenant());
    await store.seed({
      ...target, connections: known.map(id => ({ id, reason: "Known" })),
      connections_neighbourhood_ids: known,
    });
    query.mockImplementation(async (id, topK) => [
      { id, score: 1, url: "" },
      { id: "rd_9999999999", score: 0.99, url: "" },
      ...manifests.slice(1).map((m, i) => ({ id: m.id, score: 0.9 - i * 0.01, url: "" })),
    ].slice(0, topK));
    await scheduleRelationshipRefresh(runtime, NOW);
    await drainScans();
    expect(judges()).toContainEqual(expect.objectContaining({ readingId: target.id }));
  });

  it("keeps gate-off scheduled work free of any binding access", async () => {
    const disabled = new Proxy({ RELATIONSHIP_REFRESH: "0" }, { get(t, k) {
      if (k === "RELATIONSHIP_REFRESH") return t.RELATIONSHIP_REFRESH;
      throw new Error(`unexpected access ${String(k)}`);
    } }) as Env;
    await worker.scheduled({ cron: REFRESH_CRON, scheduledTime: NOW } as ScheduledController, disabled);
  });

  it("routes the nightly cron without running digest/wipe fan-out", async () => {
    await seed(1);
    runtime.DIGEST_JOBS = { send: vi.fn() } as unknown as Queue;
    runtime.ACCOUNT_WIPE_JOBS = { send: vi.fn() } as unknown as Queue;
    await worker.scheduled({ cron: REFRESH_CRON, scheduledTime: NOW } as ScheduledController, runtime);
    expect(queued).toHaveLength(1);
    expect(runtime.DIGEST_JOBS.send).not.toHaveBeenCalled();
    expect(runtime.ACCOUNT_WIPE_JOBS.send).not.toHaveBeenCalled();
  });

  it.each(["REFRESH_MAX_JUDGEMENTS", "REFRESH_MAX_TENSION_JUDGEMENTS"] as const)("rejects an invalid %s before writes", async (name) => {
    for (const cap of ["0", "-1", "1.5", "abc", "1001"]) {
      runtime[name] = cap;
      await expect(scheduleRelationshipRefresh(runtime, NOW)).rejects.toThrow(name);
    }
    expect(await env.READINGS_BUCKET.get(KEY())).toBeNull();
    expect(queued).toEqual([]);
  });

  it("retries query errors without advancing the cursor or writing manifests", async () => {
    await seed(1);
    await scheduleRelationshipRefresh(runtime, NOW);
    const body = queued.shift()!;
    const before = await (await env.READINGS_BUCKET.get(KEY()))!.text();
    query.mockRejectedValueOnce(new Error("vector outage"));
    expect((await deliver(body)).retry).toHaveBeenCalledOnce();
    expect(await (await env.READINGS_BUCKET.get(KEY()))!.text()).toBe(before);
    await deliver(body);
    await drainScans();
    expect(judges()).toHaveLength(1);
  });

  it("rejects a non-founder envelope without creating another tenant's cursor", async () => {
    await seed(1);
    await scheduleRelationshipRefresh(runtime, NOW);
    const body = { ...queued.shift()!, tenantId: OTHER_TENANT_ID };
    expect((await deliver(body)).ack).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(await env.READINGS_BUCKET.get(r2KeyLayout(`u/${OTHER_TENANT_ID}/`).refreshCursorKey())).toBeNull();
  });
  it("reserves allowance before a failed judge send and retries the same identities", async () => {
    await seed(3);
    await scheduleRelationshipRefresh(runtime, NOW);
    await deliver(queued.shift()!); // scan
    await deliver(queued.shift()!); // reserve
    const pendingMessage = queued.shift()!;
    const reserved = await (await env.READINGS_BUCKET.get(KEY()))!.json<{ dispatched: number; pending: unknown[] }>();
    expect(reserved.dispatched).toBe(2);
    expect(reserved.pending).toHaveLength(2);
    sendBatch.mockRejectedValueOnce(new Error("uncertain queue send"));
    expect((await deliver(pendingMessage)).retry).toHaveBeenCalledOnce();
    await deliver(pendingMessage);
    const calls = sendBatch.mock.calls.map(call => call[0]);
    expect(calls[0]).toEqual(calls[1]);
    expect(judges()).toHaveLength(2);
    await deliver(pendingMessage); // completed stale retry
    expect(sendBatch).toHaveBeenCalledTimes(2);
    await scheduleRelationshipRefresh(runtime, NOW);
    await drainScans();
    expect(judges()).toHaveLength(2);
  });

  it("recovers a lost continuation through queue retry without another cron delivery", async () => {
    await seed(REFRESH_SCAN_SIZE + 1);
    await scheduleRelationshipRefresh(runtime, NOW);
    const body = queued.shift()!;
    vi.mocked(runtime.RELATIONSHIP_REFRESH_JOBS!.send).mockRejectedValueOnce(new Error("continuation lost"));
    expect((await deliver(body)).retry).toHaveBeenCalledOnce();
    expect((await deliver(body)).ack).toHaveBeenCalledOnce();
    expect(queued).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(REFRESH_SCAN_SIZE);
    await drainScans();
    expect(query).toHaveBeenCalledTimes(REFRESH_SCAN_SIZE + 1);
    expect(judges()).toHaveLength(2);
    await deliver(body); // A stale retry after the cap must not restart work.
    expect(queued.filter(x => x.kind === "scan")).toHaveLength(0);
    expect(judges()).toHaveLength(2);
  });

  it("does not enqueue after losing the cursor CAS", async () => {
    await seed(1);
    await scheduleRelationshipRefresh(runtime, NOW);
    const body = queued.shift()!;
    const bucket = env.READINGS_BUCKET;
    runtime.READINGS_BUCKET = new Proxy(bucket, { get(target, key) {
      if (key === "put") return vi.fn(async () => null);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect((await deliver(body)).ack).toHaveBeenCalledOnce();
    expect(queued).toHaveLength(0);
    expect((await (await bucket.get(KEY()))!.json<{ scan_offset: number }>()).scan_offset).toBe(0);
  });

  it("skips purged, in-TTL reprocessing and vectorless readings", async () => {
    const manifests = await seed(3);
    await scheduleRelationshipRefresh(runtime, NOW);
    const store = testReadingsFor(founderTenant());
    const [purged, running, vectorless] = manifests;
    await store.purge(purged!.id);
    await store.seed({
      ...running!, active_attempt: { id: "at_test", trigger: "reprocess", status: "running", stage: "queued", started_at: new Date().toISOString() },
    });
    query.mockResolvedValue(null);
    await drainScans();
    // Only the reading with no embedding is asked for a neighbourhood.
    expect(query.mock.calls.map(([id]) => id)).toEqual([vectorless!.id]);
    expect(judges()).toHaveLength(0);
  });

  it("keeps a zombie-running ready target as a scan candidate", async () => {
    const [target] = await seed(1);
    await testReadingsFor(founderTenant()).seed({
      ...target!,
      active_attempt: { id: "at_zombie", trigger: "reprocess", status: "running", stage: "queued", started_at: "2026-09-01T00:00:00Z" },
    });
    await scheduleRelationshipRefresh(runtime, NOW);
    await drainScans();
    expect(judges()).toContainEqual(expect.objectContaining({ readingId: target!.id }));
  });

  it("omits an in-TTL running target when the scan clock is services.now()", async () => {
    const nowIso = "2026-09-06T03:07:00.000Z";
    const [target] = await seed(1);
    await testReadingsFor(founderTenant()).seed({
      ...target!,
      active_attempt: { id: "at_live", trigger: "reprocess", status: "running", stage: "queued", started_at: "2026-09-06T03:06:00.000Z" },
    });
    await scheduleRelationshipRefresh(runtime, NOW);
    const services = { fetch: async () => new Response(), now: () => nowIso, newId: () => crypto.randomUUID(), lookup: async () => [] };
    for (let count = 0; count < 100; count++) {
      const idx = queued.findIndex(x => x.kind === "scan");
      if (idx < 0) break;
      const ack = vi.fn(); const retry = vi.fn();
      await consumeRelationshipRefresh(
        { body: queued.splice(idx, 1)[0]!, ack, retry } as unknown as Message<unknown>,
        runtime, () => crypto.randomUUID(), services,
      );
      expect(retry).not.toHaveBeenCalled();
    }
    expect(judges()).toHaveLength(0);
  });

  it("suppresses an already queued scan after founder deletion", async () => {
    await seed(1);
    await scheduleRelationshipRefresh(runtime, NOW);
    const before = await (await env.READINGS_BUCKET.get(KEY()))!.text();
    await testControlPlane(env).run("UPDATE users SET status = 'deleting' WHERE id = ?", FOUNDER_TENANT_ID);
    await drainScans();
    expect(query).not.toHaveBeenCalled();
    expect(await (await env.READINGS_BUCKET.get(KEY()))!.text()).toBe(before);
  });

  it("leaves a corrupt cursor intact and fails closed", async () => {
    await env.READINGS_BUCKET.put(KEY(), JSON.stringify({ version: 0 }));
    await expect(scheduleRelationshipRefresh(runtime, NOW)).rejects.toThrow();
    expect(queued).toHaveLength(0);
    expect(await (await env.READINGS_BUCKET.get(KEY()))!.json()).toEqual({ version: 0 });
  });

  it("uses the default cap and starts a fresh full scan after a completed night", async () => {
    await seed(1);
    delete runtime.REFRESH_MAX_JUDGEMENTS;
    await scheduleRelationshipRefresh(runtime, NOW);
    expect((await (await env.READINGS_BUCKET.get(KEY()))!.json<{ limit: number }>()).limit).toBe(100);
    await drainScans();
    const firstJudge = judges()[0];
    await scheduleRelationshipRefresh(runtime, NOW + 86_400_000);
    await drainScans();
    expect(query).toHaveBeenCalledTimes(2);
    expect(judges()).toHaveLength(2);
    expect(judges()[1]).not.toEqual(firstJudge);
  });

  it("keeps judge deliveries inert with the gate disabled", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const inert = new Proxy({ RELATIONSHIP_REFRESH: "0" }, { get(t, k) {
      if (k === "RELATIONSHIP_REFRESH") return t.RELATIONSHIP_REFRESH;
      throw new Error(`unexpected access ${String(k)}`);
    } }) as Env;
    const ack = vi.fn();
    await worker.queue({ queue: "reading-lite-refresh", messages: [{ ack, body: {
      version: 1, kind: "judge", tenantId: FOUNDER_TENANT_ID, runAt: new Date(NOW).toISOString(),
      readingId: "rd_0000000000", keyPrefix: "readings/test",
    } }] } as unknown as MessageBatch<unknown>, inert);
    expect(ack).toHaveBeenCalledOnce();
  });

  it("collects each eligible pair once and dispatches pairs after the connection judges, under their own cap", async () => {
    const manifests = await seedTensionable(3);
    allNeighbours(manifests);
    runtime.REFRESH_MAX_TENSION_JUDGEMENTS = "2";
    await scheduleRelationshipRefresh(runtime, NOW);
    await drainScans();
    const [a, b, c] = manifests.map(m => m.id);
    expect(judges()).toHaveLength(2);
    expect(tensions()).toEqual([`${a}|${b}`, `${a}|${c}`]);
    const kinds = queued.map(x => x.kind);
    expect(kinds.indexOf("tension")).toBeGreaterThan(kinds.lastIndexOf("judge"));
    expect(queued.find(x => x.kind === "tension")).toEqual({
      version: 1, kind: "tension", tenantId: FOUNDER_TENANT_ID, runAt: new Date(NOW).toISOString(),
      a: { id: a, key_prefix: expect.stringMatching(/^readings\//) }, b: { id: b, key_prefix: expect.stringMatching(/^readings\//) },
    });
    // The next night finishes the same scan's remainder of both kinds.
    await scheduleRelationshipRefresh(runtime, NOW + 86_400_000);
    await drainScans();
    expect(judges()).toHaveLength(3);
    expect(tensions()).toEqual([`${a}|${b}`, `${a}|${c}`, `${b}|${c}`]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("collects no pair that is already judged or below the overlap filter", async () => {
    const [a, b] = ["rd_0000000000", "rd_0000000001"];
    const judgedWith = (partner: string) => ({ tensions_judged: [{ id: partner, judged_at: "2026-09-02T00:00:00.000Z" }] });
    const manifests = await seedTensionable(3, i =>
      i === 0 ? judgedWith(b) : i === 1 ? judgedWith(a) : { keywords: ["unrelated"] });
    allNeighbours(manifests);
    await scheduleRelationshipRefresh(runtime, NOW);
    await drainScans();
    expect(tensions()).toEqual([]);
  });

  it("does not hold the next night's scan for leftover pairs; the fresh scan finds them again", async () => {
    const manifests = await seedTensionable(3);
    allNeighbours(manifests);
    runtime.REFRESH_MAX_JUDGEMENTS = "100";
    runtime.REFRESH_MAX_TENSION_JUDGEMENTS = "1";
    await scheduleRelationshipRefresh(runtime, NOW);
    await drainScans();
    expect(tensions()).toHaveLength(1);
    await scheduleRelationshipRefresh(runtime, NOW + 86_400_000);
    await drainScans();
    expect(query).toHaveBeenCalledTimes(6);
    const cursor = await (await env.READINGS_BUCKET.get(KEY()))!.json<{ run_at: string; tension_candidates: unknown[] }>();
    expect(cursor.run_at).toBe(new Date(NOW + 86_400_000).toISOString());
    expect(cursor.tension_candidates).toHaveLength(3);
    expect(tensions()).toHaveLength(2);
  });

  it("continues a cursor written before tension pairs existed, dispatching pairs only from the next night", async () => {
    const manifests = await seedTensionable(2);
    allNeighbours(manifests);
    const runAt = new Date(NOW).toISOString();
    await env.READINGS_BUCKET.put(KEY(), JSON.stringify({
      version: 1, token: "legacy", run_at: runAt, budget_at: runAt, limit: 2, dispatched: 0,
      targets: manifests.map(m => ({ id: m.id, key_prefix: buildKeyPrefix(m.id, m.created_at) })),
      scan_offset: 0, candidates: [], judge_offset: 0, pending: [],
    }));
    await deliver({ version: 1, kind: "scan", tenantId: FOUNDER_TENANT_ID, token: "legacy" });
    await drainScans();
    expect(judges()).toHaveLength(2);
    expect(tensions()).toEqual([]);
    await scheduleRelationshipRefresh(runtime, NOW + 86_400_000);
    await drainScans();
    expect(tensions()).toEqual([manifests.map(m => m.id).join("|")]);
  });

  it.each([1, 2])("uses a new nightly cap of %i after recovering a prior pending batch", async (limit) => {
    await seed(5);
    await scheduleRelationshipRefresh(runtime, NOW);
    await deliver(queued.shift()!); // scan
    await deliver(queued.shift()!); // reserve two, then interrupt before send
    queued = []; // lost continuation
    runtime.REFRESH_MAX_JUDGEMENTS = String(limit);
    await scheduleRelationshipRefresh(runtime, NOW + 86_400_000);
    await drainScans();
    expect(judges()).toHaveLength(2 + limit); // yesterday's reservation plus tonight's allowance
    const cursor = await (await env.READINGS_BUCKET.get(KEY()))!.json<{ budget_at: string; dispatched: number }>();
    expect(cursor.budget_at).toBe(new Date(NOW + 86_400_000).toISOString());
    expect(cursor.dispatched).toBe(limit);
    await scheduleRelationshipRefresh(runtime, NOW + 86_400_000);
    await drainScans();
    expect(judges()).toHaveLength(2 + limit);
  });

});
