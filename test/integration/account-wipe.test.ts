import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_WIPE_GRACE_MS,
  ACCOUNT_WIPE_IN_FLIGHT_MS,
  ACCOUNT_WIPE_MAX_CONTINUATIONS,
  ACCOUNT_WIPE_MISSING_DELETING_AT_EVENT,
  ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS,
  ACCOUNT_WIPE_PROBE_RETRY_DELAY_SECONDS,
  consumeAccountWipeMessage,
  fanOutDueAccountWipes,
  handleAccountWipeDeadLetter,
  processAccountWipeJob,
  type AccountWipeJobDeps,
} from "../../src/account-wipe";
import { accountWipeEnvelopeV1, type AccountWipeEnvelopeV1 } from "../../src/control-plane/wipe-envelope";
import { fromD1 } from "../../src/control-plane/db";
import { parseTenantId } from "../../src/control-plane/ids";
import {
  AccountWipeProgressConflictError,
  emptyWipeProgress,
  readWipeProgress,
  WipeProgressWriter,
  type WipeProgress,
} from "../../src/control-plane/wipe-progress";
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

/** Wipe state lives in D1 now, so the tests read and seed it there. */
function controlPlane() {
  return fromD1(env.CONTROL_PLANE);
}

async function readProgress(): Promise<WipeProgress | null> {
  return readWipeProgress(controlPlane(), TENANT);
}

async function clearProgress(): Promise<void> {
  await env.CONTROL_PLANE.prepare("DELETE FROM wipe_progress WHERE tenant_id = ?")
    .bind(OTHER_TENANT_ID)
    .run();
}

/** Seed a wipe record the way a previous delivery would have left it. */
async function seedProgress(partial: Partial<WipeProgress>): Promise<void> {
  const db = controlPlane();
  const stored = await readWipeProgress(db, TENANT);
  await new WipeProgressWriter(db, TENANT, stored).write({
    ...emptyWipeProgress(NOW_MS),
    ...partial,
  });
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
    // Models R2's conditional put. The wipe's own compare-and-set moved to D1,
    // but keeping the double honest about `onlyIf` means a future R2 CAS is
    // exercised here rather than silently bypassed.
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

/**
 * Advance a test clock on every R2 `list`, and run a hook after each one — the
 * observation point for what the wipe record looks like part-way through a job
 * now that it lives in D1 rather than in an R2 object we could intercept.
 */
function wrapBucketClock(
  bucket: R2Bucket,
  clock: { t: number },
  opts: {
    advanceListMs?: number;
    afterList?: () => void | Promise<void>;
  } = {},
): R2Bucket {
  return new Proxy(bucket, {
    get(target, prop, receiver) {
      if (prop === "list") {
        return async (listOpts?: R2ListOptions) => {
          if (opts.advanceListMs) clock.t += opts.advanceListMs;
          const result = await target.list(listOpts as R2ListOptions);
          await opts.afterList?.();
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
    await clearProgress();
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
    // One submit per id set, not two: the post-empty re-submit is gone, and the
    // late-publish case it covered is fenced at the publisher instead.
    expect(deleteByIds).toHaveBeenCalledTimes(1);
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
    const progress = await readProgress();
    expect(progress).not.toBeNull();
    expect(progress!.phase).toBe("objects");
    expect(progress!.r2Cursor).toBeTruthy();
    // The self-send is counted, so a wipe that never finishes cannot reset its
    // queue retry budget forever (F7).
    expect(progress!.continuations).toBe(1);

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
    expect(result).toEqual({
      kind: "complete",
      objects_deleted: 0,
      mutation_ids: [],
      residue: false,
    });
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

  // The id list is re-derived from R2 on every delivery, so the vectors-phase
  // resume point has to be a VALUE. With a numeric offset, an id that appears
  // between two deliveries shifts the window and the id on the boundary is never
  // submitted at all.
  it("resumes the vectors phase by id value, so a shifted id set skips nothing", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const ids = Array.from({ length: 1001 }, (_, i) => `rd_${String(i).padStart(10, "0")}`);
    const memory = memoryBucket();
    const writeListIndex = async (items: string[]) =>
      memory.bucket.put(
        `${PREFIX}index/list.json`,
        JSON.stringify({ version: 1, items: items.map(indexItem) }),
      );
    await writeListIndex(ids);
    const jobEnv = { ...(await wipeEnv()), READINGS_BUCKET: memory.bucket };

    const first = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      jobEnv,
      wipeJobDeps({ maxVectorBatches: 1 }),
    );
    expect(first.kind).toBe("continue");
    expect(deleteByIds).toHaveBeenCalledTimes(1);
    const firstBatch = deleteByIds.mock.calls[0]![0] as string[];
    expect(firstBatch.length).toBe(1000);

    // A reading disappears from the list between deliveries (a purge, say). The
    // set shrinks below the stored offset, so an offset-based resume would call
    // itself done and never submit the last id at all.
    await writeListIndex(ids.slice(1));
    deleteByIds.mockClear();

    const second = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      jobEnv,
      wipeJobDeps(),
    );
    expect(second.kind).toBe("complete");
    // Exactly the ids after the cursor: the last one, and nothing skipped.
    const submitted = deleteByIds.mock.calls.flatMap(
      (call) => call[0] as string[],
    );
    expect(submitted).toEqual([tenantVectorId(OTHER_TENANT_ID, ids[1000]!)]);
    expect(memory.keysUnder(PREFIX)).toEqual([]);
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
    expect(deleteByIds).toHaveBeenCalledTimes(2);
    expect((deleteByIds.mock.calls[0]![0] as string[]).length).toBe(1000);
    expect((deleteByIds.mock.calls[1]![0] as string[]).length).toBe(1);
    expect(memory.keysUnder(PREFIX)).toEqual([]);
  });

  // The vectors phase is not the only entry point: a delivery resuming from a
  // stored `phase:"objects"` never reaches it. Without a check above the phase
  // blocks such a job would empty the prefix and only then find it cannot delete
  // the vectors — having just destroyed the only source of their ids.
  it("does not wipe the tenant prefix when the index is unbound and the job resumes at objects", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await seedProgress({ phase: "objects" });
    const before = await listPrefixKeys(PREFIX);
    expect(before).not.toEqual([]);

    await expect(
      processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        { ...(await wipeEnv()), READINGS_INDEX: undefined } as unknown as Env,
        wipeJobDeps(),
      ),
    ).rejects.toThrow(/index_unbound/);

    expect(await listPrefixKeys(PREFIX)).toEqual(before);
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
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS);
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 0 });
    expect(queued).toEqual([]);
    expect(await readProgress()).toBeNull();

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
    const progress = await readProgress();
    expect(progress).not.toBeNull();
    expect(progress!.force).toBe(true);
    expect(progress!.completedAtMs).toBeNull();

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
    await seedProgress({
      phase: "done",
      objectsDeleted: 1,
      force: true,
      completedAtMs: NOW_MS,
    });
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 1 });
    expect(queued).toEqual([accountWipeEnvelopeV1({ tenantId: TENANT, force: true })]);
    const progress = await readProgress();
    expect(progress).not.toBeNull();
    expect(progress!.phase).toBe("vectors");
    expect(progress!.vectorCursor).toBeUndefined();
    expect(progress!.force).toBe(true);
    // Reopened, so the completion record is cleared until this pass finishes.
    expect(progress!.completedAtMs).toBeNull();

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
    expect(await readProgress()).toBeNull();
    warn.mockRestore();
  });

  it("re-lists the prefix before done so a stale cursor cannot hide leftover objects", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const keys = [`${PREFIX}keep-a`, `${PREFIX}keep-z`];
    const memory = memoryBucket(keys);
    await seedProgress({ phase: "objects", r2Cursor: `${PREFIX}keep-z` });
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
    await seedProgress({ phase: "done", objectsDeleted: 1, completedAtMs: NOW_MS });
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 1 });
    expect(queued).toEqual([accountWipeEnvelopeV1({ tenantId: TENANT })]);
    const progress = await readProgress();
    expect(progress).not.toBeNull();
    expect(progress!.phase).toBe("vectors");
    expect(progress!.vectorCursor).toBeUndefined();
  });

  it("leftover recovery re-runs Vectorize deletes before emptying R2", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await seedProgress({
      phase: "done",
      vectorCursor: "rd_9999999999",
      mutationIds: ["mut_old"],
      objectsDeleted: 1,
      completedAtMs: NOW_MS,
    });
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps(),
    );
    expect(result.kind).toBe("complete");
    expect(deleteByIds).toHaveBeenCalledWith([tenantVectorId(OTHER_TENANT_ID, ID_A)]);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
  });

  // Vectors before objects: reading ids come only from R2, so every delete this
  // pass will submit must be submitted while the prefix is still there.
  it("submits every vector delete before the first R2 delete", async () => {
    await seedTenantObjects([ID_A, ID_B]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    let calls = 0;
    deleteByIds.mockImplementation(async () => {
      calls += 1;
      expect((await listPrefixKeys(PREFIX)).length).toBeGreaterThan(0);
      return { mutationId: `mut_${calls}` };
    });
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps(),
    );
    expect(result.kind).toBe("complete");
    expect(deleteByIds).toHaveBeenCalledTimes(1);
    expect(deleteByIds.mock.calls[0]?.[0]).toEqual([
      tenantVectorId(OTHER_TENANT_ID, ID_A),
      tenantVectorId(OTHER_TENANT_ID, ID_B),
    ]);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    // The record is KEPT now, unlike the R2 object it replaces (F4): it carries
    // no reading id, and it is the evidence a later slice gates on.
    const progress = await readProgress();
    expect(progress!.completedAtMs).not.toBeNull();
    expect(progress!.vectorCursor).toBeUndefined();
  });

  // No post-empty re-submit any more: a job resuming at the objects phase had
  // its ids collected by the pass that set that phase, and a vector published
  // afterwards is deleted by the publisher itself
  // (ReadingVisibility.removeForDeletedTenant), not by a sweep here.
  it("resuming at the objects phase empties the prefix without re-collecting ids", async () => {
    await seedTenantObjects([ID_A, ID_B]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await seedProgress({ phase: "objects", mutationIds: ["mut_old"] });
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps(),
    );
    expect(result.kind).toBe("complete");
    expect(deleteByIds).not.toHaveBeenCalled();
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    expect((await readProgress())!.completedAtMs).not.toBeNull();
  });

  // Leftover recovery re-derives its ids from R2 rather than from anything the
  // finished record carried: the record no longer stores reading ids at all.
  it("leftover recovery re-derives reading ids from an R2 re-list", async () => {
    await seedTenantObjects([ID_B]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await seedProgress({ phase: "done", objectsDeleted: 1, completedAtMs: NOW_MS });
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps(),
    );
    expect(result.kind).toBe("complete");
    expect(deleteByIds.mock.calls[0]?.[0]).toEqual([tenantVectorId(OTHER_TENANT_ID, ID_B)]);
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
    // The record survives the failure so the retry resumes from it. What it no
    // longer does is push `updated_at_ms` into the future to fence off cron:
    // that trick belonged to the R2 etag CAS, and the lease is a version now.
    const progress = await readProgress();
    expect(progress).not.toBeNull();
    expect(progress!.completedAtMs).toBeNull();
    expect(progress!.updatedAtMs).toBe(NOW_MS);
    consoleErr.mockRestore();
  });

  // Previously special-cased: a Retry-After of hours used to require pushing the
  // lease timestamp forward by `delaySeconds`, or cron would enqueue a sibling
  // that last-write-wins the record the delayed retry still owned. With the CAS
  // on `lease_seq`, that sibling is simply the new owner and the late retry is
  // told so — no fence needed, and nothing lost either way.
  it("lets cron take over a wipe owed a long delayed retry, and the retry backs off", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const retryAfterMs = 2 * 60 * 60 * 1000;
    let failing = true;
    deleteByIds.mockImplementation(async (ids: string[]) => {
      if (failing) throw new RateLimitedError(429, retryAfterMs, "https://vectorize.example/delete");
      return { mutationId: `mut_${ids.length}` };
    });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The delivery fails and asks for a 2-hour retry. Its record is left as it
    // was, with the lease version it wrote.
    await consumeAccountWipeMessage(
      { body: accountWipeEnvelopeV1({ tenantId: TENANT }), ack: vi.fn(), retry: vi.fn(), attempts: 1 },
      await wipeEnv(),
      wipeJobDeps(),
    );
    const stranded = await readProgress();
    expect(stranded).not.toBeNull();
    const strandedSeq = stranded!.leaseSeq;

    // Cron picks the tenant back up once the advisory window lapses — far
    // sooner than the retry is due — and a healthy delivery finishes the wipe.
    const cronAt = NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS;
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: cronAt })).toEqual({ enqueued: 1 });
    failing = false;
    const taken = await processAccountWipeJob(queued[0]!, await wipeEnv(), wipeJobDeps({ nowMs: cronAt }));
    expect(taken.kind).toBe("complete");
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    expect((await readProgress())!.leaseSeq).toBeGreaterThan(strandedSeq);

    // The original message finally redelivers two hours later. It holds a stale
    // lease version, so it reports that someone else owns the wipe rather than
    // rewinding the finished record.
    const lateAck = vi.fn();
    const lateRetry = vi.fn();
    await consumeAccountWipeMessage(
      {
        body: accountWipeEnvelopeV1({ tenantId: TENANT }),
        ack: lateAck,
        retry: lateRetry,
        attempts: 2,
      },
      await wipeEnv(),
      wipeJobDeps({ nowMs: NOW_MS + retryAfterMs }),
    );
    expect(lateAck).toHaveBeenCalledOnce();
    expect(lateRetry).not.toHaveBeenCalled();
    expect((await readProgress())!.completedAtMs).not.toBeNull();
    consoleErr.mockRestore();
    warn.mockRestore();
  });

  it("heartbeats the wipe lease during collectReadingIds and R2 pages", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const clock = { t: NOW_MS };
    const seen: Array<{ phase: string; updatedAtMs: number }> = [];
    const jobEnv = {
      ...(await wipeEnv()),
      READINGS_BUCKET: wrapBucketClock(env.READINGS_BUCKET, clock, {
        advanceListMs: ACCOUNT_WIPE_IN_FLIGHT_MS,
        afterList: async () => {
          const progress = await readProgress();
          if (progress) seen.push({ phase: progress.phase, updatedAtMs: progress.updatedAtMs });
        },
      }),
    };
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      jobEnv,
      wipeJobDeps({ clock }),
    );
    expect(result.kind).toBe("complete");
    // Still heartbeats, so cron does not produce duplicates it would only have
    // to turn away — advisory now rather than load-bearing.
    expect(
      seen.some(
        (snap) => snap.phase === "vectors" && snap.updatedAtMs >= NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS,
      ),
    ).toBe(true);
    expect(
      seen.some(
        (snap) => snap.phase === "objects" && snap.updatedAtMs >= NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS,
      ),
    ).toBe(true);
  });

  // Previously special-cased: with the R2 etag CAS the job had to heartbeat off
  // a LIVE clock, because a job running on a frozen consume-start clock let a
  // cron tick at the 15-minute boundary last-write-wins its cursor. Frozen is
  // ordinary now — cron may well enqueue, but the CAS decides ownership, and
  // exactly one of the two writers proceeds.
  it("survives a frozen job clock: cron may enqueue, but only one writer wins", async () => {
    await seedTenantObjects([ID_A, ID_B]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const frozen = { t: NOW_MS };
    let cronRun: { enqueued: number } | null = null;
    const jobEnv = {
      ...(await wipeEnv()),
      READINGS_BUCKET: wrapBucketClock(env.READINGS_BUCKET, frozen, {
        // The clock never moves, so the lease looks expired at the boundary.
        afterList: async () => {
          if (cronRun !== null) return;
          cronRun = { enqueued: -1 };
          cronRun = await fanOutDueAccountWipes(await wipeEnv(), {
            nowMs: NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS,
          });
        },
      }),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outcome = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      jobEnv,
      wipeJobDeps({ clock: frozen }),
    );
    warn.mockRestore();
    // Cron did enqueue against the apparently-expired lease and claimed it, so
    // the running job's next write lost and it stood down. No exception, no
    // clobbered cursor: the record is exactly what the winner wrote.
    expect(cronRun).toEqual({ enqueued: 1 });
    expect(outcome).toEqual({ kind: "skipped", reason: "lease_held" });
    const progress = await readProgress();
    expect(progress).not.toBeNull();
    expect(progress!.completedAtMs).toBeNull();
    // The queued sibling can finish the wipe from that record.
    const finished = await processAccountWipeJob(queued[0]!, await wipeEnv(), wipeJobDeps());
    expect(finished.kind).toBe("complete");
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
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

  // What F4 was really about: the record must not carry a deleted account's
  // reading ids. The D1 row is KEPT instead of deleted — it is the durable
  // completion evidence — and the terminal write clears both cursors so nothing
  // reading-shaped survives in it.
  it("keeps a cursor-free completion record at the terminal transition", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps(),
    );
    expect(result).toMatchObject({ kind: "complete", residue: false });
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    const progress = await readProgress();
    expect(progress).not.toBeNull();
    expect(progress!.phase).toBe("done");
    expect(progress!.completedAtMs).toBe(NOW_MS);
    expect(progress!.residue).toBe(false);
    expect(progress!.objectsDeleted).toBeGreaterThan(0);
    // No reading id anywhere on the surviving record.
    expect(progress!.vectorCursor).toBeUndefined();
    expect(progress!.r2Cursor).toBeUndefined();
    expect(JSON.stringify(progress)).not.toContain(ID_A);
  });

  // F8, restated for D1: at-least-once delivery plus cron overlap means two
  // deliveries can be live on one tenant. The lease is a version, so the loser's
  // conditional UPDATE changes zero rows — it stands down and says so instead of
  // last-write-wins clobbering the winner's cursor.
  it("lets one of two concurrent writers win the lease and tells the other", async () => {
    const db = controlPlane();
    await seedProgress({ phase: "vectors" });
    const stored = await readWipeProgress(db, TENANT);
    expect(stored).not.toBeNull();

    // Both deliveries read the same row, so both hold the same lease version.
    const winner = new WipeProgressWriter(db, TENANT, stored);
    const loser = new WipeProgressWriter(db, TENANT, stored);

    await winner.write({ ...stored!, phase: "objects", objectsDeleted: 7 });
    await expect(
      loser.write({ ...stored!, phase: "vectors", objectsDeleted: 0 }),
    ).rejects.toBeInstanceOf(AccountWipeProgressConflictError);

    // The winner's state stands, untouched by the loser's attempt.
    const after = await readWipeProgress(db, TENANT);
    expect(after!.phase).toBe("objects");
    expect(after!.objectsDeleted).toBe(7);
    expect(after!.leaseSeq).toBe(stored!.leaseSeq + 1);

    // And the winner can keep writing: losing did not disturb its chain.
    await winner.write({ ...stored!, phase: "objects", objectsDeleted: 9 });
    expect((await readWipeProgress(db, TENANT))!.objectsDeleted).toBe(9);
  });

  // The same contention seen through the job: a delivery whose record moved
  // under it reports `lease_held` and is acked, not retried into the DLQ.
  it("reports lease_held and acks when another delivery owns the wipe", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await seedProgress({ phase: "vectors" });
    // A sibling advances the lease after this delivery has read the row but
    // before its first write — modelled by bumping the row out from under it.
    const bucket = new Proxy(env.READINGS_BUCKET, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return async (key: string) => {
            await env.CONTROL_PLANE.prepare(
              "UPDATE wipe_progress SET lease_seq = lease_seq + 1 WHERE tenant_id = ?",
            )
              .bind(OTHER_TENANT_ID)
              .run();
            return target.get(key);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ack = vi.fn();
    const retry = vi.fn();
    await consumeAccountWipeMessage(
      { body: accountWipeEnvelopeV1({ tenantId: TENANT }), ack, retry, attempts: 1 },
      { ...(await wipeEnv()), READINGS_BUCKET: bucket } as Env,
      wipeJobDeps(),
    );
    warn.mockRestore();
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    // Nothing was deleted by the delivery that lost.
    expect(await listPrefixKeys(PREFIX)).not.toEqual([]);
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
    // Not a success, so the resume record must survive for the retry — and it
    // must not have been stamped complete.
    const surviving = await readProgress();
    expect(surviving).not.toBeNull();
    expect(surviving!.phase).toBe("objects");
    expect(surviving!.completedAtMs).toBeNull();
  });

  // The gap the persisted record closes. While progress lived in R2 and was
  // deleted on completion, "no record + empty prefix" was the only way to
  // recognize an already-wiped tenant — a shape that also fits a tenant whose
  // prefix was emptied but whose vectors were stranded, so fan-out had to skip
  // it forever. Now the completion record answers the question directly: an
  // empty-prefix tenant with no record is wiped once, and a finished one is
  // recognized by its record rather than by an absence.
  it("wipes an empty-prefix tenant once and then recognizes it from the record", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    expect(await readProgress()).toBeNull();

    // First tick: nothing says this tenant was ever wiped, so it is.
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 1 });
    const result = await processAccountWipeJob(queued[0]!, await wipeEnv(), wipeJobDeps());
    expect(result.kind).toBe("complete");
    const completed = await readProgress();
    expect(completed!.completedAtMs).not.toBeNull();

    // Every later tick: the record says it is done, so nothing is re-enqueued —
    // and, unlike the R2 version, nothing is deleted to make that true.
    queued.length = 0;
    expect(
      await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS }),
    ).toEqual({ enqueued: 0 });
    expect(queued).toEqual([]);
    expect((await readProgress())!.completedAtMs).toBe(completed!.completedAtMs);
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
    await seedProgress({
      phase: "objects",
      vectorCursor: "rd_0123456780",
      mutationIds: ["mut_old"],
      objectsDeleted: 1,
      probeAttempts: ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS - 1,
    });
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
    expect(payload.outcome).toBe("residue");
    // The finding is durable now, not just a log line: the completion record
    // says the namespace was never confirmed clean, which is what the residue
    // scan and the later teardown gate read.
    const progress = await readProgress();
    expect(progress!.completedAtMs).not.toBeNull();
    expect(progress!.residue).toBe(true);
    expect(progress!.probeSawResidue).toBe(true);
    // Still no reading id on the record that outlives the account.
    expect(progress!.vectorCursor).toBeUndefined();
  });

  // A completed record is left exactly as it is: it is evidence, and rewriting
  // it would move `completed_at_ms` a later slice gates on.
  it("cron fan-out leaves a completed record alone on an empty prefix", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    await seedProgress({
      phase: "done",
      mutationIds: ["mut_old"],
      objectsDeleted: 3,
      completedAtMs: NOW_MS,
      residue: true,
    });
    const before = await readProgress();
    const result = await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS });
    expect(result).toEqual({ enqueued: 0 });
    expect(queued).toEqual([]);
    expect(await readProgress()).toEqual(before);
  });

  // A probe that errors is "we could not check", not "vectors are still there".
  // It must not dead-letter an otherwise finished wipe on the fast schedule, and
  // the alert it eventually raises must not read as a residue finding.
  it("treats a failing probe as unconfirmed, not as residue", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await seedProgress({
      phase: "objects",
      vectorCursor: "rd_0123456780",
      mutationIds: ["mut_old"],
      objectsDeleted: 1,
      probeAttempts: ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS - 1,
    });
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
    // Recorded as residue for gating purposes; `probe_saw_residue` beside it is
    // what separates "vectors were still there" from "we never got an answer".
    const progress = await readProgress();
    expect(progress!.residue).toBe(true);
    expect(progress!.probeSawResidue).toBe(false);
  });

  // Observed residue must not be downgraded by a later transient probe error:
  // the verdict is sticky across attempts, not taken from the last one.
  it("keeps the residue verdict when a later probe errors", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await seedProgress({
      phase: "objects",
      vectorCursor: "rd_0123456780",
      mutationIds: ["mut_old"],
      objectsDeleted: 1,
      probeAttempts: ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS - 1,
      // Earlier attempts in this wipe saw actual vectors.
      probeSawResidue: true,
    });
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
    await seedProgress({
      phase: "done",
      objectsDeleted: 1,
      completedAtMs: NOW_MS,
      probeAttempts: ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS,
    });
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
    const surviving = await readProgress();
    expect(surviving).not.toBeNull();
    expect(surviving!.probeAttempts).toBe(1);
    expect(surviving!.completedAtMs).toBeNull();
  });

  // F6: `deleting_at_ms` is what grace is measured from, so a NULL one can never
  // elapse and the tenant is never wiped. That is worth saying out loud rather
  // than stalling in silence — and it must not throw, or one bad row would stop
  // every other tenant on the tick.
  it("warns, without failing, when a deleting tenant has no deleting_at_ms", async () => {
    await seedTenantObjects([ID_A]);
    await env.CONTROL_PLANE.prepare(
      `UPDATE users SET status = 'deleting', deleting_at_ms = NULL, updated_at_ms = ? WHERE id = ?`,
    )
      .bind(NOW_MS, OTHER_TENANT_ID)
      .run();

    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warned.push(String(line));
    });
    const fanned = await fanOutDueAccountWipes(await wipeEnv(), { nowMs: NOW_MS });
    const skipped = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps(),
    );
    warn.mockRestore();

    const alert = warned.find((line) => line.includes(ACCOUNT_WIPE_MISSING_DELETING_AT_EVENT));
    expect(alert).toBeDefined();
    expect(JSON.parse(alert!)).toMatchObject({ tenant_id: OTHER_TENANT_ID });
    // Warned, not acted on: grace still gates, so nothing was enqueued or wiped.
    expect(fanned).toEqual({ enqueued: 0 });
    expect(skipped).toEqual({ kind: "skipped", reason: "grace_period" });
    expect(await listPrefixKeys(PREFIX)).not.toEqual([]);
  });

  // F7: a `continue` acks the current message and sends a fresh one, which
  // starts a fresh queue retry budget. Without a bound, a wipe that deletes a
  // page and then fails cycles forever and never dead-letters. Past the bound
  // the job throws instead of self-sending, so the delivery retries and its
  // budget can actually run out.
  it("stops self-sending once the continuation budget is spent, so the job can dead-letter", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    // More than two full R2 pages, so one page a delivery cannot finish inside
    // the two deliveries this test drives.
    const keys = Array.from({ length: 2001 }, (_, i) => `${PREFIX}pad/${String(i).padStart(5, "0")}`);
    const memory = memoryBucket(keys);
    const jobEnv = { ...(await wipeEnv()), READINGS_BUCKET: memory.bucket };
    // The budget is already all but spent.
    await seedProgress({ phase: "objects", continuations: ACCOUNT_WIPE_MAX_CONTINUATIONS - 1 });

    const ack = vi.fn();
    const retry = vi.fn();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    // Last permitted self-send: acked and re-queued as usual.
    await consumeAccountWipeMessage(
      { body: accountWipeEnvelopeV1({ tenantId: TENANT }), ack, retry, attempts: 1 },
      jobEnv,
      wipeJobDeps({ maxObjectPages: 1 }),
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(queued.length).toBe(1);
    expect((await readProgress())!.continuations).toBe(ACCOUNT_WIPE_MAX_CONTINUATIONS);

    // The next one is over the bound: no self-send, and the delivery retries so
    // that `max_retries` eventually carries it to the DLQ.
    const ack2 = vi.fn();
    const retry2 = vi.fn();
    await consumeAccountWipeMessage(
      { body: accountWipeEnvelopeV1({ tenantId: TENANT }), ack: ack2, retry: retry2, attempts: 3 },
      jobEnv,
      wipeJobDeps({ maxObjectPages: 1 }),
    );
    consoleErr.mockRestore();
    expect(ack2).not.toHaveBeenCalled();
    expect(retry2).toHaveBeenCalled();
    // Nothing new enqueued: the cycle that used to reset the retry budget is
    // broken, and the objects still there are what makes it visible.
    expect(queued.length).toBe(1);
    expect(memory.keysUnder(PREFIX).length).toBeGreaterThan(0);
  });

  // Reopening a leftover wipe is a fresh pass, so it gets a fresh continuation
  // budget as well as a fresh probe budget — a long-running large tenant must
  // not inherit a spent one.
  it("resets the continuation budget when reopening a leftover wipe", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await seedProgress({
      phase: "done",
      objectsDeleted: 1,
      completedAtMs: NOW_MS,
      continuations: ACCOUNT_WIPE_MAX_CONTINUATIONS,
    });
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps(),
    );
    expect(result.kind).toBe("complete");
    expect((await readProgress())!.continuations).toBe(0);
  });
});
