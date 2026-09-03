import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_WIPE_GRACE_MS,
  accountWipeProgressKey,
  consumeAccountWipeMessage,
  fanOutDueAccountWipes,
  handleAccountWipeDeadLetter,
  processAccountWipeJob,
} from "../../src/account-wipe";
import { accountWipeEnvelopeV1, type AccountWipeEnvelopeV1 } from "../../src/control-plane/wipe-envelope";
import { parseTenantId } from "../../src/control-plane/ids";
import worker, { type Env } from "../../src/index";
import { tenantKeyRoot } from "../../src/modules/stores/reading-store";
import { tenantVectorId } from "../../src/modules/stores/similarity-store";
import type { ListIndexItem } from "../../src/schemas/api";
import {
  OTHER_TENANT_ID,
  insertSecondTenant,
  otherTenant,
  testReadingStore,
} from "../helpers/tenant-fixtures";
import { RateLimitedError } from "../../src/modules/http-retry";

const NOW_MS = Date.parse("2026-09-03T12:00:00.000Z");
const TENANT = parseTenantId(OTHER_TENANT_ID)!;
const PREFIX = tenantKeyRoot(otherTenant(), true);
const ID_A = "rd_0123456780";
const ID_B = "rd_0123456781";

let queued: AccountWipeEnvelopeV1[] = [];
let deleteByIds: ReturnType<typeof vi.fn>;
let queryIndex: ReturnType<typeof vi.fn>;
let vectorOrder: string[];

function installWipeQueue(): AccountWipeEnvelopeV1[] {
  queued = [];
  (env as unknown as { ACCOUNT_WIPE_JOBS: Queue<AccountWipeEnvelopeV1> }).ACCOUNT_WIPE_JOBS = {
    send: vi.fn(async (msg: AccountWipeEnvelopeV1) => {
      queued.push(msg);
    }),
  } as unknown as Queue<AccountWipeEnvelopeV1>;
  return queued;
}

function installVectorizeStub(): ReturnType<typeof vi.fn> {
  vectorOrder = [];
  deleteByIds = vi.fn(async (ids: string[]) => {
    vectorOrder.push("vector");
    return { mutationId: `mut_${vectorOrder.length}_${ids.length}` };
  });
  queryIndex = vi.fn(async () => ({ count: 0, matches: [] }));
  (env as unknown as Env).READINGS_INDEX = {
    upsert: vi.fn(async () => ({ mutationId: "up" })),
    query: queryIndex,
    deleteByIds,
  } as unknown as VectorizeIndex;
  return deleteByIds;
}

async function markDeleting(userId: string, deletingAtMs: number): Promise<void> {
  await env.CONTROL_PLANE.prepare(
    `UPDATE users SET status = 'deleting', deleting_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
  )
    .bind(deletingAtMs, deletingAtMs, userId)
    .run();
}

async function markActive(userId: string): Promise<void> {
  await env.CONTROL_PLANE.prepare(
    `UPDATE users SET status = 'active', deleting_at_ms = NULL, updated_at_ms = ? WHERE id = ?`,
  )
    .bind(NOW_MS, userId)
    .run();
}

async function emptyPrefix(prefix: string): Promise<void> {
  for (;;) {
    const list = await env.READINGS_BUCKET.list({ prefix, limit: 1000 });
    if (list.objects.length === 0) return;
    await env.READINGS_BUCKET.delete(list.objects.map((obj) => obj.key));
  }
}

async function listPrefixKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const list = await env.READINGS_BUCKET.list({
      prefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    keys.push(...list.objects.map((obj) => obj.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return keys;
}

function indexItem(id: string): ListIndexItem {
  return {
    id,
    key_prefix: `readings/2026/04/26T200000Z-${id}`,
    url: `https://example.com/${id}`,
    status: "ready",
    created_at: "2026-04-26T20:00:00.000Z",
  };
}

async function seedTenantObjects(ids: string[]): Promise<void> {
  const reader = testReadingStore(env, otherTenant());
  await reader.writeListIndex({ version: 1, items: ids.map(indexItem) });
  for (const id of ids) {
    await reader.writeByIdPointer(id, { id, key_prefix: `readings/2026/04/26T200000Z-${id}` });
    await env.READINGS_BUCKET.put(
      `${PREFIX}readings/2026/04/26T200000Z-${id}/manifest.json`,
      JSON.stringify({ id }),
    );
  }
}

function memoryBucket(initial: Iterable<string> = []): {
  bucket: R2Bucket;
  keysUnder(prefix: string): string[];
} {
  const store = new Map<string, string>();
  for (const key of initial) store.set(key, "x");
  const bucket = {
    async put(key: string, value: string | ArrayBuffer | ReadableStream | Blob) {
      store.set(key, typeof value === "string" ? value : "x");
      return {} as R2Object;
    },
    async get(key: string) {
      const value = store.get(key);
      if (value === undefined) return null;
      return { text: async () => value };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
    async list(opts: R2ListOptions = {}) {
      const prefix = opts.prefix ?? "";
      const limit = opts.limit ?? 1000;
      const all = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = opts.cursor ? all.indexOf(opts.cursor) + 1 : 0;
      const page = all.slice(start, start + limit);
      const truncated = start + page.length < all.length;
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        cursor: truncated ? page[page.length - 1] : undefined,
      };
    },
  } as unknown as R2Bucket;
  return {
    bucket,
    keysUnder: (prefix: string) => [...store.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
}

async function wipeEnv(): Promise<Env> {
  return env as unknown as Env;
}

describe("account wipe (195b PR1)", () => {
  beforeEach(async () => {
    await insertSecondTenant(env as unknown as Env);
    await markActive(OTHER_TENANT_ID);
    await emptyPrefix(PREFIX);
    await env.READINGS_BUCKET.delete(accountWipeProgressKey(OTHER_TENANT_ID));
    installWipeQueue();
    installVectorizeStub();
  });

  afterEach(async () => {
    await markActive(OTHER_TENANT_ID);
  });

  it("skips tenants still inside the 7-day grace window", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS);
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      { nowMs: NOW_MS },
    );
    expect(result).toEqual({ kind: "skipped", reason: "grace_period" });
    expect(deleteByIds).not.toHaveBeenCalled();
    expect(await listPrefixKeys(PREFIX)).not.toEqual([]);
  });

  it("force skips grace and wipes the tenant prefix", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS);
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT, force: true }),
      await wipeEnv(),
      { nowMs: NOW_MS },
    );
    expect(result.kind).toBe("complete");
    expect(deleteByIds).toHaveBeenCalled();
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
  });

  it("submits Vectorize deleteByIds while R2 objects still exist, then empties the prefix", async () => {
    await seedTenantObjects([ID_A, ID_B]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    deleteByIds.mockImplementation(async (ids: string[]) => {
      vectorOrder.push("vector");
      const remaining = await listPrefixKeys(PREFIX);
      expect(remaining.length).toBeGreaterThan(0);
      return { mutationId: `mut_${ids.length}` };
    });

    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      { nowMs: NOW_MS },
    );
    expect(result.kind).toBe("complete");
    expect(vectorOrder[0]).toBe("vector");
    expect(deleteByIds).toHaveBeenCalledWith([
      tenantVectorId(OTHER_TENANT_ID, ID_A),
      tenantVectorId(OTHER_TENANT_ID, ID_B),
    ]);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    // Vectorize deletes are async: we recorded a mutationId and did not query
    // the index to pretend it is synchronously empty.
    expect(result.kind === "complete" && result.mutation_ids.length).toBeGreaterThan(0);
    expect(queryIndex).not.toHaveBeenCalled();
  });

  it("pages more than 1000 R2 objects and resumes from a stored cursor", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const keys = Array.from({ length: 1001 }, (_, i) => `${PREFIX}pad/${String(i).padStart(4, "0")}`);
    const memory = memoryBucket(keys);
    const jobEnv = { ...(await wipeEnv()), READINGS_BUCKET: memory.bucket };
    const first = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      jobEnv,
      { nowMs: NOW_MS, maxObjectPages: 1, maxVectorBatches: 20 },
    );
    expect(first.kind).toBe("continue");
    expect(memory.keysUnder(PREFIX).length).toBeGreaterThan(0);
    const progressObj = await memory.bucket.get(accountWipeProgressKey(OTHER_TENANT_ID));
    expect(progressObj).not.toBeNull();
    const progress = JSON.parse(await progressObj!.text()) as { r2_cursor?: string; phase: string };
    expect(progress.phase).toBe("objects");
    expect(progress.r2_cursor).toBeTruthy();

    const second = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      jobEnv,
      { nowMs: NOW_MS },
    );
    expect(second.kind).toBe("complete");
    expect(memory.keysUnder(PREFIX)).toEqual([]);
  });

  it("completes an empty tenant as a no-op success", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      { nowMs: NOW_MS },
    );
    expect(result).toEqual({ kind: "complete", objects_deleted: 0, mutation_ids: [] });
    expect(deleteByIds).not.toHaveBeenCalled();
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
  });

  it("redrives an already-wiped prefix as a no-op success", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await processAccountWipeJob(accountWipeEnvelopeV1({ tenantId: TENANT }), await wipeEnv(), {
      nowMs: NOW_MS,
    });
    deleteByIds.mockClear();
    const again = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      { nowMs: NOW_MS },
    );
    expect(again.kind).toBe("complete");
    expect(deleteByIds).not.toHaveBeenCalled();
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
  });

  it("submits vector deletes in 1000-id batches from the list index", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const ids = Array.from({ length: 1001 }, (_, i) => `rd_${String(i).padStart(10, "0")}`);
    const memory = memoryBucket();
    await memory.bucket.put(
      `${PREFIX}index/list.json`,
      JSON.stringify({ version: 1, items: ids.map(indexItem) }),
    );
    const jobEnv = { ...(await wipeEnv()), READINGS_BUCKET: memory.bucket };
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      jobEnv,
      { nowMs: NOW_MS },
    );
    expect(result.kind).toBe("complete");
    expect(deleteByIds).toHaveBeenCalledTimes(2);
    expect((deleteByIds.mock.calls[0]![0] as string[]).length).toBe(1000);
    expect((deleteByIds.mock.calls[1]![0] as string[]).length).toBe(1);
    expect(memory.keysUnder(PREFIX)).toEqual([]);
  });

  it("does not touch another tenant's prefix", async () => {
    await seedTenantObjects([ID_A]);
    const foreignKey = `u/usr_550e8400-e29b-41d4-a716-446655440000/keep.txt`;
    await env.READINGS_BUCKET.put(foreignKey, "stay");
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await processAccountWipeJob(accountWipeEnvelopeV1({ tenantId: TENANT }), await wipeEnv(), {
      nowMs: NOW_MS,
    });
    const foreign = await env.READINGS_BUCKET.get(foreignKey);
    expect(foreign).not.toBeNull();
    await foreign?.text();
  });

  it("cron fan-out enqueues past-grace deleting tenants and skips the grace window", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS);
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 0 });
    expect(queued).toEqual([]);

    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 1 });
    expect(queued).toEqual([accountWipeEnvelopeV1({ tenantId: TENANT })]);
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS + 1 })).toEqual({
      enqueued: 0,
    });
  });

  it("cron fan-out skips entirely when TENANT_DATA_PLANE is off", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await fanOutDueAccountWipes(
        { ...(await wipeEnv()), TENANT_DATA_PLANE: undefined },
        { nowMs: NOW_MS },
      ),
    ).toEqual({ enqueued: 0 });
    expect(queued).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ event: "account_wipe_fanout_skipped", reason: "no_tenant_prefix" }),
    );
    const progressObj = await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID));
    expect(progressObj).toBeNull();
    warn.mockRestore();
  });

  it("re-lists the prefix before done so a stale cursor cannot hide leftover objects", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const keys = [`${PREFIX}keep-a`, `${PREFIX}keep-z`];
    const memory = memoryBucket(keys);
    await memory.bucket.put(
      accountWipeProgressKey(OTHER_TENANT_ID),
      JSON.stringify({
        version: 1,
        phase: "objects",
        vector_offset: 0,
        r2_cursor: `${PREFIX}keep-z`,
        mutation_ids: [],
        objects_deleted: 0,
        updated_at_ms: NOW_MS,
      }),
    );
    const jobEnv = { ...(await wipeEnv()), READINGS_BUCKET: memory.bucket };
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      jobEnv,
      { nowMs: NOW_MS },
    );
    expect(result.kind).toBe("complete");
    expect(memory.keysUnder(PREFIX)).toEqual([]);
  });

  it("cron re-enqueues a done tenant that still has prefix objects", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await env.READINGS_BUCKET.put(
      accountWipeProgressKey(OTHER_TENANT_ID),
      JSON.stringify({
        version: 1,
        phase: "done",
        vector_offset: 0,
        mutation_ids: [],
        objects_deleted: 1,
        updated_at_ms: NOW_MS,
      }),
    );
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 1 });
    expect(queued).toEqual([accountWipeEnvelopeV1({ tenantId: TENANT })]);
    const progressObj = await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID));
    expect(progressObj).not.toBeNull();
    const progress = JSON.parse(await progressObj!.text()) as { phase: string };
    expect(progress.phase).toBe("objects");
  });

  it("scheduled() still fans out wipes when digest fan-out throws", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const digestBomb = new Proxy(env as object, {
      get(target, prop, receiver) {
        if (prop === "DIGEST_JOBS") throw new Error("digest boom");
        return Reflect.get(target, prop, receiver);
      },
    }) as Env;
    await worker.scheduled(
      { scheduledTime: NOW_MS, cron: "*/15 * * * *" } as ScheduledController,
      digestBomb,
    );
    expect(queued).toEqual([accountWipeEnvelopeV1({ tenantId: TENANT })]);
    consoleErr.mockRestore();
  });

  it("scheduled() fans out wipe jobs without dropping digest fan-out", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await worker.scheduled(
      { scheduledTime: NOW_MS, cron: "*/15 * * * *" } as ScheduledController,
      env as unknown as Env,
    );
    expect(queued).toEqual([accountWipeEnvelopeV1({ tenantId: TENANT })]);
  });

  it("queue consumer acks a wipe job and does not enqueue from a malformed body", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS);
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue(
      {
        queue: "reading-lite-wipe",
        messages: [
          {
            id: "m_wipe",
            timestamp: new Date(),
            body: accountWipeEnvelopeV1({ tenantId: TENANT, force: true }),
            attempts: 1,
            ack,
            retry,
          },
        ],
      } as unknown as MessageBatch<unknown>,
      env as unknown as Env,
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();

    const badAck = vi.fn();
    await consumeAccountWipeMessage(
      { body: { version: 9 }, ack: badAck, retry: vi.fn() },
      await wipeEnv(),
      { nowMs: NOW_MS },
    );
    expect(badAck).toHaveBeenCalledOnce();
  });

  it("retries a failed wipe with a delay and logs the error", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    deleteByIds.mockImplementation(async () => {
      throw new RateLimitedError(429, 12_500, "https://vectorize.example/delete");
    });
    const ack = vi.fn();
    const retry = vi.fn();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await consumeAccountWipeMessage(
      {
        body: accountWipeEnvelopeV1({ tenantId: TENANT }),
        ack,
        retry,
        attempts: 1,
      },
      await wipeEnv(),
      { nowMs: NOW_MS },
    );
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 13 });
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("wipe DLQ acks without touching the tenant prefix", async () => {
    await seedTenantObjects([ID_A]);
    const ack = vi.fn();
    await handleAccountWipeDeadLetter({
      body: accountWipeEnvelopeV1({ tenantId: TENANT }),
      ack,
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(await listPrefixKeys(PREFIX)).not.toEqual([]);
  });
});
