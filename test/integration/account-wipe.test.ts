import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_WIPE_GRACE_MS,
  ACCOUNT_WIPE_IN_FLIGHT_MS,
  ACCOUNT_WIPE_MAX_CONTINUATIONS,
  ACCOUNT_WIPE_MISSING_DELETING_AT_EVENT,
  ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS,
  LEDGER_COVERAGE_MAX_SCAN,
  AccountWipeNamespaceNotEmptyError,
  R2_LIST_LIMIT,
  consumeAccountWipeMessage,
  fanOutDueAccountWipes,
  handleAccountWipeDeadLetter,
  processAccountWipeJob,
  type AccountWipeJobDeps,
} from "../../src/account-wipe";
import { accountWipeEnvelopeV1, type AccountWipeEnvelopeV1 } from "../../src/control-plane/wipe-envelope";
import { fromD1 } from "../../src/control-plane/db";
import {
  VECTOR_LEDGER_BACKOFF_MS,
  VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS,
  clearLedgerRows,
  clearTenantLedger,
  d1VectorLedger,
} from "../../src/control-plane/vector-ledger";
import { parseTenantId } from "../../src/control-plane/ids";
import {
  AccountWipeProgressConflictError,
  emptyWipeProgress,
  readWipeProgress,
  reopenWipeProgress,
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
let getByIds: ReturnType<typeof vi.fn>;
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
  // Default: the index holds nothing. A `getByIds` that answered "present"
  // by default would make every ledger row survive every confirmation, which
  // is the wrong default for a stub of a store the wipe has just emptied.
  getByIds = vi.fn(async () => []);
  (env as unknown as Env).READINGS_INDEX = {
    upsert: vi.fn(async () => ({ mutationId: "up" })),
    query: queryIndex,
    getByIds,
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

function indexItem(id: string, status: "ready" | "failed" = "ready"): ListIndexItem {
  return {
    id,
    key_prefix: `readings/2026/04/26T200000Z-${id}`,
    url: `https://example.com/${id}`,
    status,
    created_at: "2026-04-26T20:00:00.000Z",
  };
}

/**
 * Seed a tenant's corpus the way the live system would leave it.
 *
 * That now includes `vector_ledger` rows (issue #195 S3): the wipe takes its
 * ids from the ledger, not from an R2 walk, so a fixture that writes objects
 * without rows is a corpus with no vectors, not a corpus the wipe should be
 * expected to clear. `ops corpus seed-vector-ledger` is the real-world
 * equivalent for a corpus that predates the ledger.
 */
async function seedTenantObjects(
  ids: string[],
  opts: { ledger?: boolean; status?: "ready" | "failed" } = {},
): Promise<void> {
  // `status` matters to more than realism now. Only a `ready` reading ever
  // published a vector, so only a `ready` row is expected to carry a ledger
  // entry — which is exactly what the pre-objects coverage guard measures. A
  // fixture that wrote `ready` rows for readings it deliberately left
  // un-ledgered would be describing an unseeded corpus, and the guard would be
  // right to refuse it.
  const status = opts.status ?? "ready";
  const reader = testReadingStore(env, otherTenant());
  await reader.writeListIndex({ version: 1, items: ids.map((id) => indexItem(id, status)) });
  for (const id of ids) {
    await reader.writeByIdPointer(id, { id, key_prefix: `readings/2026/04/26T200000Z-${id}` });
    await env.READINGS_BUCKET.put(
      `${PREFIX}readings/2026/04/26T200000Z-${id}/manifest.json`,
      JSON.stringify({ id }),
    );
  }
  if (opts.ledger !== false) await seedLedger(ids);
}

/**
 * Ledger rows as a previous delivery's vectors phase would have left them:
 * `delete_submitted`, stamped far enough in the past that the +120s
 * first-confirmation delay has already elapsed.
 */
async function seedLedgerSubmitted(
  ids: string[],
  deletedAtMs: number = NOW_MS - VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS - 1,
): Promise<void> {
  await d1VectorLedger(controlPlane(), TENANT).markDeleteSubmitted(ids, deletedAtMs);
}

/** Ledger rows as any vector writer would have left them: state `live`. */
async function seedLedger(ids: string[], tenantId: string = OTHER_TENANT_ID): Promise<void> {
  const parsed = parseTenantId(tenantId)!;
  await d1VectorLedger(controlPlane(), parsed).markLive(ids, NOW_MS);
}

async function ledgerRows(
  tenantId: string = OTHER_TENANT_ID,
): Promise<Array<{ reading_id: string; state: string; deleted_at_ms: number | null; absent_streak: number }>> {
  const result = await env.CONTROL_PLANE.prepare(
    `SELECT reading_id, state, deleted_at_ms, absent_streak FROM vector_ledger
      WHERE tenant_id = ? ORDER BY reading_id`,
  )
    .bind(tenantId)
    .all<{ reading_id: string; state: string; deleted_at_ms: number | null; absent_streak: number }>();
  return result.results;
}

async function clearLedger(): Promise<void> {
  await env.CONTROL_PLANE.prepare("DELETE FROM vector_ledger").run();
}

/**
 * Drive a wipe to a terminal result the way the queue would.
 *
 * A healthy wipe is two passes now, and deliberately so: the terminal
 * confirmation refuses to count an absence until 120s after `deleteByIds`
 * returned, because S6 measured propagation at 30-90s and the old immediate
 * probe was guaranteed to hit. This advances the clock by exactly the delay the
 * error asks for, which is also what the consumer does.
 */
async function runWipeToCompletion(
  envelope: AccountWipeEnvelopeV1,
  clock: { t: number },
  extra: Partial<AccountWipeJobDeps> & { env?: Env } = {},
  maxPasses = 6,
): Promise<Awaited<ReturnType<typeof processAccountWipeJob>>> {
  const jobEnv = extra.env ?? (await wipeEnv());
  for (let pass = 0; pass < maxPasses; pass++) {
    try {
      const result = await processAccountWipeJob(
        envelope,
        jobEnv,
        wipeJobDeps({ ...extra, clock }),
      );
      if (result.kind !== "continue") return result;
    } catch (error) {
      if (!(error instanceof AccountWipeNamespaceNotEmptyError)) throw error;
      clock.t += error.retryAfterSeconds * 1000;
    }
  }
  throw new Error("wipe did not reach a terminal result");
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
    await clearLedger();
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
    const result = await runWipeToCompletion(
      accountWipeEnvelopeV1({ tenantId: TENANT, force: true }),
      { t: NOW_MS },
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

    const result = await runWipeToCompletion(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      { t: NOW_MS },
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
    const clock = { t: NOW_MS };
    await runWipeToCompletion(accountWipeEnvelopeV1({ tenantId: TENANT }), clock);
    deleteByIds.mockClear();
    const again = await runWipeToCompletion(accountWipeEnvelopeV1({ tenantId: TENANT }), clock);
    expect(again.kind).toBe("complete");
    expect(deleteByIds).not.toHaveBeenCalled();
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
  });

  // The vectors phase resumes on `state = 'live'` ledger rows, not on a cursor.
  // That is strictly stronger than the `vector_cursor` it replaces: a forward-
  // only window could not see an id that first appeared BELOW where the last
  // delivery stopped, and the ledger query has no window at all.
  it("resumes the vectors phase from the ledger, so an id added between deliveries is still submitted", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const ids = Array.from({ length: 1001 }, (_, i) => `rd_${String(i).padStart(10, "0")}`);
    await seedLedger(ids);
    const memory = memoryBucket();
    const jobEnv = { ...(await wipeEnv()), READINGS_BUCKET: memory.bucket };

    const first = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      jobEnv,
      wipeJobDeps({ maxVectorBatches: 1 }),
    );
    expect(first.kind).toBe("continue");
    expect(deleteByIds).toHaveBeenCalledTimes(1);
    expect((deleteByIds.mock.calls[0]![0] as string[]).length).toBe(1000);

    // A late writer ledgers a NEW reading whose id sorts at the very bottom —
    // below everything the first delivery submitted. The old forward-only
    // cursor would have skipped it forever; the ledger simply lists it.
    const late = "rd_0000000000A";
    await seedLedger([late]);
    deleteByIds.mockClear();

    const second = await runWipeToCompletion(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      { t: NOW_MS },
      { env: jobEnv },
    );
    expect(second.kind).toBe("complete");
    const submitted = deleteByIds.mock.calls.flatMap((call) => call[0] as string[]);
    expect(submitted.sort()).toEqual(
      [tenantVectorId(OTHER_TENANT_ID, ids[1000]!), tenantVectorId(OTHER_TENANT_ID, late)].sort(),
    );
    expect(memory.keysUnder(PREFIX)).toEqual([]);
  });

  it("submits vector deletes in 1000-id batches from the ledger", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const ids = Array.from({ length: 1001 }, (_, i) => `rd_${String(i).padStart(10, "0")}`);
    await seedLedger(ids);
    const memory = memoryBucket();
    const jobEnv = { ...(await wipeEnv()), READINGS_BUCKET: memory.bucket };
    const result = await runWipeToCompletion(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      { t: NOW_MS },
      { env: jobEnv },
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
    await runWipeToCompletion(accountWipeEnvelopeV1({ tenantId: TENANT }), { t: NOW_MS });
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
    expect(progress!.force).toBe(true);
    // Reopened, so the completion record is cleared until this pass finishes.
    expect(progress!.completedAtMs).toBeNull();

    const result = await runWipeToCompletion(queued[0]!, { t: NOW_MS });
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
    expect(progress!.r2Cursor).toBeUndefined();
  });

  it("leftover recovery re-runs Vectorize deletes before emptying R2", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await seedProgress({
      phase: "done",
      mutationIds: ["mut_old"],
      objectsDeleted: 1,
      completedAtMs: NOW_MS,
    });
    const result = await runWipeToCompletion(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      { t: NOW_MS },
    );
    expect(result.kind).toBe("complete");
    expect(deleteByIds).toHaveBeenCalledWith([tenantVectorId(OTHER_TENANT_ID, ID_A)]);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
  });

  // Vectors before objects. The ledger means this no longer protects an id
  // source, but the ordering is still the invariant: a reading missing from
  // search is a better intermediate state than a listed reading whose detail
  // page 404s.
  it("submits every vector delete before the first R2 delete", async () => {
    await seedTenantObjects([ID_A, ID_B]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    let calls = 0;
    deleteByIds.mockImplementation(async () => {
      calls += 1;
      expect((await listPrefixKeys(PREFIX)).length).toBeGreaterThan(0);
      return { mutationId: `mut_${calls}` };
    });
    const result = await runWipeToCompletion(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      { t: NOW_MS },
    );
    expect(result.kind).toBe("complete");
    expect(deleteByIds).toHaveBeenCalledTimes(1);
    expect(deleteByIds.mock.calls[0]?.[0]).toEqual([
      tenantVectorId(OTHER_TENANT_ID, ID_A),
      tenantVectorId(OTHER_TENANT_ID, ID_B),
    ]);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    // The record is KEPT now, unlike the R2 object it replaces (F4): it carries
    // no reading id, and it is the evidence a later slice gates on. The ledger
    // rows are gone too — cleared by the confirmation, which is what "wiped"
    // now means.
    const progress = await readProgress();
    expect(progress!.completedAtMs).not.toBeNull();
    expect(await ledgerRows()).toEqual([]);
  });

  // No post-empty re-submit any more: a delivery resuming at the objects phase
  // has nothing left in the ledger to submit, and a vector published afterwards
  // ledgers itself, so a LATER pass finds it rather than a sweep here.
  it("resuming at the objects phase empties the prefix without re-submitting deletes", async () => {
    // Failed readings: no vectors, so no ledger rows are expected of them.
    await seedTenantObjects([ID_A, ID_B], { ledger: false, status: "failed" });
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

  // Leftover recovery takes its ids from the ledger, not from anything the
  // finished record carried and not from an R2 re-list. That is the point of
  // the ledger: the objects can be gone and the id is still there.
  it("leftover recovery submits ledger ids even with no R2 objects to derive them from", async () => {
    // Objects for a DIFFERENT reading turn up under the prefix (the leftover),
    // while the ledger still names the one whose vector was never confirmed.
    await seedTenantObjects([ID_A], { ledger: false, status: "failed" });
    await seedLedger([ID_B]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await seedProgress({ phase: "done", objectsDeleted: 1, completedAtMs: NOW_MS });
    const result = await runWipeToCompletion(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      { t: NOW_MS },
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
    const taken = await runWipeToCompletion(queued[0]!, { t: cronAt });
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

  it("heartbeats the wipe lease during vector batches and R2 pages", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const clock = { t: NOW_MS };
    const seen: Array<{ phase: string; updatedAtMs: number }> = [];
    // The vectors phase no longer lists R2 at all — its ids come from the
    // ledger — so its heartbeat is observed after each `deleteByIds` batch
    // instead of after each list page.
    deleteByIds.mockImplementation(async (ids: string[]) => {
      clock.t += ACCOUNT_WIPE_IN_FLIGHT_MS;
      const result = { mutationId: `mut_${ids.length}` };
      queueMicrotask(() => {});
      return result;
    });
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
    const result = await runWipeToCompletion(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      clock,
      { env: jobEnv },
    );
    expect(result.kind).toBe("complete");
    // Still heartbeats, so cron does not produce duplicates it would only have
    // to turn away — advisory now rather than load-bearing.
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
      READINGS_BUCKET: env.READINGS_BUCKET,
    };
    // Cron runs while the job is still in its vectors phase. The clock never
    // moves, so the lease looks expired at the boundary and cron claims it; the
    // job then loses the always-written phase-transition persist. Hung off the
    // vector submit rather than an R2 list because the vectors phase no longer
    // lists R2 at all.
    deleteByIds.mockImplementation(async (ids: string[]) => {
      if (cronRun === null) {
        cronRun = { enqueued: -1 };
        cronRun = await fanOutDueAccountWipes(await wipeEnv(), {
          nowMs: NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS,
        });
      }
      return { mutationId: `mut_${ids.length}` };
    });
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
    const finished = await runWipeToCompletion(queued[0]!, { t: NOW_MS });
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
    const clock = { t: NOW_MS };
    const result = await runWipeToCompletion(accountWipeEnvelopeV1({ tenantId: TENANT }), clock);
    expect(result).toMatchObject({ kind: "complete", residue: false });
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    const progress = await readProgress();
    expect(progress).not.toBeNull();
    expect(progress!.phase).toBe("done");
    expect(progress!.completedAtMs).toBe(clock.t);
    expect(progress!.residue).toBe(false);
    expect(progress!.objectsDeleted).toBeGreaterThan(0);
    // No reading id anywhere on the surviving record. `vector_cursor` was the
    // one field that ever held one and it is gone with migration 0010; the
    // ledger rows that DID name this reading were cleared by the confirmation.
    expect(progress!.r2Cursor).toBeUndefined();
    expect(JSON.stringify(progress)).not.toContain(ID_A);
    expect(await ledgerRows()).toEqual([]);
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

  // The first write for a tenant is an INSERT, not an UPDATE, so it has its own
  // way to lose: `INSERT … WHERE NOT EXISTS` only yields `changes = 0` when the
  // two writers are serialized. If both evaluate NOT EXISTS before either
  // commits, the loser hits the primary key. That must surface as the same
  // conflict, or it escapes the lease path and burns queue retry budget.
  it("turns a losing first insert into a conflict rather than a raw constraint error", async () => {
    const db = controlPlane();
    expect(await readWipeProgress(db, TENANT)).toBeNull();
    // Both deliveries believe the row is absent, which is what makes them both
    // take the insert path.
    const winner = new WipeProgressWriter(db, TENANT, null);
    const loser = new WipeProgressWriter(db, TENANT, null);

    await winner.write(emptyWipeProgress(NOW_MS));
    await expect(loser.write(emptyWipeProgress(NOW_MS))).rejects.toBeInstanceOf(
      AccountWipeProgressConflictError,
    );
    expect((await readWipeProgress(db, TENANT))!.leaseSeq).toBe(1);
  });

  // The same contention seen through the job: a delivery whose record moved
  // under it reports `lease_held` and is acked, not retried into the DLQ.
  it("reports lease_held and acks when another delivery owns the wipe", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await seedProgress({ phase: "vectors" });
    // A sibling advances the lease after this delivery has read the row but
    // before its next write — modelled by bumping the row out from under it as
    // the vectors phase submits. (Hung off the vector submit rather than an R2
    // read: the vectors phase takes its ids from the ledger and never touches
    // R2 at all now.)
    deleteByIds.mockImplementation(async (ids: string[]) => {
      await env.CONTROL_PLANE.prepare(
        "UPDATE wipe_progress SET lease_seq = lease_seq + 1 WHERE tenant_id = ?",
      )
        .bind(OTHER_TENANT_ID)
        .run();
      return { mutationId: `mut_${ids.length}` };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ack = vi.fn();
    const retry = vi.fn();
    await consumeAccountWipeMessage(
      { body: accountWipeEnvelopeV1({ tenantId: TENANT }), ack, retry, attempts: 1 },
      await wipeEnv(),
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
    // The vector is still there on the per-id read too, so the fallback agrees
    // with the namespace probe and no ledger row clears.
    getByIds.mockImplementation(async (ids: string[]) => ids.map((id) => ({ id })));
    // Pass 1 only submits: the confirmation is not allowed to count anything
    // until +120s (defect D2's fix), so it is the SECOND pass that observes a
    // namespace that still answers.
    const clock = { t: NOW_MS };
    await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      await wipeEnv(),
      wipeJobDeps({ clock }),
    ).catch(() => {});
    clock.t += VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS;
    await expect(
      processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps({ clock }),
      ),
    ).rejects.toThrow(/ledger_not_empty/);
    // The row survives, which is the whole point: it is the only remaining
    // handle on a vector nobody has confirmed gone.
    expect((await ledgerRows()).map((row) => row.reading_id)).toEqual([ID_A]);
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
  // Defect D2's fix, asserted directly: the first pass does not probe at all.
  // It waits out the measured propagation window instead of spending an attempt
  // on a read that is guaranteed to hit and carries no information.
  it("waits the first-confirmation delay before probing at all, rather than burning an attempt", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const retry = vi.fn();
    const ack = vi.fn();
    await consumeAccountWipeMessage(
      { body: accountWipeEnvelopeV1({ tenantId: TENANT }), ack, retry, attempts: 1 },
      await wipeEnv(),
      wipeJobDeps(),
    );
    expect(ack).not.toHaveBeenCalled();
    // The full first-confirmation delay, not the 30s exponential every other
    // failure takes, and not the old flat 300s.
    expect(retry).toHaveBeenCalledWith({
      delaySeconds: VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS / 1000,
    });
    // No probe was made and no attempt was spent.
    expect(queryIndex).not.toHaveBeenCalled();
    expect((await readProgress())!.probeAttempts).toBe(0);
    // S6 measured deleteByIds propagation at 30-90s; the delay clears it.
    expect(VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS).toBeGreaterThanOrEqual(90_000);
  });

  // A confirmation attempt that genuinely observed something backs off on the
  // doubling schedule S6 sized, not the fast exponential.
  it("backs off a confirmation attempt on the doubling schedule", async () => {
    await seedLedgerSubmitted([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    queryIndex.mockImplementation(async () => ({
      count: 1,
      matches: [{ id: tenantVectorId(OTHER_TENANT_ID, ID_A), score: 1, metadata: {} }],
    }));
    getByIds.mockImplementation(async (ids: string[]) => ids.map((id) => ({ id })));
    const retry = vi.fn();
    const ack = vi.fn();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await consumeAccountWipeMessage(
      { body: accountWipeEnvelopeV1({ tenantId: TENANT }), ack, retry, attempts: 1 },
      await wipeEnv(),
      wipeJobDeps(),
    );
    consoleErr.mockRestore();
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({
      delaySeconds: VECTOR_LEDGER_BACKOFF_MS[0]! / 1000,
    });
    expect((await readProgress())!.probeAttempts).toBe(1);
  });

  // Ruling 3: the probe must not gate forever on a vector the code documents as
  // structurally unaddressable. Bound the attempts, then alert and finish.
  it("alerts and completes once the probe attempt bound is exhausted", async () => {
    await seedTenantObjects([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    await seedLedgerSubmitted([ID_A]);
    await seedProgress({
      phase: "objects",
      mutationIds: ["mut_old"],
      objectsDeleted: 1,
      probeAttempts: ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS - 1,
    });
    queryIndex.mockImplementation(async () => ({
      count: 1,
      matches: [{ id: tenantVectorId(OTHER_TENANT_ID, ID_A), score: 1, metadata: {} }],
    }));
    getByIds.mockImplementation(async (ids: string[]) => ids.map((id) => ({ id })));
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
    expect(JSON.stringify(progress)).not.toContain(ID_A);
    // The ledger row is KEPT: it is the only remaining handle on a vector
    // nobody could confirm gone, and S5's residue scan reads it.
    expect((await ledgerRows()).map((row) => row.reading_id)).toEqual([ID_A]);
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
    await seedLedgerSubmitted([ID_A]);
    await seedProgress({
      phase: "objects",
      mutationIds: ["mut_old"],
      objectsDeleted: 1,
      probeAttempts: ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS - 1,
    });
    queryIndex.mockImplementation(async () => {
      throw new Error("vectorize unavailable");
    });
    // The per-id fallback is unavailable too, so nothing was observed at all.
    // A getByIds that FAILED must never be read as "the id is absent" — that is
    // the 20-id-cap trap the confirmation rule exists to refuse.
    getByIds.mockImplementation(async () => {
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
    await seedLedgerSubmitted([ID_A]);
    await seedProgress({
      phase: "objects",
      mutationIds: ["mut_old"],
      objectsDeleted: 1,
      probeAttempts: ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS - 1,
      // Earlier attempts in this wipe saw actual vectors.
      probeSawResidue: true,
    });
    queryIndex.mockImplementation(async () => {
      throw new Error("vectorize unavailable");
    });
    getByIds.mockImplementation(async () => {
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
    await seedTenantObjects([ID_A], { ledger: false });
    // A ledger row already past its first-confirmation delay, so the reopened
    // pass reaches a real confirmation attempt rather than merely waiting.
    await seedLedgerSubmitted([ID_A]);
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
    getByIds.mockImplementation(async (ids: string[]) => ids.map((id) => ({ id })));
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
      ).rejects.toThrow(/ledger_not_empty/);
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

  // Ruling 1. Reopening clears `completed_at_ms` — correct, the reopened wipe
  // really does have work left and the teardown gate must not fire — but that
  // used to erase the only evidence the earlier wipe ever finished. If the
  // reopen's enqueue fails or its pass dead-letters, the row would be left
  // saying nothing had ever been wiped. The first-completion pair is write-once
  // and survives.
  it("keeps the first-completion record when a wipe is reopened and never finishes", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    // A clean first wipe.
    await seedTenantObjects([ID_A]);
    const clock = { t: NOW_MS };
    const first = await runWipeToCompletion(accountWipeEnvelopeV1({ tenantId: TENANT }), clock);
    expect(first.kind).toBe("complete");
    const completed = await readProgress();
    expect(completed!.completedAtMs).toBe(clock.t);
    expect(completed!.firstCompletedAtMs).toBe(clock.t);
    expect(completed!.firstResidue).toBe(false);

    // Objects turn up again, so cron reopens the wipe.
    await seedTenantObjects([ID_B]);
    expect(await fanOutDueAccountWipes(await wipeEnv(), { nowMs: clock.t })).toEqual({
      enqueued: 1,
    });
    const reopened = await readProgress();
    // Current state says work is owed, so a teardown gate on completedAtMs
    // correctly refuses to fire...
    expect(reopened!.completedAtMs).toBeNull();
    expect(reopened!.phase).toBe("vectors");
    // ...but the history that the earlier wipe completed is intact, which is
    // what the residue scan and support read.
    expect(reopened!.firstCompletedAtMs).toBe(completed!.completedAtMs);
    expect(reopened!.firstResidue).toBe(false);
  });

  // Write-once is enforced in SQL, not only by the caller, so a second
  // completion cannot move the history even if a caller passes a fresh pair.
  it("pins the first-completion pair against a later completion", async () => {
    const db = controlPlane();
    await seedProgress({ phase: "objects" });
    const stored = await readWipeProgress(db, TENANT);
    const writer = new WipeProgressWriter(db, TENANT, stored);

    await writer.complete(stored!, NOW_MS, false);
    const afterFirst = await readWipeProgress(db, TENANT);
    expect(afterFirst!.firstCompletedAtMs).toBe(NOW_MS);
    expect(afterFirst!.firstResidue).toBe(false);

    // A later pass completes again, this time leaving residue.
    const later = NOW_MS + 60_000;
    await writer.complete(
      { ...afterFirst!, firstCompletedAtMs: later, firstResidue: true },
      later,
      true,
    );
    const afterSecond = await readWipeProgress(db, TENANT);
    // Current pair moves; the history does not.
    expect(afterSecond!.completedAtMs).toBe(later);
    expect(afterSecond!.residue).toBe(true);
    expect(afterSecond!.firstCompletedAtMs).toBe(NOW_MS);
    expect(afterSecond!.firstResidue).toBe(false);
  });

  // Ruling 3. A heartbeat is a full-row D1 UPDATE, and beating on every page put
  // hundreds of them inside one delivery. The lease is a version now, so the
  // beat only has to keep cron from thinking the job died.
  it("heartbeats on an interval rather than once per page", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const pages = 6;
    const keys = Array.from(
      { length: R2_LIST_LIMIT * pages },
      (_, i) => `${PREFIX}pad/${String(i).padStart(6, "0")}`,
    );
    const memory = memoryBucket(keys);
    // A clock that barely moves, so nothing reaches the beat interval.
    const clock = { t: NOW_MS };
    const jobEnv = {
      ...(await wipeEnv()),
      READINGS_BUCKET: wrapBucketClock(memory.bucket, clock, { advanceListMs: 10 }),
    };
    const result = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      jobEnv,
      wipeJobDeps({ clock }),
    );
    expect(result.kind).toBe("complete");
    expect(memory.keysUnder(PREFIX)).toEqual([]);

    // Every write bumps lease_seq, so it counts the D1 writes this job made.
    // The claim and the terminal record are unconditional; the per-page beats
    // are not, and six pages must not cost six-plus writes each.
    const progress = await readProgress();
    expect(progress!.leaseSeq).toBeLessThan(pages);
  });

  // Throttling must never swallow a write a later delivery depends on.
  it("still persists the cursor and continuation count across a self-send", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const keys = Array.from(
      { length: R2_LIST_LIMIT * 3 },
      (_, i) => `${PREFIX}pad/${String(i).padStart(6, "0")}`,
    );
    const memory = memoryBucket(keys);
    const clock = { t: NOW_MS };
    const jobEnv = {
      ...(await wipeEnv()),
      READINGS_BUCKET: wrapBucketClock(memory.bucket, clock, { advanceListMs: 10 }),
    };
    const first = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      jobEnv,
      wipeJobDeps({ clock, maxObjectPages: 1 }),
    );
    expect(first.kind).toBe("continue");
    // Persisted despite the clock never reaching the beat interval.
    const progress = await readProgress();
    expect(progress!.phase).toBe("objects");
    expect(progress!.r2Cursor).toBeTruthy();
    expect(progress!.continuations).toBe(1);
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
    const result = await runWipeToCompletion(
      accountWipeEnvelopeV1({ tenantId: TENANT }),
      { t: NOW_MS },
    );
    expect(result.kind).toBe("complete");
    expect((await readProgress())!.continuations).toBe(0);
  });

  // The confirmation rule against the live index (issue #195 S3). The pure
  // rule has its own tests in test/unit/control-plane/vector-ledger-rule.test.ts;
  // these are about how the wipe applies it.
  describe("ledger confirmation", () => {
    it("clears the whole tenant's ledger in one namespaced query when it comes back empty", async () => {
      // S6 §5.3's fast path. No id in a namespace can be live when the
      // namespace itself answers nothing, so 30 rows clear in one call rather
      // than ceil(30 / 20) getByIds requests.
      const ids = Array.from({ length: 30 }, (_, i) => `rd_${String(i).padStart(10, "0")}`);
      await seedLedgerSubmitted(ids);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      const result = await processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps(),
      );
      expect(result.kind).toBe("complete");
      expect(await ledgerRows()).toEqual([]);
      expect(queryIndex).toHaveBeenCalledTimes(1);
      expect(getByIds).not.toHaveBeenCalled();
    });

    it("falls back to per-id getByIds when the namespace still answers, and needs two spaced absences", async () => {
      await seedLedgerSubmitted([ID_A, ID_B]);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      // The namespace still returns something (another id entirely), so the
      // fast path cannot clear anything and the per-id read decides.
      queryIndex.mockImplementation(async () => ({
        count: 1,
        matches: [{ id: tenantVectorId(OTHER_TENANT_ID, "rd_9999999999"), score: 1, metadata: {} }],
      }));
      // ID_A is gone; ID_B is still live.
      getByIds.mockImplementation(async (requested: string[]) =>
        requested
          .filter((id) => id === tenantVectorId(OTHER_TENANT_ID, ID_B))
          .map((id) => ({ id })),
      );
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
      const clock = { t: NOW_MS };

      // First confirmation: one absence for ID_A. Not enough on its own — a
      // single empty read is exactly what the two-confirmation rule refuses to
      // act on, because clearing a row for a live vector is unrecoverable.
      await expect(
        processAccountWipeJob(
          accountWipeEnvelopeV1({ tenantId: TENANT }),
          await wipeEnv(),
          wipeJobDeps({ clock }),
        ),
      ).rejects.toThrow(/ledger_not_empty/);
      expect((await ledgerRows()).map((r) => [r.reading_id, r.absent_streak])).toEqual([
        [ID_A, 1],
        [ID_B, 0],
      ]);

      // Second confirmation, a full backoff interval later: ID_A clears, ID_B
      // does not — per-id evidence, not a verdict about the request as a whole.
      clock.t += VECTOR_LEDGER_BACKOFF_MS[0]!;
      await expect(
        processAccountWipeJob(
          accountWipeEnvelopeV1({ tenantId: TENANT }),
          await wipeEnv(),
          wipeJobDeps({ clock }),
        ),
      ).rejects.toThrow(/ledger_not_empty/);
      consoleErr.mockRestore();
      expect((await ledgerRows()).map((r) => r.reading_id)).toEqual([ID_B]);
    });

    it("does not clear a row on two absences that are not spaced apart", async () => {
      // The spacing is the load-bearing half of the rule: two calls in the same
      // isolate hit the same replica milliseconds apart and confirm nothing.
      await seedLedgerSubmitted([ID_A]);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      queryIndex.mockImplementation(async () => ({
        count: 1,
        matches: [{ id: tenantVectorId(OTHER_TENANT_ID, "rd_9999999999"), score: 1, metadata: {} }],
      }));
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
      const clock = { t: NOW_MS };
      for (let pass = 0; pass < 2; pass++) {
        await processAccountWipeJob(
          accountWipeEnvelopeV1({ tenantId: TENANT }),
          await wipeEnv(),
          wipeJobDeps({ clock }),
        ).catch(() => {});
        clock.t += 1_000; // Well under VECTOR_LEDGER_MIN_CONFIRM_SPACING_MS.
      }
      consoleErr.mockRestore();
      expect((await ledgerRows()).map((r) => [r.reading_id, r.absent_streak])).toEqual([[ID_A, 1]]);
    });

    it("treats a failed getByIds as no information and resets the streak", async () => {
      // The 20-id cap makes this concrete: an over-cap chunk answers 400 with an
      // empty body, which a naive reader parses as "all of them are gone".
      await seedLedgerSubmitted([ID_A]);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      queryIndex.mockImplementation(async () => ({
        count: 1,
        matches: [{ id: tenantVectorId(OTHER_TENANT_ID, "rd_9999999999"), score: 1, metadata: {} }],
      }));
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
      const clock = { t: NOW_MS };
      // A clean absence first, building a streak of 1.
      await processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps({ clock }),
      ).catch(() => {});
      expect((await ledgerRows())[0]!.absent_streak).toBe(1);

      // Then a failure. The row must NOT clear, and the streak must go back to
      // zero rather than count the failure as the second absence.
      getByIds.mockImplementation(async () => {
        throw new Error("400 too many ids in payload");
      });
      clock.t += VECTOR_LEDGER_BACKOFF_MS[0]!;
      await processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps({ clock }),
      ).catch(() => {});
      consoleErr.mockRestore();
      expect((await ledgerRows()).map((r) => [r.reading_id, r.absent_streak])).toEqual([[ID_A, 0]]);
    });

    it("never reads describe() as part of the confirmation", async () => {
      // S6 §3.5 measured vectorCount and processedUpToMutation going BACKWARDS
      // between replicas while getByIds and the namespaced query were correct
      // throughout. describe() is logged as a breadcrumb and gates nothing, so
      // an index whose describe() lies must still wipe cleanly.
      await seedLedgerSubmitted([ID_A]);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      (env as unknown as Env).READINGS_INDEX = {
        ...((env as unknown as Env).READINGS_INDEX as unknown as Record<string, unknown>),
        describe: vi.fn(async () => ({ vectorCount: 999_999 })),
      } as unknown as VectorizeIndex;
      const result = await processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps(),
      );
      expect(result).toMatchObject({ kind: "complete", residue: false });
      expect(await ledgerRows()).toEqual([]);
    });

    it("goes back to the vectors phase for a row ledgered after that phase passed", async () => {
      // The late-publish case the ledger exists to catch. A publisher (or an
      // operator's offline writer) upserts a vector, and ledgers it, after this
      // pass's vectors phase is already past. Confirming around it would leave a
      // vector nobody ever asked Vectorize to delete — and, once R2 is empty, the
      // ledger row would be the only thing that knew about it.
      // The earlier pass already submitted and confirmed everything it knew
      // about, so it left no ledger row of its own.
      await seedTenantObjects([ID_A], { ledger: false, status: "failed" });
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      await seedProgress({ phase: "objects", mutationIds: ["mut_old"] });
      await seedLedger([ID_B]);

      const first = await processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps(),
      );
      // Not "complete" and not a confirmation retry: a self-send that reopens
      // the vectors phase.
      expect(first.kind).toBe("continue");
      expect((await readProgress())!.phase).toBe("vectors");
      expect(deleteByIds).not.toHaveBeenCalled();

      const done = await runWipeToCompletion(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        { t: NOW_MS },
      );
      expect(done.kind).toBe("complete");
      expect(deleteByIds).toHaveBeenCalledWith([tenantVectorId(OTHER_TENANT_ID, ID_B)]);
      expect(await ledgerRows()).toEqual([]);
    });

    // The unseeded-tenant case, and the reason the namespace probe is
    // unconditional. An empty ledger is NOT proof of an empty namespace — it is
    // also exactly what a corpus that predates this slice looks like, and
    // merging auto-deploys production before anyone can run
    // `ops corpus seed-vector-ledger`. Short-circuiting to success on an empty
    // ledger would report a clean wipe having asked Vectorize nothing at all.
    // The unseeded-tenant guard, and the reason it sits BEFORE the objects
    // phase rather than at the terminal gate. A corpus that predates this slice
    // has vectors and no ledger rows, so the vectors phase submits nothing —
    // and if the objects phase then ran, it would delete the very R2 objects
    // `ops corpus seed-vector-ledger` derives those ids from. Noticing at the
    // terminal probe would be too late: the ids would already be gone.
    it("refuses to delete R2 for an unseeded tenant whose namespace still answers", async () => {
      await seedTenantObjects([ID_A], { ledger: false });
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      expect(await ledgerRows()).toEqual([]);
      const before = await listPrefixKeys(PREFIX);
      expect(before).not.toEqual([]);
      queryIndex.mockImplementation(async () => ({
        count: 1,
        matches: [{ id: tenantVectorId(OTHER_TENANT_ID, ID_A), score: 1, metadata: {} }],
      }));
      const errors: string[] = [];
      const consoleErr = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
        errors.push(String(line));
      });
      await expect(
        processAccountWipeJob(
          accountWipeEnvelopeV1({ tenantId: TENANT }),
          await wipeEnv(),
          wipeJobDeps(),
        ),
      ).rejects.toThrow(/unseeded_tenant/);
      consoleErr.mockRestore();
      // NOTHING was deleted — the ids are still derivable, so seeding can still
      // rescue this tenant.
      expect(await listPrefixKeys(PREFIX)).toEqual(before);
      expect((await readProgress())!.completedAtMs).toBeNull();
      const alert = errors.find((line) => line.includes("account_wipe_unseeded_tenant"));
      expect(alert).toBeDefined();
      const payload = JSON.parse(alert!) as Record<string, unknown>;
      expect(payload.severity).toBe("high");
      expect(payload.tenant_id).toBe(OTHER_TENANT_ID);
      // Tenant id only: an alert about a deleted account must not carry that
      // account's reading ids.
      expect(alert).not.toContain(ID_A);
    });

    it("is not satisfied by one unrelated ledger row while the corpus is unseeded", async () => {
      // The bypass that made the first version of this guard useless. A tenant
      // whose pre-S3 corpus was never seeded but who has published or purged a
      // SINGLE reading since the deploy has one ledger row — and a wipe runs at
      // least seven days after the deletion request, so that is the ordinary
      // state of a live account, not an edge case. Testing for a non-empty
      // table would wave the whole legacy corpus through to deletion.
      await seedTenantObjects([ID_A, ID_B], { ledger: false });
      await seedLedger([ID_B]); // one reading published since the deploy
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      const before = await listPrefixKeys(PREFIX);
      queryIndex.mockImplementation(async () => ({
        count: 1,
        matches: [{ id: tenantVectorId(OTHER_TENANT_ID, ID_A), score: 1, metadata: {} }],
      }));
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(
        processAccountWipeJob(
          accountWipeEnvelopeV1({ tenantId: TENANT }),
          await wipeEnv(),
          wipeJobDeps(),
        ),
      ).rejects.toThrow(/unseeded_tenant/);
      consoleErr.mockRestore();
      // ID_A is still un-ledgered and its objects — the only source of its id —
      // are untouched.
      expect(await listPrefixKeys(PREFIX)).toEqual(before);
    });

    it("does not accuse a healthy tenant that has failed readings alongside live vectors", async () => {
      // The false positive that made the second version of this guard unusable.
      // Intake writes an `index/by-id/{id}` pointer for `failed` and `pending`
      // readings, but those never get a ledger row because they never get a
      // vector — the failure paths publish with a null similarity store. A
      // guard measuring "every id derivable from R2" therefore fired on the
      // ordinary shape: one failed reading plus one live vector. And its
      // namespace check could not save it, because the probe runs in the same
      // pass that just submitted deletes, inside the 30-90s propagation window.
      const reader = testReadingStore(env, otherTenant());
      await reader.writeListIndex({
        version: 1,
        items: [indexItem(ID_A, "ready"), indexItem(ID_B, "failed")],
      });
      for (const id of [ID_A, ID_B]) {
        await reader.writeByIdPointer(id, { id, key_prefix: `readings/2026/04/26T200000Z-${id}` });
        await env.READINGS_BUCKET.put(
          `${PREFIX}readings/2026/04/26T200000Z-${id}/manifest.json`,
          JSON.stringify({ id }),
        );
      }
      // Only the ready one is ledgered, which is correct and complete coverage.
      await seedLedger([ID_A]);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      // The namespace answers, as it does for the whole propagation window.
      let probes = 0;
      queryIndex.mockImplementation(async () => {
        probes += 1;
        return probes === 1
          ? { count: 1, matches: [{ id: tenantVectorId(OTHER_TENANT_ID, ID_A), score: 1, metadata: {} }] }
          : { count: 0, matches: [] };
      });

      const errors: string[] = [];
      const consoleErr = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
        errors.push(String(line));
      });
      const result = await runWipeToCompletion(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        { t: NOW_MS },
      );
      consoleErr.mockRestore();
      expect(result.kind).toBe("complete");
      expect(errors.find((l) => l.includes("account_wipe_unseeded_tenant"))).toBeUndefined();
      expect(await listPrefixKeys(PREFIX)).toEqual([]);
    });

    it("refuses when a READY reading has no ledger row, even beside a ledgered one", async () => {
      // The other side of the same line. A ready reading owns a vector, so a
      // missing row for it is a real coverage hole however many other rows
      // exist.
      await seedTenantObjects([ID_A, ID_B], { ledger: false });
      await seedLedger([ID_B]);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      const before = await listPrefixKeys(PREFIX);
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(
        processAccountWipeJob(
          accountWipeEnvelopeV1({ tenantId: TENANT }),
          await wipeEnv(),
          wipeJobDeps(),
        ),
      ).rejects.toThrow(/unseeded_tenant/);
      consoleErr.mockRestore();
      expect(await listPrefixKeys(PREFIX)).toEqual(before);
    });

    it("does not fire once the prefix is empty, so residue takes the designed path", async () => {
      // The guard exists to keep R2 objects alive, because they are the only
      // source the seeding command derives ids from. With the prefix already
      // emptied there is nothing to save, and refusing would swap a designed
      // outcome — bounded attempts, then a residue alert and a completion
      // record — for a dead-letter loop whose alert tells the operator to seed
      // a corpus that no longer exists.
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      expect(await listPrefixKeys(PREFIX)).toEqual([]);
      // Empty ledger, empty prefix, and a namespace that still answers: exactly
      // the un-ledgered-residue shape (a legacy bare-id vector, say).
      queryIndex.mockImplementation(async () => ({
        count: 1,
        matches: [{ id: tenantVectorId(OTHER_TENANT_ID, ID_A), score: 1, metadata: {} }],
      }));
      const errors: string[] = [];
      const consoleErr = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
        errors.push(String(line));
      });
      const clock = { t: NOW_MS };
      let result: Awaited<ReturnType<typeof processAccountWipeJob>> | null = null;
      for (let pass = 0; pass < 8 && result === null; pass++) {
        try {
          result = await processAccountWipeJob(
            accountWipeEnvelopeV1({ tenantId: TENANT }),
            await wipeEnv(),
            wipeJobDeps({ clock }),
          );
        } catch (error) {
          // Never the unseeded refusal — that is the whole point.
          expect(error).toBeInstanceOf(AccountWipeNamespaceNotEmptyError);
          clock.t += (error as AccountWipeNamespaceNotEmptyError).retryAfterSeconds * 1000;
        }
      }
      consoleErr.mockRestore();
      expect(result).toMatchObject({ kind: "complete", residue: true });
      expect(errors.find((l) => l.includes("account_wipe_namespace_residue"))).toBeDefined();
      expect(errors.find((l) => l.includes("account_wipe_unseeded_tenant"))).toBeUndefined();
    });

    it("falls back to the empty-ledger test when the list index cannot be read", async () => {
      // No readable index means coverage cannot be measured, so the guard asks
      // the one question that is still answerable: nothing in the ledger at all
      // and a namespace that answers. A ledger with rows is evidence something
      // seeded or published this tenant, and there is no honest way to ask for
      // more without the index.
      await env.READINGS_BUCKET.put(`${PREFIX}index/list.json`, "{not json");
      await env.READINGS_BUCKET.put(`${PREFIX}readings/x/manifest.json`, "{}");
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      queryIndex.mockImplementation(async () => ({
        count: 1,
        matches: [{ id: tenantVectorId(OTHER_TENANT_ID, ID_A), score: 1, metadata: {} }],
      }));
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(
        processAccountWipeJob(
          accountWipeEnvelopeV1({ tenantId: TENANT }),
          await wipeEnv(),
          wipeJobDeps(),
        ),
      ).rejects.toThrow(/unseeded_tenant/);
      consoleErr.mockRestore();
      expect(await listPrefixKeys(PREFIX)).not.toEqual([]);
    });

    it("does not let an old purge row vouch for an unseeded corpus in the fallback", async () => {
      // A `delete_submitted` row is what a single-reading purge leaves, and on
      // a tenant that is never wiped it is permanent — so counting it as
      // evidence of seeding would let one ordinary DELETE, months earlier,
      // speak for a corpus nobody ever seeded. Only a `live` row says a vector
      // was actually ledgered.
      await env.READINGS_BUCKET.put(`${PREFIX}index/list.json`, "{not json");
      await env.READINGS_BUCKET.put(`${PREFIX}readings/x/manifest.json`, "{}");
      await seedLedgerSubmitted([ID_B]); // the old purge
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      queryIndex.mockImplementation(async () => ({
        count: 1,
        matches: [{ id: tenantVectorId(OTHER_TENANT_ID, ID_A), score: 1, metadata: {} }],
      }));
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(
        processAccountWipeJob(
          accountWipeEnvelopeV1({ tenantId: TENANT }),
          await wipeEnv(),
          wipeJobDeps(),
        ),
      ).rejects.toThrow(/unseeded_tenant/);
      consoleErr.mockRestore();
      expect(await listPrefixKeys(PREFIX)).not.toEqual([]);
    });

    it("accepts a live row as evidence of seeding in the fallback", async () => {
      // The other half: a `live` row is a vector someone ledgered, which is the
      // evidence the fallback is looking for when the index cannot be read.
      await env.READINGS_BUCKET.put(`${PREFIX}index/list.json`, "{not json");
      await env.READINGS_BUCKET.put(`${PREFIX}readings/x/manifest.json`, "{}");
      await seedLedger([ID_A]);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      const result = await runWipeToCompletion(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        { t: NOW_MS },
      );
      expect(result.kind).toBe("complete");
      expect(deleteByIds).toHaveBeenCalledWith([tenantVectorId(OTHER_TENANT_ID, ID_A)]);
    });

    it("does not refuse a seeded wipe mid-flight once its index has been deleted", async () => {
      // The objects phase deletes `index/list.json` like everything else, so a
      // continuation or confirmation retry re-enters with no readable index and
      // its rows already flipped to `delete_submitted`. Having submitted deletes
      // is the same evidence by a different route, so the fallback must not
      // refuse the very wipe that produced it.
      await seedTenantObjects([ID_A]);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      await seedProgress({ phase: "objects", mutationIds: ["mut_earlier"] });
      await seedLedgerSubmitted([ID_A]);
      await env.READINGS_BUCKET.delete(`${PREFIX}index/list.json`);
      queryIndex.mockImplementation(async () => ({
        count: 1,
        matches: [{ id: tenantVectorId(OTHER_TENANT_ID, ID_A), score: 1, metadata: {} }],
      }));
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
      const outcome = await processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps(),
      ).catch((error: unknown) => error);
      consoleErr.mockRestore();
      // Whatever it does next, it must not be the unseeded refusal.
      expect(String(outcome)).not.toMatch(/unseeded_tenant/);
      expect(await listPrefixKeys(PREFIX)).toEqual([]);
    });

    it("runs the coverage check before the vectors phase, once, and records it", async () => {
      // Placement is the whole design. The vectors phase flips rows from `live`
      // to `delete_submitted`, so a live-row count stops measuring coverage the
      // moment it runs — the check has to precede it. And it is stamped, so a
      // later delivery honours a verdict reached while the rows still meant
      // something rather than re-deciding against a half-submitted ledger.
      await seedTenantObjects([ID_A]);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      const clock = { t: NOW_MS };
      await processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps({ clock }),
      ).catch(() => {});
      const progress = await readProgress();
      expect(progress!.coverageVerifiedAtMs).toBe(NOW_MS);
      // And a reopen re-verifies: leftover objects mean the corpus moved on.
      expect(reopenWipeProgress(progress!, false).coverageVerifiedAtMs).toBeNull();
    });

    it("does not wave a large corpus through just because one row exists", async () => {
      // The hole the previous placement left. Above the id-by-id scan limit the
      // guard compares counts — and with the check running after the vectors
      // phase, a single ledger row was enough to make that phase submit one
      // delete, which short-circuited the comparison entirely. The guard became
      // "does the ledger have any rows", the very test it rejects, on exactly
      // the corpora too big to check precisely.
      const many = Array.from({ length: LEDGER_COVERAGE_MAX_SCAN + 5 }, (_, i) =>
        `rd_${String(i).padStart(10, "0")}`,
      );
      const reader = testReadingStore(env, otherTenant());
      await reader.writeListIndex({ version: 1, items: many.map((id) => indexItem(id, "ready")) });
      await env.READINGS_BUCKET.put(`${PREFIX}readings/keep/manifest.json`, "{}");
      // One row only — a single publish since the deploy, or a partial seed.
      await seedLedger([many[0]!]);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      const before = await listPrefixKeys(PREFIX);
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(
        processAccountWipeJob(
          accountWipeEnvelopeV1({ tenantId: TENANT }),
          await wipeEnv(),
          wipeJobDeps(),
        ),
      ).rejects.toThrow(/unseeded_tenant/);
      consoleErr.mockRestore();
      expect(await listPrefixKeys(PREFIX)).toEqual(before);
      // Nothing was submitted either: the check precedes the vectors phase.
      expect(deleteByIds).not.toHaveBeenCalled();
    });

    it("accepts a large corpus whose live rows cover every ready reading", async () => {
      const many = Array.from({ length: LEDGER_COVERAGE_MAX_SCAN + 5 }, (_, i) =>
        `rd_${String(i).padStart(10, "0")}`,
      );
      const reader = testReadingStore(env, otherTenant());
      await reader.writeListIndex({ version: 1, items: many.map((id) => indexItem(id, "ready")) });
      await env.READINGS_BUCKET.put(`${PREFIX}readings/keep/manifest.json`, "{}");
      await seedLedger(many);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      const result = await runWipeToCompletion(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        { t: NOW_MS },
      );
      expect(result.kind).toBe("complete");
      expect(await listPrefixKeys(PREFIX)).toEqual([]);
    });

    it("accepts a wipe already in flight when the check landed", async () => {
      // The deploy window, and only it. Such a wipe has submitted deletes for
      // rows that were `live` when it read them — the evidence the check looks
      // for — and its ledger cannot be re-measured now they have flipped.
      await seedTenantObjects([ID_A], { ledger: false, status: "failed" });
      await seedLedgerSubmitted([ID_A]);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      await seedProgress({ phase: "objects", mutationIds: ["mut_from_before_the_deploy"] });
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
      const outcome = await processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps(),
      ).catch((error: unknown) => error);
      consoleErr.mockRestore();
      expect(String(outcome)).not.toMatch(/unseeded_tenant/);
      expect((await readProgress())!.coverageVerifiedAtMs).not.toBeNull();
    });

    it("proceeds once every reading in the corpus has a ledger row", async () => {
      // The same corpus, fully seeded. Coverage is what the guard measures, so
      // completing it is what unblocks the wipe.
      await seedTenantObjects([ID_A, ID_B]);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      const result = await runWipeToCompletion(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        { t: NOW_MS },
      );
      expect(result.kind).toBe("complete");
      expect(await listPrefixKeys(PREFIX)).toEqual([]);
    });

    it("lets an unseeded corpus of failed readings through: no vectors, nothing to strand", async () => {
      // An un-ledgered id alone does not block — a `failed` reading has no
      // vector. Both halves of the test have to hold: something missing from
      // the ledger AND a namespace that actually answers.
      await seedTenantObjects([ID_A, ID_B], { ledger: false, status: "failed" });
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      const result = await processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps(),
      );
      expect(result).toMatchObject({ kind: "complete", residue: false });
      expect(await listPrefixKeys(PREFIX)).toEqual([]);
    });

    it("lets an empty-ledger tenant through once the namespace is confirmed clean", async () => {
      // The other half of the guard. Nothing in the ledger AND a clean probe is
      // a tenant that genuinely has no vectors — the ordinary case for a corpus
      // with no ready readings — so the wipe proceeds and finishes.
      await seedTenantObjects([ID_A], { ledger: false, status: "failed" });
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      const result = await processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps(),
      );
      expect(result).toMatchObject({ kind: "complete", residue: false });
      expect(await listPrefixKeys(PREFIX)).toEqual([]);
    });

    it("does not consult the namespace guard for a tenant the ledger already tracks", async () => {
      // The guard is narrow on purpose: a ledger with rows IS tracking this
      // tenant's vectors, so the terminal confirmation handles whatever is
      // left and the objects phase is not blocked.
      await seedTenantObjects([ID_A]);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      const result = await runWipeToCompletion(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        { t: NOW_MS },
      );
      expect(result.kind).toBe("complete");
      expect(await listPrefixKeys(PREFIX)).toEqual([]);
    });

    it("the fast path clears confirmed rows but never a vector nobody has deleted", async () => {
      // The probe happens between the row read and the DELETE, so a publisher
      // can insert a `live` row inside that window. An empty namespace says
      // nothing about a vector that was upserted after it answered, and
      // clearing that row would delete the only record of it.
      await seedLedgerSubmitted([ID_A]);
      await seedLedger([ID_B]);
      // The probe instant authorizes the clear; a delete submitted after it is
      // deliberately left behind.
      expect(await clearTenantLedger(controlPlane(), TENANT, NOW_MS)).toBe(1);
      expect((await ledgerRows()).map((r) => [r.reading_id, r.state])).toEqual([[ID_B, "live"]]);
    });

    it("the fast path respects the same propagation floor as the per-id rule", async () => {
      // The fast path is the weakest evidence in the module and it clears the
      // most rows at once, so it must not clear a row whose delete was
      // submitted seconds ago. S6 measured deleteByIds taking 30-90s to become
      // visible; an empty namespace query is subject to exactly that lag, so a
      // probe cannot speak to a delete younger than the +120s floor either way.
      //
      // The mixed case is the one that matters: one old row (confirmable) and
      // one young row means the pass is NOT deferred, so the fast path runs
      // with a young row present.
      await seedLedgerSubmitted([ID_A]); // old: well past the floor
      await seedLedgerSubmitted([ID_B], NOW_MS - 5_000); // young: seconds ago
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
      await processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps(),
      ).catch(() => {});
      consoleErr.mockRestore();
      // The old row cleared on the empty probe; the young one survives to be
      // judged on a pass where it is old enough.
      expect((await ledgerRows()).map((r) => r.reading_id)).toEqual([ID_B]);
    });

    it("does not clear a delete submitted while the probe was in flight", async () => {
      // The probe instant is stamped BEFORE the call, not after. A delete
      // submitted by a concurrent purge while the probe was in flight takes a
      // stamp between the two, and an after-the-fact sample would sit above it —
      // clearing that row on evidence gathered before its vector's delete was
      // even asked for.
      await seedLedgerSubmitted([ID_A]);
      await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS);
      const clock = { t: NOW_MS };
      queryIndex.mockImplementation(async () => {
        // A purge lands mid-probe, for a different reading.
        clock.t += 5_000;
        await seedLedgerSubmitted([ID_B], clock.t);
        return { count: 0, matches: [] };
      });
      const result = await processAccountWipeJob(
        accountWipeEnvelopeV1({ tenantId: TENANT }),
        await wipeEnv(),
        wipeJobDeps({ clock }),
      ).catch((error: unknown) => error);
      // The row the probe could speak to is cleared; the one submitted after
      // the probe instant survives, so the wipe is not finished.
      expect((await ledgerRows()).map((r) => r.reading_id)).toEqual([ID_B]);
      expect(result).not.toMatchObject({ kind: "complete" });
    });

    it("does not clear a row that was re-marked live after the absence was observed", async () => {
      // A reading re-published between the getByIds that observed its absence
      // and the DELETE has a brand-new vector. Clearing its row because the
      // PREVIOUS vector was confirmed gone is the exact stranding the ledger
      // exists to prevent, reintroduced by the code meant to close it.
      const observedAt = NOW_MS - VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS - 1;
      await seedLedgerSubmitted([ID_A], observedAt);
      await seedLedger([ID_A]); // republished: state live, stamp cleared
      await clearLedgerRows(controlPlane(), TENANT, [
        { readingId: ID_A, deletedAtMs: observedAt },
      ]);
      expect((await ledgerRows()).map((r) => [r.reading_id, r.state])).toEqual([[ID_A, "live"]]);
    });

    it("re-marking a reading live clears the delete bookkeeping of its previous vector", async () => {
      // A reading republished after a delete was submitted has a NEW vector.
      // Carrying the old deleted_at_ms or streak forward would let a
      // confirmation about the previous vector clear a row describing this one.
      await seedLedgerSubmitted([ID_A]);
      await seedLedger([ID_A]);
      const rows = await ledgerRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe("live");
      expect(rows[0]!.deleted_at_ms).toBeNull();
      expect(rows[0]!.absent_streak).toBe(0);
    });
  });
});
