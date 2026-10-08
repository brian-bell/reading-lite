// Deletion and queue-routing guards, on workerd against real PostgreSQL and R2.
//
// The account wipe removes one tenant's rows before any of its objects and
// leaves every other tenant whole; the founder gets no exemption. Jobs saved
// before a hard teardown replay into nothing: no row recreated, no provider
// called. Queue admission and each dead-letter queue act only on the tenant
// the envelope admits, and only the reading DLQ touches reading state. See
// AGENTS.md ("rows before objects", queue rules) and
// docs/operations.md#account-deletion.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_WIPE_GRACE_MS, processAccountWipeJob } from "../../src/account-wipe";
import { tearDownAccount } from "../../src/control-plane/account-teardown";
import { digestEnvelopeV1 } from "../../src/control-plane/digest-envelope";
import { claimPendingDigestDelivery, getDigestDelivery } from "../../src/control-plane/digest-ledger";
import { admitProcessReadingEnvelope, type ProcessReadingEnvelopeV1 } from "../../src/control-plane/envelope";
import { archiveExportEnvelopeV1 } from "../../src/control-plane/export-envelope";
import { parseUserId, type TenantContext } from "../../src/control-plane/ids";
import { toTimestamp } from "../../src/control-plane/pg-time";
import { accountWipeEnvelopeV1 } from "../../src/control-plane/wipe-envelope";
import { readWipeProgress } from "../../src/control-plane/wipe-progress";
import worker, { type Env } from "../../src/index";
import { buildKeyPrefix } from "../../src/modules/stores/layout";
import { tenantKeyRoot } from "../../src/modules/stores/tenant-root";
import type { ListIndexItem } from "../../src/schemas/api";
import type { Manifest } from "../../src/schemas/manifest";
import { sha256Hex } from "../../src/services";
import { testControlPlane } from "../helpers/control-plane-db";
import { interceptSql } from "../helpers/sql-faults";
import {
  FOUNDER_TENANT_ID,
  OTHER_TENANT_ID,
  OTHER_TOKEN_ID,
  founderTenant,
  insertSecondTenant,
  otherTenant,
} from "../helpers/tenant-fixtures";
import { testReadingsFor } from "../helpers/test-readings";

const NOW_MS = Date.parse("2026-09-03T12:00:00.000Z");
const ID_A = "rd_0123456780";
const ID_B = "rd_0123456781";
const ID_C = "rd_0123456782";
const PERIOD = "2026-09-03";

const db = () => testControlPlane(env);
const rootOf = (tenant: TenantContext) => tenantKeyRoot(tenant, true);

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

async function markDeleting(userId: string, deletingAtMs: number): Promise<void> {
  await db().run(
    "UPDATE users SET status = 'deleting', deleting_at = ?, updated_at = ? WHERE id = ?",
    toTimestamp(deletingAtMs),
    toTimestamp(deletingAtMs),
    userId,
  );
}

async function seedPendingDigest(userId: string): Promise<void> {
  await db().run("UPDATE user_settings SET digest_cadence = 'daily', time_zone = 'UTC' WHERE user_id = ?", userId);
  const key = { userId, cadence: "daily" as const, periodKey: PERIOD };
  expect(await claimPendingDigestDelivery(db(), key, NOW_MS), `${userId} digest pending`).toBe("inserted");
}

async function digestStatus(userId: string): Promise<string | undefined> {
  return (await getDigestDelivery(db(), { userId, cadence: "daily", periodKey: PERIOD }))?.status;
}

function digestEnvelope(tenant: TenantContext) {
  return digestEnvelopeV1({
    tenantId: tenant.tenantId,
    userId: parseUserId(String(tenant.tenantId))!,
    cadence: "daily",
    period_key: PERIOD,
  });
}

function queueMessage(body: unknown) {
  return { id: "m_guard", timestamp: new Date(NOW_MS), attempts: 4, body, ack: vi.fn(), retry: vi.fn() };
}

async function dispatch(queue: string, body: unknown): Promise<ReturnType<typeof queueMessage>> {
  const msg = queueMessage(body);
  await worker.queue({ queue, messages: [msg] } as unknown as MessageBatch<unknown>, env as unknown as Env);
  return msg;
}

beforeEach(async () => {
  await insertSecondTenant(env as unknown as Env);
});

afterEach(() => vi.restoreAllMocks());

describe("account wipe", () => {
  function listItem(id: string): ListIndexItem {
    return {
      id,
      key_prefix: `readings/2026/04/26T200000Z-${id}`,
      url: `https://example.com/${id}`,
      status: "ready",
      created_at: "2026-04-26T20:00:00.000Z",
    };
  }

  // What the live system leaves a tenant: ready readings with embeddings and
  // bytes, a staged inbox item, and refresh and tension checkpoints. The last
  // three name no reading row, so nothing cascades them away.
  async function seedTenantData(tenant: TenantContext): Promise<void> {
    const tenantId = String(tenant.tenantId);
    const readings = testReadingsFor(tenant);
    await readings.seedListItems([listItem(ID_A), listItem(ID_B)]);
    for (const id of [ID_A, ID_B]) {
      await readings.putEmbedding(id, Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)));
      await env.READINGS_BUCKET.put(`${rootOf(tenant)}${listItem(id).key_prefix}/raw.html`, "bytes");
    }
    const url = "https://example.com/in_A";
    await db().run(
      `INSERT INTO inbox_items (tenant_id, id, url, url_hash, markdown, created_at, updated_at)
       VALUES (?, 'in_A', ?, ?, '# staged', ?, ?)`,
      tenantId, url, await sha256Hex(url), toTimestamp(NOW_MS), toTimestamp(NOW_MS),
    );
    await db().run(
      `INSERT INTO relationship_refresh_jobs (tenant_id, reading_id, run_at, owner, source_etag)
       VALUES (?, ?, ?, 'owner', 'etag')`,
      tenantId, ID_A, toTimestamp(NOW_MS),
    );
    await db().run(
      `INSERT INTO tension_refresh_jobs (tenant_id, reading_a, reading_b, run_at, owner, a_version, b_version)
       VALUES (?, ?, ?, ?, 'owner', 'va', 'vb')`,
      tenantId, ID_A, ID_B, toTimestamp(NOW_MS),
    );
  }

  async function tenantData(tenant: TenantContext) {
    const ids = async (sql: string) =>
      (await db().all<{ id: string }>(sql, String(tenant.tenantId))).map((row) => row.id);
    return {
      readings: await ids("SELECT id FROM readings WHERE tenant_id = ? ORDER BY id"),
      embeddings: await ids("SELECT reading_id AS id FROM reading_embeddings WHERE tenant_id = ? ORDER BY 1"),
      inbox: await ids("SELECT id FROM inbox_items WHERE tenant_id = ? ORDER BY id"),
      refresh: await ids("SELECT reading_id AS id FROM relationship_refresh_jobs WHERE tenant_id = ? ORDER BY 1"),
      tension: await ids(
        "SELECT reading_a || '|' || reading_b AS id FROM tension_refresh_jobs WHERE tenant_id = ? ORDER BY 1",
      ),
      objects: (await listPrefixKeys(rootOf(tenant))).length,
    };
  }

  const SEEDED = {
    readings: [ID_A, ID_B],
    embeddings: [ID_A, ID_B],
    inbox: ["in_A"],
    refresh: [ID_A],
    tension: [`${ID_A}|${ID_B}`],
    objects: 2,
  };
  const GONE = { readings: [], embeddings: [], inbox: [], refresh: [], tension: [], objects: 0 };
  const COMPLETE = { kind: "complete", rows_deleted: 2, objects_deleted: 2 };

  // Watches the R2 list and delete calls the wipe makes.
  function watchedBucket(hooks: { beforeDelete: () => Promise<void>; afterList?: () => Promise<void> }): R2Bucket {
    const bucket = env.READINGS_BUCKET;
    return new Proxy(bucket, {
      get(target, prop, receiver) {
        if (prop === "delete") {
          return async (keys: string | string[]) => {
            await hooks.beforeDelete();
            return target.delete(keys);
          };
        }
        if (prop === "list") {
          return async (opts?: R2ListOptions) => {
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

  const WIPE_ROWS: Array<{
    name: string;
    target: "founder" | "other";
    arrange?: (victim: TenantContext) => { afterList?: () => Promise<void> };
    expected: {
      outcome: typeof COMPLETE | RegExp;
      // The victim's reading ids when the first R2 delete ran; undefined if none ran.
      readingsAtFirstR2Delete: string[] | undefined;
      victim: typeof SEEDED | typeof GONE | Record<string, unknown>;
      progress: { phase: string; completedAtMs: number | null };
    };
  }> = [
    {
      // Rows before objects: bytes that outlive their row are invisible, where
      // a row that outlives its bytes is a listed reading whose content 404s.
      name: "wipes the second tenant's rows before its objects and leaves the founder whole",
      target: "other",
      expected: {
        outcome: COMPLETE,
        readingsAtFirstR2Delete: [],
        victim: GONE,
        progress: { phase: "done", completedAtMs: NOW_MS },
      },
    },
    {
      // No tenant, founders included, is exempt from deletion.
      name: "wipes the founder the same way and leaves the second tenant whole",
      target: "founder",
      expected: {
        outcome: COMPLETE,
        readingsAtFirstR2Delete: [],
        victim: GONE,
        progress: { phase: "done", completedAtMs: NOW_MS },
      },
    },
    {
      // A database error fails closed: no object goes while the rows it would
      // orphan are still there.
      name: "fails before touching R2 when the rows cannot be deleted",
      target: "other",
      arrange: () => {
        interceptSql(/DELETE FROM readings WHERE tenant_id/, () => new Error("database down"));
        return {};
      },
      expected: {
        outcome: /database down/,
        readingsAtFirstR2Delete: undefined,
        victim: SEEDED,
        progress: { phase: "rows", completedAtMs: null },
      },
    },
    {
      // Completion is what teardown hard-deletes the account on, so a row a
      // late publisher committed, and the closing sweep missed, refuses it.
      name: "refuses to record completion while a reading row survives the sweep",
      target: "other",
      arrange: (victim) => {
        interceptSql(/DELETE FROM readings WHERE tenant_id/, (call) => (call === 1 ? "pass" : [{ deleted: 0 }]));
        let published = false;
        return {
          afterList: async () => {
            if (published) return;
            published = true;
            await testReadingsFor(victim).seedListItems([listItem(ID_C)]);
          },
        };
      },
      expected: {
        outcome: /rows_remaining/,
        // Only the late row: the rows phase's own were already gone.
        readingsAtFirstR2Delete: [ID_C],
        victim: { ...GONE, readings: [ID_C] },
        progress: { phase: "objects", completedAtMs: null },
      },
    },
  ];

  // "%s" rather than "$name", which truncates the name in the runner's output.
  it.each(WIPE_ROWS.map((row) => [row.name, row] as const))("%s", async (_name, { target, arrange, expected }) => {
    const [victim, neighbour] = target === "founder" ? [founderTenant(), otherTenant()] : [otherTenant(), founderTenant()];
    await seedTenantData(victim);
    await seedTenantData(neighbour);
    await markDeleting(String(victim.tenantId), NOW_MS - ACCOUNT_WIPE_GRACE_MS);
    const hooks = arrange?.(victim) ?? {};
    let readingsAtFirstR2Delete: string[] | undefined;
    const bucket = watchedBucket({
      beforeDelete: async () => {
        readingsAtFirstR2Delete ??= await testReadingsFor(victim).ids();
      },
      afterList: hooks.afterList,
    });

    const outcome = await processAccountWipeJob(
      accountWipeEnvelopeV1({ tenantId: victim.tenantId, force: false }),
      { ...(env as unknown as Env), READINGS_BUCKET: bucket },
      { nowMs: NOW_MS, now: () => NOW_MS },
    ).catch((error: unknown) => error);
    vi.restoreAllMocks();

    if (expected.outcome instanceof RegExp) {
      expect(outcome instanceof Error ? outcome.message : JSON.stringify(outcome), "wipe rejects").toMatch(
        expected.outcome,
      );
    }
    else expect(outcome, "wipe result").toEqual(expected.outcome);
    expect(readingsAtFirstR2Delete, "victim's reading rows at the first R2 delete").toEqual(
      expected.readingsAtFirstR2Delete,
    );
    expect(await tenantData(victim), "victim's data").toEqual(expected.victim);
    expect(await readWipeProgress(db(), victim.tenantId), "victim's wipe progress").toMatchObject(expected.progress);
    expect(await tenantData(neighbour), "neighbour's data").toEqual(SEEDED);
    expect(await readWipeProgress(db(), neighbour.tenantId), "neighbour's wipe progress").toBeNull();
  });
});

// Shared by the replay and routing tests: one reading id and key prefix, as
// each tenant's queue envelopes would carry it.
const READING_ID = ID_A;
const CREATED_AT = "2026-05-07T12:00:00.000Z";
const KEY_PREFIX = buildKeyPrefix(READING_ID, CREATED_AT);
const URL = "https://example.com/dlq";
const ATTEMPT_ID = `at_${READING_ID}`;
const FOUNDER_TOKEN_ID = "tok_550e8400-e29b-41d4-a716-446655440000";

async function job() {
  return {
    id: READING_ID,
    url: URL,
    urlHash: await sha256Hex(URL),
    createdAt: CREATED_AT,
    keyPrefix: KEY_PREFIX,
    trigger: "reprocess" as const,
  };
}

async function readingEnvelope(claimed: TenantContext, tokenId: string): Promise<ProcessReadingEnvelopeV1> {
  return { version: 1, tenant: claimed, actor: { kind: "api_token", credentialId: tokenId }, job: await job() };
}

describe("saved jobs after hard teardown", () => {
  const PREFIX = rootOf(otherTenant());
  const NEIGHBOR_KEY = `${rootOf(founderTenant())}queue-control.txt`;

  // Guard internals have their own suite; teardown only needs a purge reply.
  const purgeNamespace = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ ok: true }) }),
  } as unknown as DurableObjectNamespace;

  // A completed wipe (rows and objects gone, progress done), then the real
  // control-plane teardown.
  async function tearDown(): Promise<void> {
    for (const key of await listPrefixKeys(PREFIX)) await env.READINGS_BUCKET.delete(key);
    await db().run("DELETE FROM readings WHERE tenant_id = ?", OTHER_TENANT_ID);
    await markDeleting(OTHER_TENANT_ID, NOW_MS - ACCOUNT_WIPE_GRACE_MS - 60_000);
    await db().run(
      `INSERT INTO wipe_progress (tenant_id, phase, updated_at, completed_at, first_completed_at)
       VALUES (?, 'done', ?, ?, ?)`,
      OTHER_TENANT_ID, toTimestamp(NOW_MS), toTimestamp(NOW_MS), toTimestamp(NOW_MS),
    );
    const result = await tearDownAccount(
      db(),
      { TENANT_USAGE_GUARD: purgeNamespace, GLOBAL_USAGE_GUARD: purgeNamespace },
      {
        tenantId: OTHER_TENANT_ID,
        nowMs: NOW_MS,
        prefixVerdict: async () => ((await listPrefixKeys(PREFIX)).length === 0 ? "empty" : "not_empty"),
      },
    );
    expect(result.kind, "teardown").toBe("torn_down");
  }

  async function expectNoTenantState(label: string): Promise<void> {
    expect(await db().first("SELECT id FROM users WHERE id = ?", OTHER_TENANT_ID), `${label}: user`).toBeNull();
    expect(await db().all("SELECT * FROM api_token_scopes WHERE token_id = ?", OTHER_TOKEN_ID), `${label}: token scopes`)
      .toEqual([]);
    expect(await db().all("SELECT * FROM digest_deliveries WHERE user_id = ?", OTHER_TENANT_ID), `${label}: digests`)
      .toEqual([]);
    expect(await db().all("SELECT * FROM wipe_progress WHERE tenant_id = ?", OTHER_TENANT_ID), `${label}: wipe progress`)
      .toEqual([]);
    expect(await db().all("SELECT id FROM readings WHERE tenant_id = ?", OTHER_TENANT_ID), `${label}: readings`)
      .toEqual([]);
    expect(
      await db().first("SELECT tenant_id FROM account_deletions WHERE tenant_id = ?", OTHER_TENANT_ID),
      `${label}: audit row`,
    ).toEqual({ tenant_id: OTHER_TENANT_ID });
    expect(await listPrefixKeys(PREFIX), `${label}: prefix`).toEqual([]);
    expect(await (await env.READINGS_BUCKET.get(NEIGHBOR_KEY))?.text(), `${label}: neighbour key`).toBe("neighbor stays");
  }

  it("acks or retries every queue without recreating tenant state or calling a provider", async () => {
    await env.READINGS_BUCKET.put(NEIGHBOR_KEY, "neighbor stays");
    const reading = await readingEnvelope(otherTenant(), OTHER_TOKEN_ID);
    // Positive control: the saved envelope was admissible while its owner existed.
    expect(await admitProcessReadingEnvelope(db(), reading, Date.now()), "admissible before teardown").toEqual({
      ok: true,
      tenant: otherTenant(),
    });
    const wipe = accountWipeEnvelopeV1({ tenantId: otherTenant().tenantId, force: false });
    await seedPendingDigest(OTHER_TENANT_ID);
    const digest = digestEnvelope(otherTenant());
    await env.READINGS_BUCKET.put(`${PREFIX}${KEY_PREFIX}/raw.md`, "Private fixture content");
    await tearDown();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected upstream call"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [queue, body, settles, logs] of [
      ["reading-lite", reading, "ack", null],
      ["reading-lite-dlq", reading, "ack", null],
      ["reading-lite-wipe", wipe, "ack", null],
      ["reading-lite-wipe-dlq", wipe, "ack", /account_wipe_dead_lettered/],
      // The skipped-ledger write meets the foreign key to the deleted user:
      // the delivery retries rather than sending or recreating the row.
      ["reading-lite-digest", digest, "retry", null],
      ["reading-lite-digest-dlq", digest, "ack", /violates foreign key constraint/],
    ] as const) {
      errors.mockClear();
      const msg = await dispatch(queue, body);
      expect(msg.ack, `${queue} acks`).toHaveBeenCalledTimes(settles === "ack" ? 1 : 0);
      if (settles === "retry") expect(msg.retry, `${queue} retries without delay`).toHaveBeenCalledWith();
      else expect(msg.retry, `${queue} does not retry`).not.toHaveBeenCalled();
      const logged = errors.mock.calls.flat().map(String).join("\n");
      if (logs) expect(logged, `${queue} logs`).toMatch(logs);
      else expect(logged, `${queue} logs nothing`).toBe("");
      await expectNoTenantState(queue);
    }
    expect(fetchSpy, "provider or mail calls").not.toHaveBeenCalled();
  });
});

describe("queue admission and dead-letter routing", () => {
  const EXPORT_ID = "exp_550e8400-e29b-41d4-a716-446655440000";
  const EXPORT_PART = `exports/${EXPORT_ID}/segment-0001`;

  // The same reading id and key prefix, pending with a queued job, in both
  // tenants; only the title tells them apart.
  async function seedPending(tenant: TenantContext, title: string): Promise<void> {
    const readings = testReadingsFor(tenant);
    const manifest: Manifest = {
      id: READING_ID,
      url: URL,
      url_hash: await sha256Hex(URL),
      source_type: "url",
      status: "pending",
      title,
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      active_attempt: { id: ATTEMPT_ID, trigger: "reprocess", status: "running", stage: "queued", started_at: CREATED_AT },
    };
    const claimed = await readings.writer.claimUrl(manifest, KEY_PREFIX, {
      summary: manifest.active_attempt!,
      payload: await readingEnvelope(tenant, FOUNDER_TOKEN_ID),
    });
    expect(claimed, `${title} claimed`).toEqual({ kind: "claimed" });
    await readings.content.put(`${KEY_PREFIX}/raw.html`, "bytes", "text/html");
  }

  async function readingState(tenant: TenantContext) {
    const readings = testReadingsFor(tenant);
    const manifest = await readings.manifest(READING_ID);
    return {
      status: manifest?.status,
      title: manifest?.title,
      job: await readings.jobState(READING_ID, ATTEMPT_ID),
      objects: (await listPrefixKeys(`${rootOf(tenant)}${KEY_PREFIX}/`)).length,
    };
  }

  const pending = (title: string) => ({ status: "pending", title, job: "queued", objects: 1 });

  const ROUTING_ROWS: Array<{
    name: string;
    queue: string;
    arrange?: () => Promise<void>;
    body: () => Promise<unknown>;
    logs?: RegExp;
    other?: Partial<ReturnType<typeof pending>>;
    then?: () => Promise<void>;
  }> = [
    {
      // The only owner of "Reading queue admission" in the isolation matrix.
      name: "reading queue acks an envelope claiming the founder with the second tenant's token",
      queue: "reading-lite",
      body: () => readingEnvelope(founderTenant(), OTHER_TOKEN_ID),
    },
    {
      // Only the reading DLQ marks a job dead.
      name: "reading DLQ fails only the admitted tenant's reading of a shared id",
      queue: "reading-lite-dlq",
      body: () => readingEnvelope(otherTenant(), OTHER_TOKEN_ID),
      // The failed placeholder carries no title of its own.
      other: { status: "failed", title: undefined, job: "dead" },
    },
    {
      name: "digest DLQ fails only its tenant's ledger row",
      queue: "reading-lite-digest-dlq",
      arrange: async () => {
        await seedPendingDigest(OTHER_TENANT_ID);
        await seedPendingDigest(FOUNDER_TENANT_ID);
      },
      body: async () => digestEnvelope(otherTenant()),
      then: async () => {
        expect(await digestStatus(OTHER_TENANT_ID), "second tenant's digest").toBe("failed");
        expect(await digestStatus(FOUNDER_TENANT_ID), "founder's digest").toBe("pending");
      },
    },
    {
      // The tenant is due a wipe, so a DLQ that fell through to the wipe
      // consumer would empty it.
      name: "wipe DLQ logs and acks without wiping a tenant past grace",
      queue: "reading-lite-wipe-dlq",
      arrange: () => markDeleting(OTHER_TENANT_ID, Date.now() - ACCOUNT_WIPE_GRACE_MS - 60_000),
      body: async () => accountWipeEnvelopeV1({ tenantId: otherTenant().tenantId, force: false }),
      logs: /account_wipe_dead_lettered/,
      then: async () => {
        expect(await readWipeProgress(db(), otherTenant().tenantId), "wipe progress").toBeNull();
      },
    },
    {
      name: "export DLQ fails the export and deletes only its tenant's parts",
      queue: "reading-lite-export-dlq",
      arrange: async () => {
        await db().run(
          `INSERT INTO archive_exports (id, tenant_id, status, requested_at, started_at, updated_at)
           VALUES (?, ?, 'building', ?, ?, ?)`,
          EXPORT_ID, OTHER_TENANT_ID, toTimestamp(NOW_MS), toTimestamp(NOW_MS), toTimestamp(NOW_MS),
        );
        for (const tenant of [otherTenant(), founderTenant()]) {
          await env.READINGS_BUCKET.put(`${rootOf(tenant)}${EXPORT_PART}`, "part");
        }
      },
      body: async () => archiveExportEnvelopeV1({ tenantId: otherTenant().tenantId, exportId: EXPORT_ID }),
      then: async () => {
        const row = await db().first<{ status: string }>("SELECT status FROM archive_exports WHERE id = ?", EXPORT_ID);
        expect(row?.status, "export status").toBe("failed");
        expect(await listPrefixKeys(`${rootOf(otherTenant())}exports/`), "second tenant's parts").toEqual([]);
        expect(await listPrefixKeys(`${rootOf(founderTenant())}exports/`), "founder's same-path part").toEqual([
          `${rootOf(founderTenant())}${EXPORT_PART}`,
        ]);
      },
    },
  ];

  it.each(ROUTING_ROWS.map((row) => [row.name, row] as const))("%s", async (_name, row) => {
    const { queue, arrange, body, logs, other, then } = row;
    await seedPending(founderTenant(), "founder pending");
    await seedPending(otherTenant(), "other pending");
    await arrange?.();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected upstream call"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const msg = await dispatch(queue, await body());

    expect(msg.ack, "acked").toHaveBeenCalledOnce();
    expect(msg.retry, "not retried").not.toHaveBeenCalled();
    expect(fetchSpy, "provider calls").not.toHaveBeenCalled();
    expect(await readingState(founderTenant()), "founder's reading").toEqual(pending("founder pending"));
    expect(await readingState(otherTenant()), "second tenant's reading").toEqual({
      ...pending("other pending"),
      ...other,
    });
    if (logs) expect(errors.mock.calls.flat().map(String).join("\n"), "logged").toMatch(logs);
    await then?.();
  });
});
