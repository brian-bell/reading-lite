import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_WIPE_GRACE_MS,
  ACCOUNT_WIPE_IN_FLIGHT_MS,
  ACCOUNT_WIPE_MAX_CONTINUATIONS,
  ACCOUNT_WIPE_MISSING_DELETING_AT_EVENT,
  R2_LIST_LIMIT,
  consumeAccountWipeMessage,
  fanOutDueAccountWipes,
  handleAccountWipeDeadLetter,
  processAccountWipeJob,
  type AccountWipeJobDeps,
} from "../../src/account-wipe";
import { buildArchiveExport } from "../../src/archive-export";
import { beginAccountDeletion } from "../../src/control-plane/account-delete";
import { archiveExportEnvelopeV1 } from "../../src/control-plane/export-envelope";
import { accountWipeEnvelopeV1, type AccountWipeEnvelopeV1 } from "../../src/control-plane/wipe-envelope";
import { resolveLoginEligibility } from "../../src/control-plane/eligibility";
import { parseTenantId } from "../../src/control-plane/ids";
import { toTimestamp } from "../../src/control-plane/pg-time";
import {
  emptyWipeProgress,
  readWipeProgress,
  WipeProgressWriter,
  type WipeProgress,
} from "../../src/control-plane/wipe-progress";
import worker, { type Env } from "../../src/index";
import { sqlSessionFor } from "../../src/modules/db/sql";
import { sha256Hex } from "../../src/services";
import { tenantKeyRoot } from "../../src/modules/stores/tenant-root";
import type { ListIndexItem } from "../../src/schemas/api";
import { testControlPlane } from "../helpers/control-plane-db";
import { interceptSql } from "../helpers/sql-faults";
import {
  FOUNDER_TENANT_ID,
  OTHER_TENANT_ID,
  founderTenant,
  insertSecondTenant,
  otherTenant,
} from "../helpers/tenant-fixtures";
import { testReadingsFor } from "../helpers/test-readings";

const NOW_MS = Date.parse("2026-09-03T12:00:00.000Z");
const TENANT = parseTenantId(OTHER_TENANT_ID)!;
const PREFIX = tenantKeyRoot(otherTenant(), true);
const ID_A = "rd_0123456780";
const ID_B = "rd_0123456781";
const PAST_GRACE = NOW_MS - ACCOUNT_WIPE_GRACE_MS;

let queued: AccountWipeEnvelopeV1[] = [];

function installWipeQueue(): void {
  queued = [];
  (env as unknown as { ACCOUNT_WIPE_JOBS: Queue<AccountWipeEnvelopeV1> }).ACCOUNT_WIPE_JOBS = {
    send: vi.fn(async (msg: AccountWipeEnvelopeV1) => {
      queued.push(msg);
    }),
  } as unknown as Queue<AccountWipeEnvelopeV1>;
}

let guardPurges: Array<{ binding: string; body: unknown }> = [];

/**
 * Both usage guards, stubbed for this suite.
 *
 * Teardown purges the tenant's `TenantUsageGuard` and its leases in the
 * singleton `GlobalUsageGuard`. Reaching a real Durable Object from this file
 * makes the workers pool fail to pop its isolated-storage frame, so the guards
 * are stubbed here; their real purge is covered in
 * test/integration/account-deletion-guard-storage.test.ts.
 */
function installUsageGuardStubs(): void {
  guardPurges = [];
  for (const binding of ["TENANT_USAGE_GUARD", "GLOBAL_USAGE_GUARD"] as const) {
    (env as unknown as Record<string, DurableObjectNamespace>)[binding] = {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () =>
        ({
          fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
            const raw = typeof init?.body === "string" ? init.body : "{}";
            guardPurges.push({ binding, body: JSON.parse(raw) as unknown });
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace;
  }
}

const db = () => testControlPlane(env);

async function markDeleting(userId: string, deletingAtMs: number | null): Promise<void> {
  await db().run(
    "UPDATE users SET status = 'deleting', deleting_at = ?, updated_at = ? WHERE id = ?",
    toTimestamp(deletingAtMs),
    toTimestamp(NOW_MS),
    userId,
  );
}

async function readProgress(): Promise<WipeProgress | null> {
  return readWipeProgress(db(), TENANT);
}

// A wipe record as a previous delivery would have left it.
async function seedProgress(partial: Partial<WipeProgress>): Promise<void> {
  const stored = await readWipeProgress(db(), TENANT);
  await new WipeProgressWriter(db(), TENANT, stored).write({ ...emptyWipeProgress(NOW_MS), ...partial });
}

function listItem(id: string): ListIndexItem {
  return {
    id,
    key_prefix: `readings/2026/04/26T200000Z-${id}`,
    url: `https://example.com/${id}`,
    status: "ready",
    created_at: "2026-04-26T20:00:00.000Z",
  };
}

// A tenant's readings as the live system leaves them: rows, with embeddings,
// and their bytes under the tenant's R2 root.
async function seedReadings(ids: string[], tenant = otherTenant()): Promise<void> {
  const readings = testReadingsFor(tenant);
  await readings.seedListItems(ids.map(listItem));
  const root = tenantKeyRoot(tenant, true);
  for (const id of ids) {
    await readings.putEmbedding(id, Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)));
    await env.READINGS_BUCKET.put(`${root}readings/2026/04/26T200000Z-${id}/raw.html`, "bytes");
  }
}

async function readingIds(tenant = otherTenant()): Promise<string[]> {
  return testReadingsFor(tenant).ids();
}

// A relationship refresh checkpoint. It carries a reading id but no foreign
// key to `readings`, so deleting the readings leaves it standing.
async function seedRefreshJob(tenantId: string, readingId: string): Promise<void> {
  await db().run(
    `INSERT INTO relationship_refresh_jobs (tenant_id, reading_id, run_at, owner, source_etag)
       VALUES (?, ?, ?, 'owner', 'etag')`,
    tenantId,
    readingId,
    toTimestamp(NOW_MS),
  );
}

async function refreshJobIds(tenantId: string): Promise<string[]> {
  const rows = await db().all<{ reading_id: string }>(
    "SELECT reading_id FROM relationship_refresh_jobs WHERE tenant_id = ? ORDER BY reading_id",
    tenantId,
  );
  return rows.map((row) => row.reading_id);
}

// An inbox item (db/migrations/0008): Markdown staged under no reading row.
async function seedInboxItem(tenantId: string, id: string): Promise<void> {
  await db().run(
    `INSERT INTO inbox_items (tenant_id, id, url, url_hash, markdown, created_at, updated_at)
       VALUES (?, ?, ?, ?, '# staged', ?, ?)`,
    tenantId,
    id,
    `https://example.com/${id}`,
    await sha256Hex(`https://example.com/${id}`),
    toTimestamp(NOW_MS),
    toTimestamp(NOW_MS),
  );
}

async function inboxItemIds(tenantId: string): Promise<string[]> {
  const rows = await db().all<{ id: string }>(
    "SELECT id FROM inbox_items WHERE tenant_id = ? ORDER BY id",
    tenantId,
  );
  return rows.map((row) => row.id);
}

async function listPrefixKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const list = await env.READINGS_BUCKET.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    keys.push(...list.objects.map((obj) => obj.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return keys;
}

async function emptyPrefix(prefix: string): Promise<void> {
  for (;;) {
    const list = await env.READINGS_BUCKET.list({ prefix, limit: 1000 });
    if (list.objects.length === 0) return;
    await env.READINGS_BUCKET.delete(list.objects.map((obj) => obj.key));
  }
}

// An in-memory R2 prefix, for paging past 1000 objects without writing them.
function memoryBucket(initial: Iterable<string> = []): { bucket: R2Bucket; keysUnder(prefix: string): string[] } {
  const store = new Set(initial);
  const bucket = {
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
    async list(opts: R2ListOptions = {}) {
      const prefix = opts.prefix ?? "";
      const limit = opts.limit ?? 1000;
      const all = [...store].filter((key) => key.startsWith(prefix)).sort();
      const start = opts.cursor ? all.indexOf(opts.cursor) + 1 : 0;
      const page = all.slice(start, start + limit);
      const truncated = start + page.length < all.length;
      return { objects: page.map((key) => ({ key })), truncated, cursor: truncated ? page[page.length - 1] : undefined };
    },
  } as unknown as R2Bucket;
  return { bucket, keysUnder: (prefix) => [...store].filter((key) => key.startsWith(prefix)).sort() };
}

function padKeys(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${PREFIX}pad/${String(i).padStart(6, "0")}`);
}

// Observe (and optionally act) around each R2 call the job makes.
function watchedBucket(
  bucket: R2Bucket,
  hooks: { beforeDelete?: () => Promise<void>; afterList?: () => Promise<void>; clock?: { t: number } },
): R2Bucket {
  return new Proxy(bucket, {
    get(target, prop, receiver) {
      if (prop === "delete") {
        return async (keys: string | string[]) => {
          await hooks.beforeDelete?.();
          return target.delete(keys);
        };
      }
      if (prop === "list") {
        return async (opts?: R2ListOptions) => {
          if (hooks.clock) hooks.clock.t += 10;
          const result = await target.list(opts);
          await hooks.afterList?.();
          return result;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function wipeEnv(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), ...overrides };
}

function wipeDeps(extra: Partial<AccountWipeJobDeps> & { clock?: { t: number } } = {}): AccountWipeJobDeps {
  const clock = extra.clock ?? { t: extra.nowMs ?? NOW_MS };
  return { nowMs: extra.nowMs ?? clock.t, now: () => clock.t, maxObjectPages: extra.maxObjectPages };
}

const envelope = (force = false) => accountWipeEnvelopeV1({ tenantId: TENANT, force });

beforeEach(async () => {
  await insertSecondTenant(env as unknown as Env);
  await emptyPrefix(PREFIX);
  await emptyPrefix(tenantKeyRoot(founderTenant(), true));
  installWipeQueue();
  installUsageGuardStubs();
});

afterEach(() => vi.restoreAllMocks());

describe("account wipe job", () => {
  it("skips a tenant still inside the 7-day grace window", async () => {
    await seedReadings([ID_A]);
    await markDeleting(OTHER_TENANT_ID, NOW_MS);
    expect(await processAccountWipeJob(envelope(), wipeEnv(), wipeDeps())).toEqual({
      kind: "skipped",
      reason: "grace_period",
    });
    expect(await readingIds()).toEqual([ID_A]);
    expect(await listPrefixKeys(PREFIX)).not.toEqual([]);
  });

  it.each([
    ["an active tenant", async (): Promise<void> => undefined, "not_deleting"],
    [
      "a torn-down tenant",
      async (): Promise<void> => {
        await db().run("DELETE FROM users WHERE id = ?", OTHER_TENANT_ID);
      },
      "not_found",
    ],
  ] as const)("skips %s and writes no progress", async (_name, arrange, reason) => {
    await db().batch([
      { sql: "DELETE FROM api_token_scopes WHERE token_id IN (SELECT id FROM api_tokens WHERE user_id = ?)", params: [OTHER_TENANT_ID] },
      { sql: "DELETE FROM api_tokens WHERE user_id = ?", params: [OTHER_TENANT_ID] },
      { sql: "DELETE FROM user_settings WHERE user_id = ?", params: [OTHER_TENANT_ID] },
      { sql: "DELETE FROM tenant_limits WHERE tenant_id = ?", params: [OTHER_TENANT_ID] },
    ]);
    await arrange();
    expect(await processAccountWipeJob(envelope(true), wipeEnv(), wipeDeps())).toEqual({ kind: "skipped", reason });
    expect(await readProgress()).toBeNull();
  });

  // Rows and embeddings before objects: a reading whose bytes outlive its row
  // is invisible, where the reverse is a listed reading whose content 404s.
  it("deletes the tenant's rows and embeddings before any R2 object, then empties the prefix", async () => {
    await seedReadings([ID_A, ID_B]);
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    const rowsAtFirstDelete: string[][] = [];
    const bucket = watchedBucket(env.READINGS_BUCKET, {
      beforeDelete: async () => {
        rowsAtFirstDelete.push(await readingIds());
      },
    });

    const result = await processAccountWipeJob(envelope(), wipeEnv({ READINGS_BUCKET: bucket }), wipeDeps());

    expect(result).toEqual({ kind: "complete", rows_deleted: 2, objects_deleted: 2 });
    expect(rowsAtFirstDelete[0]).toEqual([]);
    expect(await testReadingsFor(otherTenant()).hasEmbedding(ID_A)).toBe(false);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
    const progress = await readProgress();
    expect(progress).toMatchObject({ phase: "done", completedAtMs: NOW_MS, firstCompletedAtMs: NOW_MS, residue: false });
    expect(progress!.r2Cursor).toBeUndefined();
  });

  it("does not touch another tenant's rows or prefix", async () => {
    await seedReadings([ID_A]);
    await seedReadings([ID_A], founderTenant());
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);

    expect((await processAccountWipeJob(envelope(), wipeEnv(), wipeDeps())).kind).toBe("complete");

    expect(await readingIds(founderTenant())).toEqual([ID_A]);
    expect(await listPrefixKeys(tenantKeyRoot(founderTenant(), true))).not.toEqual([]);
  });

  // A database failure blocks the wipe instead of being swallowed: no object
  // goes while the rows it would orphan are still there.
  it("fails closed before touching R2 when the rows cannot be deleted", async () => {
    await seedReadings([ID_A]);
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    interceptSql(/DELETE FROM readings WHERE tenant_id/, () => new Error("database down"));

    await expect(processAccountWipeJob(envelope(), wipeEnv(), wipeDeps())).rejects.toThrow("database down");

    vi.restoreAllMocks();
    expect(await readingIds()).toEqual([ID_A]);
    expect(await listPrefixKeys(PREFIX)).not.toEqual([]);
    expect(await readProgress()).toMatchObject({ phase: "rows", completedAtMs: null });
  });

  // A consumer that passed its tenant check before the fence can commit after
  // the rows phase. Its bytes go with the prefix; its row must not survive.
  it("sweeps a row a late publisher committed during the objects phase", async () => {
    await seedReadings([ID_A]);
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    let published = false;
    const bucket = watchedBucket(env.READINGS_BUCKET, {
      afterList: async () => {
        if (published) return;
        published = true;
        await testReadingsFor(otherTenant()).seedListItems([listItem(ID_B)]);
      },
    });

    const result = await processAccountWipeJob(envelope(), wipeEnv({ READINGS_BUCKET: bucket }), wipeDeps());

    expect(result).toMatchObject({ kind: "complete", rows_deleted: 2 });
    expect(await readingIds()).toEqual([]);
  });

  // `relationship_refresh_jobs` hangs off no reading row, so nothing cascades
  // it away with the readings. A checkpoint left behind cannot spend (the
  // refresh writes require an `active` users row), but the wipe is what
  // removes the account's data, so it clears them itself — per tenant, which
  // is what this pins.
  it("clears the tenant's refresh checkpoints with its rows, and leaves another tenant's alone", async () => {
    await seedReadings([ID_A]);
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    await seedRefreshJob(OTHER_TENANT_ID, ID_A);
    await seedRefreshJob(FOUNDER_TENANT_ID, ID_A);

    expect((await processAccountWipeJob(envelope(), wipeEnv(), wipeDeps())).kind).toBe("complete");

    expect(await refreshJobIds(OTHER_TENANT_ID)).toEqual([]);
    expect(await refreshJobIds(FOUNDER_TENANT_ID)).toEqual([ID_A]);
  });

  // Inbox items hang off no reading row either, and teardown refuses while
  // any stand, so the wipe deletes them with the tenant's readings.
  it("deletes the tenant's inbox items with its rows, and leaves another tenant's alone", async () => {
    await seedReadings([ID_A]);
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    await seedInboxItem(OTHER_TENANT_ID, "in_A");
    await seedInboxItem(OTHER_TENANT_ID, "in_B");
    await seedInboxItem(FOUNDER_TENANT_ID, "in_A");

    const result = await processAccountWipeJob(envelope(), wipeEnv(), wipeDeps());

    // rows_deleted counts reading rows only.
    expect(result).toMatchObject({ kind: "complete", rows_deleted: 1 });
    expect(await inboxItemIds(OTHER_TENANT_ID)).toEqual([]);
    expect(await inboxItemIds(FOUNDER_TENANT_ID)).toEqual(["in_A"]);
  });

  // The rows phase is one transaction: readings, refresh checkpoints, and the
  // phase advance. A sibling that takes the lease over mid-phase makes the
  // closing CAS change no rows, and the deletes must go back with it - the
  // alternative is a tenant's rows deleted under an owner that still believes
  // it is in the `rows` phase, with the CAS having silently done nothing.
  it("rolls the row deletes back when the phase advance loses the lease", async () => {
    await seedReadings([ID_A, ID_B]);
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    await seedRefreshJob(OTHER_TENANT_ID, ID_A);
    // A sibling delivery bumps lease_seq while our transaction holds the
    // deletes but has not yet reached its CAS.
    interceptSql(/DELETE FROM relationship_refresh_jobs/, async () => {
      await db().run("UPDATE wipe_progress SET lease_seq = lease_seq + 1 WHERE tenant_id = ?", TENANT);
      return "pass" as const;
    });

    const result = await processAccountWipeJob(envelope(), wipeEnv(), wipeDeps());

    vi.restoreAllMocks();
    expect(result).toEqual({ kind: "skipped", reason: "lease_held" });
    expect((await readingIds()).sort()).toEqual([ID_A, ID_B]);
    expect(await refreshJobIds(OTHER_TENANT_ID)).toEqual([ID_A]);
    expect(await readProgress()).toMatchObject({ phase: "rows", completedAtMs: null });
  });

  // "Complete" is what teardown hard-deletes the account on, so it has to mean
  // the rows are gone rather than that a DELETE reported a count.
  it("refuses to record a completion while an inbox item survives the sweep", async () => {
    await seedReadings([ID_A]);
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    let staged = false;
    const bucket = watchedBucket(env.READINGS_BUCKET, {
      afterList: async () => {
        if (staged) return;
        staged = true;
        await seedInboxItem(OTHER_TENANT_ID, "in_LATE");
      },
    });
    interceptSql(/DELETE FROM inbox_items WHERE tenant_id/, (call) => (call === 1 ? "pass" : []));

    await expect(
      processAccountWipeJob(envelope(), wipeEnv({ READINGS_BUCKET: bucket }), wipeDeps()),
    ).rejects.toThrow(/rows_remaining/);

    vi.restoreAllMocks();
    expect(await inboxItemIds(OTHER_TENANT_ID)).toEqual(["in_LATE"]);
    expect(await readProgress()).toMatchObject({ phase: "objects", completedAtMs: null });
  });

  it("refuses to record a completion while reading rows survive the sweep", async () => {
    await seedReadings([ID_A]);
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    let published = false;
    const bucket = watchedBucket(env.READINGS_BUCKET, {
      afterList: async () => {
        if (published) return;
        published = true;
        await testReadingsFor(otherTenant()).seedListItems([listItem(ID_B)]);
      },
    });
    // The rows phase deletes for real; the objects-phase sweep is neutered, so
    // the late publisher's row is still there when completion asks.
    interceptSql(/DELETE FROM readings WHERE tenant_id/, (call) =>
      call === 1 ? "pass" : [{ deleted: 0 }],
    );

    await expect(
      processAccountWipeJob(envelope(), wipeEnv({ READINGS_BUCKET: bucket }), wipeDeps()),
    ).rejects.toThrow(/rows_remaining/);

    vi.restoreAllMocks();
    expect(await readingIds()).toEqual([ID_B]);
    // No completion record for teardown to act on; the pass resumes instead.
    expect(await readProgress()).toMatchObject({ phase: "objects", completedAtMs: null });
  });

  it("pages more than 1000 objects and resumes from the stored cursor", async () => {
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    const memory = memoryBucket(padKeys(R2_LIST_LIMIT + 1));
    const jobEnv = wipeEnv({ READINGS_BUCKET: memory.bucket });

    const first = await processAccountWipeJob(envelope(), jobEnv, wipeDeps({ maxObjectPages: 1 }));
    expect(first.kind).toBe("continue");
    const progress = await readProgress();
    expect(progress).toMatchObject({ phase: "objects", continuations: 1 });
    expect(progress!.r2Cursor).toBeTruthy();

    expect((await processAccountWipeJob(envelope(), jobEnv, wipeDeps())).kind).toBe("complete");
    expect(memory.keysUnder(PREFIX)).toEqual([]);
  });

  it("recognises an already-finished wipe from its record and leaves the record as it was", async () => {
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    const first = await processAccountWipeJob(envelope(), wipeEnv(), wipeDeps());
    expect(first).toEqual({ kind: "complete", rows_deleted: 0, objects_deleted: 0 });
    const done = await readProgress();

    const again = await processAccountWipeJob(envelope(), wipeEnv(), wipeDeps({ nowMs: NOW_MS + 60_000 }));
    expect(again).toEqual({ kind: "complete", rows_deleted: 0, objects_deleted: 0 });
    expect(await readProgress()).toEqual(done);
  });

  it("reports lease_held and acks when another delivery owns the wipe", async () => {
    await seedReadings([ID_A]);
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    await seedProgress({ phase: "objects" });
    // A sibling advances the lease after this delivery read the row.
    const bucket = watchedBucket(env.READINGS_BUCKET, {
      afterList: async () => {
        await db().run("UPDATE wipe_progress SET lease_seq = lease_seq + 1 WHERE tenant_id = ?", OTHER_TENANT_ID);
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ack = vi.fn();
    const retry = vi.fn();

    await consumeAccountWipeMessage(
      { body: envelope(), ack, retry, attempts: 1 },
      wipeEnv({ READINGS_BUCKET: bucket }),
      wipeDeps({ maxObjectPages: 1 }),
    );

    // Acked, not retried into the DLQ: the owner is doing the work.
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(await readProgress()).toMatchObject({ completedAtMs: null });
  });

  // A frozen clock only ever costs a duplicate delivery: the lease is a version.
  it("survives a frozen job clock: cron may enqueue, but only one writer wins", async () => {
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    const memory = memoryBucket(padKeys(R2_LIST_LIMIT * 2));
    let cronRun: { enqueued: number } | null = null;
    const bucket = watchedBucket(memory.bucket, {
      afterList: async () => {
        if (cronRun !== null) return;
        cronRun = { enqueued: -1 };
        cronRun = await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS });
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await processAccountWipeJob(
      envelope(),
      wipeEnv({ READINGS_BUCKET: bucket }),
      wipeDeps({ clock: { t: NOW_MS }, maxObjectPages: 1 }),
    );

    expect(cronRun).toEqual({ enqueued: 1 });
    expect(outcome).toEqual({ kind: "skipped", reason: "lease_held" });
    const finished = await processAccountWipeJob(queued[0]!, wipeEnv({ READINGS_BUCKET: memory.bucket }), wipeDeps());
    expect(finished.kind).toBe("complete");
    expect(memory.keysUnder(PREFIX)).toEqual([]);
  });

  it("heartbeats on an interval rather than once per page, and still persists a continue's cursor", async () => {
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    const pages = 6;
    const memory = memoryBucket(padKeys(R2_LIST_LIMIT * pages));
    const clock = { t: NOW_MS };
    const bucket = watchedBucket(memory.bucket, { clock });

    const partial = await processAccountWipeJob(envelope(), wipeEnv({ READINGS_BUCKET: bucket }), wipeDeps({ clock, maxObjectPages: 1 }));
    expect(partial.kind).toBe("continue");
    expect((await readProgress())!.r2Cursor).toBeTruthy();

    const rest = await processAccountWipeJob(envelope(), wipeEnv({ READINGS_BUCKET: bucket }), wipeDeps({ clock }));
    expect(rest.kind).toBe("complete");
    // Every write bumps lease_seq: the claims, the phase transition, the
    // continue and the terminal record, but no per-page beat.
    expect((await readProgress())!.leaseSeq).toBeLessThan(pages);
  });

  // F7: past the continuation bound the job throws instead of self-sending, so
  // the delivery retries and can dead-letter.
  it("stops self-sending once the continuation budget is spent", async () => {
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    const memory = memoryBucket(padKeys(R2_LIST_LIMIT * 2 + 1));
    const jobEnv = wipeEnv({ READINGS_BUCKET: memory.bucket });
    await seedProgress({ phase: "objects", continuations: ACCOUNT_WIPE_MAX_CONTINUATIONS - 1 });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const ack = vi.fn();
    await consumeAccountWipeMessage({ body: envelope(), ack, retry: vi.fn(), attempts: 1 }, jobEnv, wipeDeps({ maxObjectPages: 1 }));
    expect(ack).toHaveBeenCalledOnce();
    expect(queued).toHaveLength(1);

    const ack2 = vi.fn();
    const retry2 = vi.fn();
    await consumeAccountWipeMessage({ body: envelope(), ack: ack2, retry: retry2, attempts: 3 }, jobEnv, wipeDeps({ maxObjectPages: 1 }));
    expect(ack2).not.toHaveBeenCalled();
    expect(retry2).toHaveBeenCalled();
    expect(queued).toHaveLength(1);
  });

  it("retries a failed delivery with a delay and keeps its record to resume from", async () => {
    await seedReadings([ID_A]);
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    interceptSql(/DELETE FROM readings WHERE tenant_id/, () => new Error("database blip"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ack = vi.fn();
    const retry = vi.fn();

    await consumeAccountWipeMessage({ body: envelope(), ack, retry, attempts: 1 }, wipeEnv(), wipeDeps());

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    vi.restoreAllMocks();
    expect(await readProgress()).toMatchObject({ phase: "rows", completedAtMs: null });
  });

  it("queue consumer acks a malformed body without wiping anything", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ack = vi.fn();
    await consumeAccountWipeMessage({ body: { version: 9 }, ack, retry: vi.fn() }, wipeEnv(), wipeDeps());
    expect(ack).toHaveBeenCalledOnce();
  });

  it("wipe DLQ logs and acks without touching the tenant", async () => {
    await seedReadings([ID_A]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ack = vi.fn();
    await handleAccountWipeDeadLetter({ body: envelope(), ack });
    expect(ack).toHaveBeenCalledOnce();
    expect(String(errors.mock.calls[0]?.[0])).toContain("account_wipe_dead_lettered");
    expect(await readingIds()).toEqual([ID_A]);
    expect(await listPrefixKeys(PREFIX)).not.toEqual([]);
  });
});

describe("account wipe fan-out", () => {
  it("enqueues a past-grace deleting tenant once and skips the grace window", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS);
    expect(await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 0 });
    expect(await readProgress()).toBeNull();

    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    expect(await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 1 });
    expect(queued).toEqual([envelope()]);
    // The claim is a live lease: the next tick does not duplicate it.
    expect(await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS + 1 })).toEqual({ enqueued: 0 });
  });

  it("redrives a force wipe that started during grace once its lease lapses, preserving force", async () => {
    await markDeleting(OTHER_TENANT_ID, NOW_MS);
    await seedProgress({ phase: "objects", force: true });
    expect(await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 0 });
    expect(await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS })).toEqual({ enqueued: 1 });
    expect(queued).toEqual([envelope(true)]);
  });

  it("skips entirely when TENANT_DATA_PLANE is off", async () => {
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await fanOutDueAccountWipes(wipeEnv({ TENANT_DATA_PLANE: undefined }), { nowMs: NOW_MS })).toEqual({ enqueued: 0 });
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: "account_wipe_fanout_skipped", reason: "no_tenant_prefix" }));
    expect(await readProgress()).toBeNull();
  });

  it("warns, without starting, when a deleting tenant has no deleting_at", async () => {
    await seedReadings([ID_A]);
    await markDeleting(OTHER_TENANT_ID, null);
    const warned: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warned.push(String(line));
    });

    expect(await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 0 });
    expect(await processAccountWipeJob(envelope(), wipeEnv(), wipeDeps())).toEqual({ kind: "skipped", reason: "grace_period" });

    const alert = warned.find((line) => line.includes(ACCOUNT_WIPE_MISSING_DELETING_AT_EVENT));
    expect(JSON.parse(alert!)).toMatchObject({ tenant_id: OTHER_TENANT_ID });
    expect(await readingIds()).toEqual([ID_A]);
  });

  // Leftover objects reopen a finished wipe as a fresh pass from `rows`, with a
  // fresh continuation budget, while the first completion survives as history.
  it("reopens a finished wipe when objects turn up, keeping the first completion", async () => {
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    await seedProgress({
      phase: "done",
      completedAtMs: NOW_MS - 60_000,
      firstCompletedAtMs: NOW_MS - 60_000,
      continuations: ACCOUNT_WIPE_MAX_CONTINUATIONS,
    });
    await seedReadings([ID_B]);

    expect(await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 1 });
    expect(await readProgress()).toMatchObject({
      phase: "rows",
      completedAtMs: null,
      continuations: 0,
      firstCompletedAtMs: NOW_MS - 60_000,
    });

    expect((await processAccountWipeJob(queued[0]!, wipeEnv(), wipeDeps())).kind).toBe("complete");
    expect(await readingIds()).toEqual([]);
    expect(await listPrefixKeys(PREFIX)).toEqual([]);
  });

  it("scheduled() still fans out wipes when digest fan-out throws", async () => {
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const digestBomb = new Proxy(env as object, {
      get(target, prop, receiver) {
        if (prop === "DIGEST_JOBS") throw new Error("digest boom");
        return Reflect.get(target, prop, receiver);
      },
    }) as Env;
    await worker.scheduled({ scheduledTime: NOW_MS, cron: "*/15 * * * *" } as ScheduledController, digestBomb);
    expect(queued).toEqual([envelope()]);
  });
});

describe("account teardown from cron fan-out (195 S4)", () => {
  async function countRows(table: string, column: string, value: string): Promise<number> {
    const row = await db().first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, value);
    return row?.n ?? 0;
  }

  async function completedWipe(): Promise<void> {
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    await seedProgress({ phase: "done", completedAtMs: NOW_MS, firstCompletedAtMs: NOW_MS });
  }

  it("tears the account down instead of enqueuing another wipe, and frees the address", async () => {
    await completedWipe();
    expect((await resolveLoginEligibility(db(), "other@test.example", NOW_MS)).kind).toBe("ineligible");

    expect(await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS + 1 })).toEqual({ enqueued: 0 });

    expect(queued).toEqual([]);
    expect(await countRows("users", "id", OTHER_TENANT_ID)).toBe(0);
    expect(await countRows("account_deletions", "tenant_id", OTHER_TENANT_ID)).toBe(1);
    expect(guardPurges.map((purge) => purge.binding).sort()).toEqual(["GLOBAL_USAGE_GUARD", "TENANT_USAGE_GUARD"]);
    expect((await resolveLoginEligibility(db(), "other@test.example", NOW_MS)).kind).toBe("provisionable");

    // F10: gone from `users`, so later ticks never enumerate it again.
    expect(await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS + 60_000 })).toEqual({ enqueued: 0 });
  });

  it("reopens the wipe rather than tearing down when objects are left under the prefix", async () => {
    await completedWipe();
    await env.READINGS_BUCKET.put(`${PREFIX}readings/late/raw.html`, "late");

    expect(await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS + 1 })).toEqual({ enqueued: 1 });

    expect(await countRows("users", "id", OTHER_TENANT_ID)).toBe(1);
    expect(await countRows("account_deletions", "tenant_id", OTHER_TENANT_ID)).toBe(0);
    expect((await readProgress())!.completedAtMs).toBeNull();
  });

  it.each([
    ["still in flight", { phase: "objects" as const, completedAtMs: null }],
    ["completed once and reopened", { phase: "rows" as const, completedAtMs: null, firstCompletedAtMs: NOW_MS - 60_000 }],
  ])("does not tear down a wipe that is %s", async (_name, progress) => {
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    await seedProgress(progress);

    await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS });

    expect(await countRows("users", "id", OTHER_TENANT_ID)).toBe(1);
    expect(await countRows("account_deletions", "tenant_id", OTHER_TENANT_ID)).toBe(0);
  });

  // A wipe redelivered after teardown must not recreate a progress row for an
  // account that is gone: it would sit unfinished forever, enumerated by
  // nothing.
  // A writer that got past the fence can leave a reading row without leaving
  // an object — its bytes were swept with the prefix, or it never wrote any.
  // Teardown refuses such a tenant (`rows_remain`) and nothing else deletes
  // the row, so if only objects reopened the wipe this tenant would be handed
  // to teardown, refused, and handed back on every tick forever.
  it.each([
    ["reading row", () => testReadingsFor(otherTenant()).seedListItems([listItem(ID_B)])],
    ["inbox item", () => seedInboxItem(OTHER_TENANT_ID, "in_LEFTOVER")],
  ] as const)("reopens the wipe for a leftover %s even when the prefix is clean", async (_label, seedLeftover) => {
    await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
    await seedProgress({ phase: "done", completedAtMs: NOW_MS, firstCompletedAtMs: NOW_MS });
    // A row with no objects under the tenant root.
    await seedLeftover();
    expect(await listPrefixKeys(PREFIX)).toEqual([]);

    await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS });

    // Reopened rather than torn down: the record is live again and a delivery
    // is queued to clear the row.
    expect(queued).toHaveLength(1);
    const reopened = await readProgress();
    expect(reopened).toMatchObject({ phase: "rows", completedAtMs: null, firstCompletedAtMs: NOW_MS });

    expect((await processAccountWipeJob(envelope(), wipeEnv(), wipeDeps())).kind).toBe("complete");
    expect(await readingIds()).toEqual([]);
    expect(await inboxItemIds(OTHER_TENANT_ID)).toEqual([]);
  });

  it("refuses to recreate a progress row for a torn-down tenant", async () => {
    await completedWipe();
    await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS + 1 });
    expect(await countRows("users", "id", OTHER_TENANT_ID)).toBe(0);

    await expect(new WipeProgressWriter(db(), TENANT, null).write(emptyWipeProgress(NOW_MS))).rejects.toThrow(
      /progress_conflict/,
    );
    expect(await countRows("wipe_progress", "tenant_id", OTHER_TENANT_ID)).toBe(0);
  });
});

describe("account wipe and archive export (reading-lite-mxwx.4)", () => {
  const EXPORT_ID = "exp_00000000-0000-4000-8000-0000000000cc";

  // An export delivery that passed its status checks before the fence can
  // still write its segment after the wipe's objects phase. Once its commit
  // loses to the cancel it deletes those parts itself; when that delete fails
  // too, the late parts reopen the wipe, the tenant prefix still ends empty,
  // and teardown takes the export row with the account.
  it("reopens for an export segment written after the objects phase and ends with an empty prefix", async () => {
    await seedReadings([ID_A]);
    await db().run(
      `INSERT INTO archive_exports (id, tenant_id, status, requested_at, updated_at)
       VALUES (?, ?, 'queued', ?, ?)`,
      EXPORT_ID,
      OTHER_TENANT_ID,
      toTimestamp(NOW_MS),
      toTimestamp(NOW_MS),
    );
    const bucket = env.READINGS_BUCKET;
    const put = bucket.put.bind(bucket);
    let raced = false;
    vi.spyOn(bucket, "put").mockImplementation(async (key, value, options) => {
      if (!raced && key.includes("/exports/")) {
        raced = true;
        expect(await beginAccountDeletion(db(), { userId: OTHER_TENANT_ID, nowMs: NOW_MS })).toEqual({ kind: "started" });
        await markDeleting(OTHER_TENANT_ID, PAST_GRACE);
        expect(await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS })).toEqual({ enqueued: 1 });
        expect((await processAccountWipeJob(queued[0]!, wipeEnv(), wipeDeps())).kind).toBe("complete");
        expect(await listPrefixKeys(PREFIX)).toEqual([]);
      }
      return put(key, value, options);
    });
    const del = bucket.delete.bind(bucket);
    const deleteExportParts = vi.spyOn(bucket, "delete").mockImplementation(async (keys) => {
      if ([keys].flat().some((key) => key.includes("/exports/"))) throw new Error("R2 delete failed");
      return del(keys);
    });
    const sql = sqlSessionFor(env);
    try {
      // Deletion cancelled the row, so the cursor commit loses, and the
      // delivery's own delete of what it wrote fails.
      await expect(
        buildArchiveExport(sql, archiveExportEnvelopeV1({ tenantId: TENANT, exportId: EXPORT_ID }), wipeEnv(), {
          nowMs: NOW_MS,
        }),
      ).rejects.toThrow("R2 delete failed");
    } finally {
      await sql.end();
    }
    vi.mocked(bucket.put).mockRestore();
    expect(deleteExportParts).toHaveBeenCalled();
    deleteExportParts.mockRestore();
    expect(raced).toBe(true);
    expect(await listPrefixKeys(`${PREFIX}exports/`)).not.toEqual([]);

    expect(await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS + 1 })).toEqual({ enqueued: 1 });
    expect((await processAccountWipeJob(queued[1]!, wipeEnv(), wipeDeps())).kind).toBe("complete");
    expect(await listPrefixKeys(PREFIX)).toEqual([]);

    await fanOutDueAccountWipes(wipeEnv(), { nowMs: NOW_MS + 2 });
    for (const [table, column] of [
      ["users", "id"],
      ["archive_exports", "tenant_id"],
    ] as const) {
      const row = await db().first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, OTHER_TENANT_ID);
      expect(row?.n, table).toBe(0);
    }
  });
});
