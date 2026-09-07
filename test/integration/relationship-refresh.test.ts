import { env } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../../src/index";
import { REFRESH_CRON, REFRESH_SCAN_SIZE, scheduleRelationshipRefresh, type RefreshEnvelope } from "../../src/relationship-refresh";
import { buildKeyPrefix, manifestToIndexItem } from "../../src/modules/stores/reading-store";
import { r2KeyLayout } from "../../src/modules/stores/layout";
import { FOUNDER_TENANT_ID, OTHER_TENANT_ID, testReadingStore } from "../helpers/tenant-fixtures";
import type { Manifest } from "../../src/schemas/manifest";

const NOW = Date.parse("2026-09-06T03:07:00Z");
const ROOT = `u/${FOUNDER_TENANT_ID}/`;
const KEY = () => r2KeyLayout(ROOT).refreshCursorKey();
let runtime: Env;
let queued: RefreshEnvelope[];
let query: ReturnType<typeof vi.fn>;
let sendBatch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  queued = [];
  query = vi.fn(async (id: string) => ({ matches: [{ id, score: 1 }] }));
  sendBatch = vi.fn(async (batch: { body: RefreshEnvelope }[]) => {
    queued.push(...batch.map(x => x.body));
  });
  runtime = {
    ...env,
    RELATIONSHIP_REFRESH: "1", REFRESH_MAX_JUDGEMENTS: "2",
    RELATIONSHIP_REFRESH_JOBS: {
      send: vi.fn(async (body: RefreshEnvelope) => { queued.push(body); }), sendBatch,
    } as unknown as Queue<RefreshEnvelope>,
    READINGS_INDEX: {
      getByIds: vi.fn(async (ids: string[]) => ids.map(id => ({ id }))), queryById: query,
    } as unknown as VectorizeIndex,
  } as unknown as Env;
});
afterEach(() => vi.restoreAllMocks());

async function seed(n: number): Promise<Manifest[]> {
  const store = testReadingStore(env);
  const manifests: Manifest[] = [];
  for (let i = 0; i < n; i++) {
    const id = `rd_${String(i).padStart(10, "0")}`;
    const m: Manifest = {
      id, url: `https://example.com/${i}`, url_hash: "a".repeat(64), status: "ready",
      novelty_verdict: "familiar", connections: [],
      content_type: "text/html", content_status: "captured", content_bytes: 1,
      content_sha256: "b".repeat(64), created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
    };
    manifests.push(m);
    await store.writeManifest(buildKeyPrefix(id, m.created_at), m);
  }
  await store.writeListIndex({ version: 1, items: manifests.map(m => manifestToIndexItem(m, buildKeyPrefix(m.id, m.created_at))) });
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
    const store = testReadingStore(env);
    for (const m of manifests) expect(await store.readManifest(buildKeyPrefix(m.id, m.created_at))).toEqual(m);
  });

  it("finds a fifth ready neighbour behind a stale vector", async () => {
    const manifests = await seed(6);
    const target = manifests[0]!;
    const known = manifests.slice(1, 5).map(m => m.id);
    const store = testReadingStore(env);
    await store.writeManifest(buildKeyPrefix(target.id, target.created_at), {
      ...target, connections: known.map(id => ({ id, reason: "Known" })),
      connections_neighbourhood_ids: known,
    });
    query.mockImplementation(async (id: string, options: { topK: number }) => ({ matches: [
      { id, score: 1 },
      { id: `${FOUNDER_TENANT_ID}:rd_9999999999`, score: 0.99 },
      ...manifests.slice(1).map((m, i) => ({ id: `${FOUNDER_TENANT_ID}:${m.id}`, score: 0.9 - i * 0.01 })),
    ].slice(0, options.topK) }));
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

  it("rejects invalid caps before writes", async () => {
    for (const cap of ["0", "-1", "1.5", "abc", "1001"]) {
      runtime.REFRESH_MAX_JUDGEMENTS = cap;
      await expect(scheduleRelationshipRefresh(runtime, NOW)).rejects.toThrow(/REFRESH_MAX_JUDGEMENTS/);
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

  it("recovers a lost continuation from the persisted cursor on another cron delivery", async () => {
    await seed(REFRESH_SCAN_SIZE + 1);
    await scheduleRelationshipRefresh(runtime, NOW);
    const body = queued.shift()!;
    vi.mocked(runtime.RELATIONSHIP_REFRESH_JOBS!.send).mockRejectedValueOnce(new Error("continuation lost"));
    expect((await deliver(body)).retry).toHaveBeenCalledOnce();
    await deliver(body); // stale retry cannot repeat its committed scan
    expect(queued).toHaveLength(0);
    await scheduleRelationshipRefresh(runtime, NOW);
    await drainScans();
    expect(query).toHaveBeenCalledTimes(REFRESH_SCAN_SIZE + 1);
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

  it("skips purged, reprocessing and vectorless readings", async () => {
    const manifests = await seed(3);
    await scheduleRelationshipRefresh(runtime, NOW);
    const store = testReadingStore(env);
    const [purged, running, vectorless] = manifests;
    await store.removeListIndexItem(purged!.id);
    await store.writeManifest(buildKeyPrefix(running!.id, running!.created_at), {
      ...running!, active_attempt: { id: "at_test", trigger: "reprocess", status: "running", stage: "queued", started_at: "2026-09-06T00:00:00Z" },
    });
    vi.mocked(runtime.READINGS_INDEX.getByIds).mockResolvedValue([]);
    await drainScans();
    expect(runtime.READINGS_INDEX.getByIds).toHaveBeenCalledWith([`${FOUNDER_TENANT_ID}:${vectorless!.id}`]);
    expect(query).not.toHaveBeenCalled();
    expect(judges()).toHaveLength(0);
  });

  it("suppresses an already queued scan after founder deletion", async () => {
    await seed(1);
    await scheduleRelationshipRefresh(runtime, NOW);
    const before = await (await env.READINGS_BUCKET.get(KEY()))!.text();
    await env.CONTROL_PLANE.prepare("UPDATE users SET status = 'deleting' WHERE id = ?").bind(FOUNDER_TENANT_ID).run();
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
