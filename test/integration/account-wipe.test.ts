import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_WIPE_GRACE_MS,
  ACCOUNT_WIPE_IN_FLIGHT_MS,
  ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS,
  ACCOUNT_WIPE_PROBE_RETRY_DELAY_SECONDS,
  accountWipeProgressKey,
  consumeAccountWipeMessage,
  fanOutDueAccountWipes,
  handleAccountWipeDeadLetter,
  processAccountWipeJob,
  type AccountWipeJobDeps,
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
  const etags = new Map<string, string>();
  let etagSeq = 0;
  for (const key of initial) {
    store.set(key, "x");
    etags.set(key, `etag-${++etagSeq}`);
  }
  const bucket = {
    // Models R2's conditional put, so the wipe's compare-and-set is actually
    // exercised through this double instead of silently bypassed: a mismatched
    // etag, or If-None-Match:* against a key that exists, returns null as R2
    // does, and every successful put returns a fresh etag to chain from.
    async put(
      key: string,
      value: string | ArrayBuffer | ReadableStream | Blob,
      opts?: R2PutOptions,
    ) {
      const onlyIf = opts?.onlyIf;
      const current = etags.get(key);
      if (onlyIf instanceof Headers) {
        if (onlyIf.get("If-None-Match") === "*" && current !== undefined) return null;
      } else if (onlyIf && typeof onlyIf === "object" && "etagMatches" in onlyIf) {
        if (current !== (onlyIf as { etagMatches?: string }).etagMatches) return null;
      }
      store.set(key, typeof value === "string" ? value : "x");
      const etag = `etag-${++etagSeq}`;
      etags.set(key, etag);
      return { etag } as R2Object;
    },
    async get(key: string) {
      const value = store.get(key);
      if (value === undefined) return null;
      return { text: async () => value, etag: etags.get(key) };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        store.delete(key);
        etags.delete(key);
      }
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

function wipeJobDeps(extra: Partial<AccountWipeJobDeps> & { clock?: { t: number } } = {}): AccountWipeJobDeps {
  const clock = extra.clock ?? { t: extra.nowMs ?? NOW_MS };
  return {
    nowMs: extra.nowMs ?? clock.t,
    now: extra.now ?? (() => clock.t),
    maxObjectPages: extra.maxObjectPages,
    maxVectorBatches: extra.maxVectorBatches,
  };
}

type WipeProgressSnap = {
  updated_at_ms: number;
  phase: string;
  reading_ids?: string[];
  objects_deleted?: number;
};

function wrapBucketClock(
  bucket: R2Bucket,
  tenantId: string,
  clock: { t: number },
  opts: {
    advanceListMs?: number;
    onProgress?: (progress: WipeProgressSnap) => void | Promise<void>;
  } = {},
): R2Bucket {
  const progressKey = accountWipeProgressKey(tenantId);
  return new Proxy(bucket, {
    get(target, prop, receiver) {
      if (prop === "list") {
        return async (listOpts?: R2ListOptions) => {
          if (opts.advanceListMs) clock.t += opts.advanceListMs;
          return target.list(listOpts as R2ListOptions);
        };
      }
      if (prop === "put") {
        return async (
          key: string,
          value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
          putOpts?: R2PutOptions,
        ) => {
          const result = await target.put(key, value, putOpts);
          if (key === progressKey && typeof value === "string" && opts.onProgress) {
            await opts.onProgress(JSON.parse(value) as WipeProgressSnap);
          }
          return result;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
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
      wipeJobDeps(),
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
      wipeJobDeps(),
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
      if (vectorOrder.length === 1) {
        const remaining = await listPrefixKeys(PREFIX);
        expect(remaining.length).toBeGreaterThan(0);
      }
      return { mutationId: `mut_${ids.length}` };
    });

    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps(),
    );
    expect(result.kind).toBe("complete");
    expect(vectorOrder[0]).toBe("vector");
    const expectedIds = [tenantVectorId(OTHER_TENANT_ID, ID_A), tenantVectorId(OTHER_TENANT_ID, ID_B)];
    expect(deleteByIds.mock.calls[0]?.[0]).toEqual(expectedIds);
    expect(deleteByIds.mock.calls.at(-1)?.[0]).toEqual(expectedIds);
    expect(deleteByIds.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    // Vectorize deletes are async: we recorded a mutationId rather than waiting
    // for the index to report itself empty. The one query is the terminal
    // emptiness probe (Move 1 / F3) — a single assurance read that fails the
    // job, never a poll-until-empty loop.
    expect(result.kind === "complete" && result.mutation_ids.length).toBeGreaterThan(0);
    expect(queryIndex).toHaveBeenCalledTimes(1);
  });

  it("pages more than 1000 R2 objects and resumes from a stored cursor", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const keys = Array.from({ length: 1001 }, (_, i) => `${PREFIX}pad/${String(i).padStart(4, "0")}`);
    const memory = memoryBucket(keys);
    const jobEnv = { ...(await wipeEnv()), READINGS_BUCKET: memory.bucket };
    const first = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      jobEnv,
      wipeJobDeps({ maxObjectPages: 1, maxVectorBatches: 20 }),
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
      wipeJobDeps(),
    );
    expect(second.kind).toBe("complete");
    expect(memory.keysUnder(PREFIX)).toEqual([]);
  });

  it("completes an empty tenant as a no-op success", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps(),
    );
    expect(result).toEqual({ kind: "complete", objects_deleted: 0, mutation_ids: [] });
    expect(deleteByIds).not.toHaveBeenCalled();
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
  });

  it("redrives an already-wiped prefix as a no-op success", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await processAccountWipeJob(accountWipeEnvelopeV1({ tenantId: TENANT }), await wipeEnv(), wipeJobDeps());
    deleteByIds.mockClear();
    const again = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps(),
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
      wipeJobDeps(),
    );
    expect(result.kind).toBe("complete");
    expect(deleteByIds).toHaveBeenCalledTimes(4);
    expect((deleteByIds.mock.calls[0]![0] as string[]).length).toBe(1000);
    expect((deleteByIds.mock.calls[1]![0] as string[]).length).toBe(1);
    expect((deleteByIds.mock.calls[2]![0] as string[]).length).toBe(1000);
    expect((deleteByIds.mock.calls[3]![0] as string[]).length).toBe(1);
    expect(memory.keysUnder(PREFIX)).toEqual([]);
  });

  it("does not wipe the tenant prefix when READINGS_INDEX is unbound", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const before = await listPrefixKeys(PREFIX);
    expect(before).not.toEqual([]);
    const ack = vi.fn();
    const retry = vi.fn();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        { ...(await wipeEnv()), READINGS_INDEX: undefined },
        wipeJobDeps(),
      ),
    ).rejects.toThrow(/index_unbound/);
    await consumeAccountWipeMessage(
      {
        body: accountWipeEnvelopeV1({ tenantId: TENANT }),
        ack,
        retry,
        attempts: 1,
      },
      { ...(await wipeEnv()), READINGS_INDEX: undefined },
      wipeJobDeps(),
    );
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalled();
    expect(deleteByIds).not.toHaveBeenCalled();
    expect(await listPrefixKeys(PREFIX)).toEqual(before);
    consoleErr.mockRestore();
  });

  it("does not touch another tenant's prefix", async () => {
    await seedTenantObjects([ID_A]);
    const foreignKey = `u/usr_550e8400-e29b-41d4-a716-446655440000/keep.txt`;
    await env.READINGS_BUCKET.put(foreignKey, "stay");
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await processAccountWipeJob(accountWipeEnvelopeV1({ tenantId: TENANT }), await wipeEnv(), wipeJobDeps());
    const foreign = await env.READINGS_BUCKET.get(foreignKey);
    expect(foreign).not.toBeNull();
    await foreign?.text();
  });

  it("cron fan-out enqueues past-grace deleting tenants and skips the grace window", async () => {
    // A tenant with something to wipe: fan-out now skips a no-progress tenant
    // whose prefix is already empty, since that is what an already-wiped one
    // looks like once the terminal transition removes the record.
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS);
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 0 });
    expect(queued).toEqual([]);
    expect(await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID))).toBeNull();

    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 1 });
    expect(queued).toEqual([accountWipeEnvelopeV1({ tenantId: TENANT })]);
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS + 1 })).toEqual({
      enqueued: 0,
    });
  });

  it("cron redrives a force wipe that wrote progress during grace, preserving force:true", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS);
    const keys = Array.from({ length: 1001 }, (_, i) => `${PREFIX}pad/${String(i).padStart(4, "0")}`);
    const memory = memoryBucket(keys);
    const jobEnv = { ...(await wipeEnv()), READINGS_BUCKET: memory.bucket };
    const started = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT, force: true }),
      jobEnv,
      wipeJobDeps({ maxObjectPages: 1, maxVectorBatches: 20 }),
    );
    expect(started.kind).toBe("continue");
    const progressObj = await memory.bucket.get(accountWipeProgressKey(OTHER_TENANT_ID));
    expect(progressObj).not.toBeNull();
    const progress = JSON.parse(await progressObj!.text()) as { force?: boolean; phase: string };
    expect(progress.force).toBe(true);
    expect(progress.phase).not.toBe("done");

    expect(await fanOutDueAccountWipes(jobEnv, { nowMs: NOW_MS })).toEqual({ enqueued: 0 });
    expect(queued).toEqual([]);

    const resumeAt = NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS;
    expect(resumeAt - NOW_MS).toBeLessThan(ACCOUNT_WIPE_GRACE_MS);
    expect(await fanOutDueAccountWipes(jobEnv, { nowMs: resumeAt })).toEqual({ enqueued: 1 });
    expect(queued).toEqual([accountWipeEnvelopeV1({ tenantId: TENANT, force: true })]);
  });

  it("cron resumes leftover objects on a force wipe during grace with force:true", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS);
    await env.READINGS_BUCKET.put(
      accountWipeProgressKey(OTHER_TENANT_ID),
      JSON.stringify({
        version: 1,
        phase: "done",
        vector_offset: 0,
        mutation_ids: [],
        objects_deleted: 1,
        updated_at_ms: NOW_MS,
        force: true,
      }),
    );
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 1 });
    expect(queued).toEqual([accountWipeEnvelopeV1({ tenantId: TENANT, force: true })]);
    const progressObj = await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID));
    expect(progressObj).not.toBeNull();
    const progress = JSON.parse(await progressObj!.text()) as {
      phase: string;
      force?: boolean;
      vector_offset?: number;
    };
    expect(progress.phase).toBe("vectors");
    expect(progress.vector_offset).toBe(0);
    expect(progress.force).toBe(true);

    const result = await processAccountWipeJob(queued[0]!, await wipeEnv(), wipeJobDeps());
    expect(result.kind).toBe("complete");
    expect(deleteByIds).toHaveBeenCalled();
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
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
      wipeJobDeps(),
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
    const progress = JSON.parse(await progressObj!.text()) as { phase: string; vector_offset?: number };
    expect(progress.phase).toBe("vectors");
    expect(progress.vector_offset).toBe(0);
  });

  it("leftover recovery re-runs Vectorize deletes before emptying R2", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await env.READINGS_BUCKET.put(
      accountWipeProgressKey(OTHER_TENANT_ID),
      JSON.stringify({
        version: 1,
        phase: "done",
        vector_offset: 99,
        mutation_ids: ["mut_old"],
        objects_deleted: 1,
        updated_at_ms: NOW_MS,
      }),
    );
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps(),
    );
    expect(result.kind).toBe("complete");
    expect(deleteByIds).toHaveBeenCalledWith([tenantVectorId(OTHER_TENANT_ID, ID_A)]);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
  });

  it("persists collected reading ids and re-submits deleteByIds after R2 is emptied", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    let calls = 0;
    deleteByIds.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        expect((await listPrefixKeys(PREFIX)).length).toBeGreaterThan(0);
      } else {
        expect(await listPrefixKeys(PREFIX)).toEqual([]);
      }
      return { mutationId: `mut_${calls}` };
    });
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps(),
    );
    expect(result.kind).toBe("complete");
    expect(deleteByIds).toHaveBeenCalledTimes(2);
    expect(deleteByIds.mock.calls[0]?.[0]).toEqual([tenantVectorId(OTHER_TENANT_ID, ID_A)]);
    expect(deleteByIds.mock.calls[1]?.[0]).toEqual([tenantVectorId(OTHER_TENANT_ID, ID_A)]);
    // The stored ids drove that second submit, which is what this test pins.
    // The record itself is gone at the terminal transition (Move 1 / F4) rather
    // than persisting as phase:"done" with the deleted user's ids in it.
    expect(await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID))).toBeNull();
  });

  it("objects phase unions reading ids from listed keys before delete", async () => {
    await seedTenantObjects([ID_A, ID_B]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await env.READINGS_BUCKET.put(
      accountWipeProgressKey(OTHER_TENANT_ID),
      JSON.stringify({
        version: 1,
        phase: "objects",
        vector_offset: 1,
        mutation_ids: ["mut_old"],
        objects_deleted: 0,
        updated_at_ms: NOW_MS,
        reading_ids: [ID_A],
      }),
    );
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps(),
    );
    expect(result.kind).toBe("complete");
    const expected = [tenantVectorId(OTHER_TENANT_ID, ID_A), tenantVectorId(OTHER_TENANT_ID, ID_B)];
    expect(deleteByIds.mock.calls[0]?.[0]).toEqual(expected);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    // ID_B was unioned in from a listed key before that key was deleted — the
    // submit above is the proof. The record is removed at the terminal
    // transition (Move 1 / F4), so there is no surviving copy to read it from.
    expect(await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID))).toBeNull();
  });

  it("leftover recovery unions stored reading ids with an R2 re-list", async () => {
    await seedTenantObjects([ID_B]);
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
        reading_ids: [ID_A],
      }),
    );
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps(),
    );
    expect(result.kind).toBe("complete");
    const expected = [tenantVectorId(OTHER_TENANT_ID, ID_A), tenantVectorId(OTHER_TENANT_ID, ID_B)];
    expect(deleteByIds.mock.calls[0]?.[0]).toEqual(expected);
    expect(deleteByIds.mock.calls.at(-1)?.[0]).toEqual(expected);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
  });

  it("scheduled() still fans out wipes when digest fan-out throws", async () => {
    // Needs a non-empty prefix to be a fan-out candidate at all.
    await seedTenantObjects([ID_A]);
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
    // Needs a non-empty prefix to be a fan-out candidate at all.
    await seedTenantObjects([ID_A]);
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
      wipeJobDeps(),
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
      wipeJobDeps(),
    );
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 13 });
    expect(consoleErr).toHaveBeenCalled();
    const progressObj = await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID));
    expect(progressObj).not.toBeNull();
    const progress = JSON.parse(await progressObj!.text()) as { updated_at_ms: number };
    expect(progress.updated_at_ms).toBe(NOW_MS + 13_000);
    consoleErr.mockRestore();
  });

  it("does not fan out a sibling while a delayed retry still holds the lease", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const retryAfterMs = 2 * 60 * 60 * 1000;
    deleteByIds.mockImplementation(async () => {
      throw new RateLimitedError(429, retryAfterMs, "https://vectorize.example/delete");
    });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await consumeAccountWipeMessage(
      {
        body: accountWipeEnvelopeV1({ tenantId: TENANT }),
        ack: vi.fn(),
        retry: vi.fn(),
        attempts: 1,
      },
      await wipeEnv(),
      wipeJobDeps(),
    );
    consoleErr.mockRestore();
    const delaySeconds = retryAfterMs / 1000;
    const heldUntil = NOW_MS + delaySeconds * 1000;
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS })).toEqual({
      enqueued: 0,
    });
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: heldUntil + ACCOUNT_WIPE_IN_FLIGHT_MS - 1 })).toEqual({
      enqueued: 0,
    });
    expect(queued).toEqual([]);
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: heldUntil + ACCOUNT_WIPE_IN_FLIGHT_MS })).toEqual({
      enqueued: 1,
    });
  });

  it("heartbeats the wipe lease during collectReadingIds and R2 pages", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const clock = { t: NOW_MS };
    const heartbeats: WipeProgressSnap[] = [];
    const jobEnv = {
      ...(await wipeEnv()),
      READINGS_BUCKET: wrapBucketClock(env.READINGS_BUCKET, OTHER_TENANT_ID, clock, {
        advanceListMs: ACCOUNT_WIPE_IN_FLIGHT_MS,
        onProgress: (progress) => {
          heartbeats.push(progress);
        },
      }),
    };
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      jobEnv,
      wipeJobDeps({ clock }),
    );
    expect(result.kind).toBe("complete");
    const midCollect = heartbeats.find(
      (progress) =>
        progress.phase === "vectors" &&
        (progress.reading_ids?.length ?? 0) === 0 &&
        progress.updated_at_ms >= NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS,
    );
    expect(midCollect).toBeDefined();
    const midPages = heartbeats.find(
      (progress) =>
        (progress.phase === "objects" || (progress.objects_deleted ?? 0) > 0) &&
        progress.updated_at_ms >= NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS,
    );
    expect(midPages).toBeDefined();
  });

  it("computes the retry lease from failure time, not consume-start", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const clock = { t: NOW_MS };
    deleteByIds.mockImplementation(async () => {
      clock.t = NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS;
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
      wipeJobDeps({ clock }),
    );
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 13 });
    const progressObj = await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID));
    expect(progressObj).not.toBeNull();
    const progress = JSON.parse(await progressObj!.text()) as { updated_at_ms: number };
    expect(progress.updated_at_ms).toBe(NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS + 13_000);
    expect(progress.updated_at_ms).not.toBe(NOW_MS + 13_000);
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS })).toEqual({
      enqueued: 0,
    });
    consoleErr.mockRestore();
  });

  it("cron at the 15-minute boundary still sees the lease while a job heartbeats", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const clock = { t: NOW_MS };
    let cronDuringHeartbeat: { enqueued: number } | null = null;
    const jobEnv = {
      ...(await wipeEnv()),
      READINGS_BUCKET: wrapBucketClock(env.READINGS_BUCKET, OTHER_TENANT_ID, clock, {
        advanceListMs: ACCOUNT_WIPE_IN_FLIGHT_MS,
        onProgress: async (progress) => {
          if (cronDuringHeartbeat !== null) return;
          if (progress.updated_at_ms < NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS) return;
          cronDuringHeartbeat = { enqueued: -1 };
          cronDuringHeartbeat = await fanOutDueAccountWipes(jobEnv, {
            nowMs: NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS,
          });
        },
      }),
    };
    await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      jobEnv,
      wipeJobDeps({ clock }),
    );
    expect(cronDuringHeartbeat).toEqual({ enqueued: 0 });
    expect(queued).toEqual([]);
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

  // Move 1 / F4: the progress object carries the deleted tenant id in its key and
  // their full reading-id list in its body. It must not outlive the wipe.
  it("deletes the wipe progress object at the terminal transition", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps(),
    );
    expect(result.kind).toBe("complete");
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    expect(await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID))).toBeNull();
  });

  // Move 1 / F8: max_concurrency = 3 plus at-least-once delivery means two live
  // siblings. The loser must fail loudly instead of last-write-wins clobbering
  // the winner's cursor.
  it("refuses a progress write when a sibling wrote the object underneath it", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const progressKey = accountWipeProgressKey(OTHER_TENANT_ID);
    const real = env.READINGS_BUCKET;
    let siblingWrote = false;
    const raced = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return async (key: string, value: unknown, putOpts?: R2PutOptions) => {
            if (key === progressKey && !siblingWrote) {
              siblingWrote = true;
              // A sibling job commits its own progress between our read and our put.
              await target.put(key, JSON.stringify({ version: 1, phase: "objects" }));
            }
            return target.put(
              key,
              value as string,
              putOpts as R2PutOptions,
            );
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const jobEnv = { ...(await wipeEnv()), READINGS_BUCKET: raced } as Env;
    await expect(
      processAccountWipeJob(accountWipeEnvelopeV1({ tenantId: TENANT }), jobEnv, wipeJobDeps()),
    ).rejects.toThrow(/progress_conflict/);
    // The sibling's record survives; the loser did not overwrite it.
    const obj = await real.get(progressKey);
    expect(obj).not.toBeNull();
    expect(JSON.parse(await obj!.text())).toMatchObject({ phase: "objects" });
  });

  // Move 1 / F3: an empty id list must not let an unbound index short-circuit to
  // success. Commit a9a9f0f's fail-closed intent applies before the emptiness test.
  it("throws when the Vectorize index is unbound even with no collected reading ids", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    const jobEnv = { ...(await wipeEnv()), READINGS_INDEX: undefined } as unknown as Env;
    await expect(
      processAccountWipeJob(accountWipeEnvelopeV1({ tenantId: TENANT }), jobEnv, wipeJobDeps()),
    ).rejects.toThrow(/index_unbound/);
  });

  // Move 1 / F3: the wipe must not claim success while the tenant namespace still
  // returns vectors. Nearest-K cannot prove absence, but a hit disproves it.
  it("fails the terminal transition when the tenant namespace still answers", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    queryIndex.mockImplementation(async () => ({
      count: 1,
      matches: [{ id: tenantVectorId(OTHER_TENANT_ID, ID_A), score: 1, metadata: {} }],
    }));
    await expect(
      processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps(),
      ),
    ).rejects.toThrow(/namespace_not_empty/);
    // Not a success, so the resume record must survive for the retry. Read the
    // body: an unconsumed R2 stream breaks the pool's isolated-storage teardown.
    const surviving = await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID));
    expect(surviving).not.toBeNull();
    expect(JSON.parse(await surviving!.text())).toMatchObject({ phase: "sweep" });
  });

  // Ruling 1: deleting the progress record at the terminal transition removes
  // the only "already wiped" marker, and users.status stays 'deleting' until
  // PR2. Without this skip cron restarts a full wipe every 15 minutes forever
  // and re-creates the tenant-named object the delete exists to remove.
  it("cron fan-out does not restart a wipe for a tenant with no progress and an empty prefix", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    expect(await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID))).toBeNull();

    const result = await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS });

    expect(result).toEqual({ enqueued: 0 });
    expect(queued).toEqual([]);
    // Nothing re-created: the whole point of the skip.
    expect(await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID))).toBeNull();
  });

  // Ruling 2: Vectorize deletes propagate asynchronously, so a probe hit right
  // after submitting is expected. Retrying on the ordinary 30s exponential
  // would DLQ every real wipe in ~3.5 minutes, well before propagation.
  it("retries a probe hit on the propagation-lag delay, not the fast exponential", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    queryIndex.mockImplementation(async () => ({
      count: 1,
      matches: [{ id: tenantVectorId(OTHER_TENANT_ID, ID_A), score: 1, metadata: {} }],
    }));
    const retry = vi.fn();
    const ack = vi.fn();
    await consumeAccountWipeMessage(
      { body: accountWipeEnvelopeV1({ tenantId: TENANT }), ack, retry, attempts: 1 },
      await wipeEnv(),
      wipeJobDeps(),
    );
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({
      delaySeconds: ACCOUNT_WIPE_PROBE_RETRY_DELAY_SECONDS,
    });
    expect(ACCOUNT_WIPE_PROBE_RETRY_DELAY_SECONDS).toBeGreaterThanOrEqual(120);
  });

  // Ruling 3: the probe must not gate forever on a vector the code documents as
  // structurally unaddressable. Bound the attempts, then alert and finish.
  it("alerts and completes once the probe attempt bound is exhausted", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await env.READINGS_BUCKET.put(
      accountWipeProgressKey(OTHER_TENANT_ID),
      JSON.stringify({
        version: 1,
        phase: "sweep",
        vector_offset: 1,
        mutation_ids: ["mut_old"],
        objects_deleted: 1,
        updated_at_ms: NOW_MS,
        reading_ids: [ID_A],
        probe_attempts: ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS - 1,
      }),
    );
    queryIndex.mockImplementation(async () => ({
      count: 1,
      matches: [{ id: tenantVectorId(OTHER_TENANT_ID, ID_A), score: 1, metadata: {} }],
    }));
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      const result = await processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps(),
      );
      expect(result.kind).toBe("complete");
    } finally {
      spy.mockRestore();
    }
    const alert = errors.find((line) => line.includes("account_wipe_namespace_residue"));
    expect(alert).toBeDefined();
    const payload = JSON.parse(alert!) as Record<string, unknown>;
    expect(payload.severity).toBe("high");
    expect(payload.tenant_id).toBe(OTHER_TENANT_ID);
    // Tenant id only: an operator alert about a deleted account must not carry
    // that account's reading ids.
    expect(alert).not.toContain(ID_A);
    // Completed, so the record is gone like any other successful wipe.
    expect(await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID))).toBeNull();
    expect(payload.outcome).toBe("residue");
  });

  // If a terminal delete never landed, cron is the only thing that looks at that
  // tenant again — and it used to skip it, so once redelivery stopped the
  // tenant-naming record was permanent.
  it("cron fan-out clears a stranded done record whose terminal delete never landed", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    await env.READINGS_BUCKET.put(
      accountWipeProgressKey(OTHER_TENANT_ID),
      JSON.stringify({
        version: 1,
        phase: "done",
        vector_offset: 1,
        mutation_ids: ["mut_old"],
        objects_deleted: 3,
        updated_at_ms: NOW_MS,
        reading_ids: [ID_A],
      }),
    );
    const result = await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS });
    expect(result).toEqual({ enqueued: 0 });
    expect(queued).toEqual([]);
    expect(await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID))).toBeNull();
  });

  // A probe that errors is "we could not check", not "vectors are still there".
  // It must not dead-letter an otherwise finished wipe on the fast schedule, and
  // the alert it eventually raises must not read as a residue finding.
  it("treats a failing probe as unconfirmed, not as residue", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await env.READINGS_BUCKET.put(
      accountWipeProgressKey(OTHER_TENANT_ID),
      JSON.stringify({
        version: 1,
        phase: "sweep",
        vector_offset: 1,
        mutation_ids: ["mut_old"],
        objects_deleted: 1,
        updated_at_ms: NOW_MS,
        reading_ids: [ID_A],
        probe_attempts: ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS - 1,
      }),
    );
    queryIndex.mockImplementation(async () => {
      throw new Error("vectorize unavailable");
    });
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps(),
      );
      expect(result.kind).toBe("complete");
    } finally {
      spy.mockRestore();
      warns.mockRestore();
    }
    const alert = errors.find((line) => line.includes("account_wipe_namespace_residue"));
    expect(alert).toBeDefined();
    const payload = JSON.parse(alert!) as Record<string, unknown>;
    expect(payload.outcome).toBe("unconfirmed");
    expect(payload.tenant_id).toBe(OTHER_TENANT_ID);
    expect(alert).not.toContain(ID_A);
  });

  // An unparseable body is still an object sitting at the tenant's progress key.
  // It has no resume value, and fan-out is the only thing that ever sees it.
  it("cron fan-out clears an unparseable progress record on a wiped tenant", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    await env.READINGS_BUCKET.put(
      accountWipeProgressKey(OTHER_TENANT_ID),
      JSON.stringify({ version: 1, phase: "not-a-phase", junk: true }),
    );
    const result = await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS });
    expect(result).toEqual({ enqueued: 0 });
    expect(queued).toEqual([]);
    expect(await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID))).toBeNull();
  });

  // Observed residue must not be downgraded by a later transient probe error:
  // the verdict is sticky across attempts, not taken from the last one.
  it("keeps the residue verdict when a later probe errors", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await env.READINGS_BUCKET.put(
      accountWipeProgressKey(OTHER_TENANT_ID),
      JSON.stringify({
        version: 1,
        phase: "sweep",
        vector_offset: 1,
        mutation_ids: ["mut_old"],
        objects_deleted: 1,
        updated_at_ms: NOW_MS,
        reading_ids: [ID_A],
        probe_attempts: ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS - 1,
        // Earlier attempts in this wipe saw actual vectors.
        probe_saw_residue: true,
      }),
    );
    queryIndex.mockImplementation(async () => {
      throw new Error("vectorize unavailable");
    });
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps(),
      );
      expect(result.kind).toBe("complete");
    } finally {
      spy.mockRestore();
      warns.mockRestore();
    }
    const alert = errors.find((line) => line.includes("account_wipe_namespace_residue"));
    const payload = JSON.parse(alert!) as Record<string, unknown>;
    // Not "unconfirmed": a finding already observed is not erased by one error.
    expect(payload.outcome).toBe("residue");
    expect(alert).not.toContain(ID_A);
  });

  // A reopened leftover pass submits fresh deletes, so it must get a fresh probe
  // budget: inheriting a used-up count made the first probe of a brand-new pass
  // declare residue before those deletes had any chance to propagate.
  it("resets the probe budget when reopening a leftover wipe", async () => {
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
        reading_ids: [ID_A],
        probe_attempts: ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS,
      }),
    );
    queryIndex.mockImplementation(async () => ({
      count: 1,
      matches: [{ id: tenantVectorId(OTHER_TENANT_ID, ID_A), score: 1, metadata: {} }],
    }));
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      // Retries rather than completing: the reopened pass gets its own budget.
      await expect(
        processAccountWipeJob(
          accountWipeEnvelopeV1({ tenantId: TENANT }),
          await wipeEnv(),
          wipeJobDeps(),
        ),
      ).rejects.toThrow(/namespace_not_empty/);
    } finally {
      spy.mockRestore();
    }
    expect(errors.find((l) => l.includes("account_wipe_namespace_residue"))).toBeUndefined();
    const surviving = await env.READINGS_BUCKET.get(accountWipeProgressKey(OTHER_TENANT_ID));
    expect(surviving).not.toBeNull();
    expect(JSON.parse(await surviving!.text())).toMatchObject({ probe_attempts: 1 });
  });
});
