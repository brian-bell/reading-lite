import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_RATE_EMAIL_WINDOW_MS,
  AUTH_RATE_GLOBAL_WINDOW_MS,
  AUTH_RATE_GUARD_NAME,
  AUTH_RATE_IP_WINDOW_MS,
  GLOBAL_USAGE_GUARD_NAME,
  INGRESS_REQUEST_WINDOW_MS,
} from "../../src/control-plane/constants";
import { tearDownAccount } from "../../src/control-plane/account-teardown";
import { fromD1 } from "../../src/control-plane/db";
import { globalUsageFor, purgeGlobalUsageLeases } from "../../src/control-plane/global-usage-guard";
import { leaseStorageKey } from "../../src/control-plane/processing-lease-state";
import { purgeTenantUsageGuard, tenantUsageFor } from "../../src/control-plane/tenant-usage-guard";
import { FOUNDER_TENANT_ID, insertSecondTenant, OTHER_TENANT_ID } from "../helpers/tenant-fixtures";

// These are deliberately fixture-only direct reads of the *real* SQLite DO
// storage. They exercise the existing HTTP purge verbs, then inspect the
// runtime state which account teardown otherwise cannot read. This is local
// workerd evidence, not an observation of a deployed DO namespace.
const NOW_MS = Date.parse("2026-09-05T12:00:00.000Z");
const OTHER_ATTEMPT = "attempt-deleted";
const PAUSED_ATTEMPT = "attempt-paused";
const NEIGHBOUR_ATTEMPT = "attempt-neighbour";

async function storageSnapshot(stub: DurableObjectStub): Promise<{ keys: string[]; alarm: number | null }> {
  return runInDurableObject(stub, async (_instance, state) => ({
    keys: [...(await state.storage.list()).keys()].sort(),
    alarm: await state.storage.getAlarm(),
  }));
}

async function fullStorageSnapshot(stub: DurableObjectStub): Promise<{ entries: Array<[string, unknown]>; alarm: number | null }> {
  return runInDurableObject(stub, async (_instance, state) => ({
    entries: [...(await state.storage.list()).entries()].sort(([a], [b]) => a.localeCompare(b)),
    alarm: await state.storage.getAlarm(),
  }));
}

beforeEach(async () => {
  // The fixture tenant is inserted idempotently and supplies D1 policy for the
  // tenant/global acquire paths. The founder is the unchanged neighbour.
  await insertSecondTenant(env);
});

afterEach(async () => {
  // This file runs in the sole non-isolated Workers project because real DO
  // inspection otherwise leaves a Miniflare SQLite sidecar. Clear every
  // fixture namespace explicitly so its serial tests never borrow evidence.
  const tenantGuard = env.TENANT_USAGE_GUARD!;
  const globalGuard = env.GLOBAL_USAGE_GUARD!;
  const authGuard = env.AUTH_RATE_GUARD!;
  for (const stub of [
    tenantGuard.get(tenantGuard.idFromName(OTHER_TENANT_ID)),
    tenantGuard.get(tenantGuard.idFromName(FOUNDER_TENANT_ID)),
    globalGuard.get(globalGuard.idFromName(GLOBAL_USAGE_GUARD_NAME)),
    authGuard.get(authGuard.idFromName(AUTH_RATE_GUARD_NAME)),
  ]) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      await state.storage.deleteAlarm();
    });
  }
  await env.CONTROL_PLANE.batch([
    env.CONTROL_PLANE.prepare("DELETE FROM account_deletions WHERE tenant_id = ?").bind(OTHER_TENANT_ID),
    env.CONTROL_PLANE.prepare("DELETE FROM wipe_progress WHERE tenant_id = ?").bind(OTHER_TENANT_ID),
  ]);
});

describe.sequential("account-deletion Durable Object storage", () => {
  it("physically empties the deleted tenant guard, cancels its alarm, and stays empty on retry", async () => {
    const tenantGuard = env.TENANT_USAGE_GUARD!;
    const stub = tenantGuard.get(tenantGuard.idFromName(OTHER_TENANT_ID));
    const usage = tenantUsageFor(env, OTHER_TENANT_ID);
    const neighbour = tenantGuard.get(tenantGuard.idFromName(FOUNDER_TENANT_ID));
    const neighbourUsage = tenantUsageFor(env, FOUNDER_TENANT_ID);

    expect(await neighbourUsage.admitRequest(NOW_MS)).toEqual({ ok: true });
    expect(await neighbourUsage.reserveReading("op-neighbour", NOW_MS)).toEqual({ ok: true });
    await runInDurableObject(neighbour, async (_instance, state) => {
      await state.storage.put("fixture:neighbour-canary", { preserved: true });
      await state.storage.setAlarm(Date.now() + INGRESS_REQUEST_WINDOW_MS);
    });
    const neighbourBaseline = await fullStorageSnapshot(neighbour);
    expect(neighbourBaseline.entries.map(([key]) => key)).toEqual(
      expect.arrayContaining(["req", "h:2026-09-05T12", "m:2026-09", "op:op-neighbour", "fixture:neighbour-canary"]),
    );
    expect(neighbourBaseline.alarm).not.toBeNull();

    expect(await usage.admitRequest(NOW_MS)).toEqual({ ok: true });
    expect(await usage.reserveReading("op-deleted", NOW_MS)).toEqual({ ok: true });
    const lease = await usage.acquireLease(OTHER_ATTEMPT, NOW_MS);
    expect(lease.ok).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("fixture:canary", { remains: "only until purge" });
      await state.storage.setAlarm(Date.now() + INGRESS_REQUEST_WINDOW_MS);
    });

    const baseline = await storageSnapshot(stub);
    expect(baseline.keys).toEqual(
      expect.arrayContaining(["req", "h:2026-09-05T12", "m:2026-09", "op:op-deleted", `lease:${OTHER_ATTEMPT}`, "fixture:canary"]),
    );
    expect(baseline.alarm).not.toBeNull();

    await expect(purgeTenantUsageGuard(env, OTHER_TENANT_ID)).resolves.toBe("purged");
    expect(await storageSnapshot(stub)).toEqual({ keys: [], alarm: null });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(false);

    // Account teardown retries the same verb after a partial failure. The
    // second purge must remain successful and must not recreate an alarm.
    await expect(purgeTenantUsageGuard(env, OTHER_TENANT_ID)).resolves.toBe("purged");
    expect(await storageSnapshot(stub)).toEqual({ keys: [], alarm: null });

    // Whole-object routing must preserve nonempty neighbour state exactly.
    expect(await fullStorageSnapshot(neighbour)).toEqual(neighbourBaseline);
  });

  it("removes only the deleted tenant's global leases and preserves the neighbour and shared alarm", async () => {
    const global = globalUsageFor(env);
    const a = await global.acquireLease(OTHER_TENANT_ID, OTHER_ATTEMPT, NOW_MS);
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error("fixture failed to acquire deleted tenant lease");
    const paused = await global.acquireLease(OTHER_TENANT_ID, PAUSED_ATTEMPT, NOW_MS);
    expect(paused.ok).toBe(true);
    if (!paused.ok) throw new Error("fixture failed to acquire paused lease");
    expect((await global.pauseLease(OTHER_TENANT_ID, PAUSED_ATTEMPT, paused.fence, NOW_MS)).ok).toBe(true);
    const b = await global.acquireLease(FOUNDER_TENANT_ID, NEIGHBOUR_ATTEMPT, NOW_MS);
    expect(b.ok).toBe(true);
    if (!b.ok) throw new Error("fixture failed to acquire neighbour lease");

    const globalGuard = env.GLOBAL_USAGE_GUARD!;
    const stub = globalGuard.get(globalGuard.idFromName(GLOBAL_USAGE_GUARD_NAME));
    const neighbourKey = leaseStorageKey(`${FOUNDER_TENANT_ID}:${NEIGHBOUR_ATTEMPT}`);
    const baseline = await runInDurableObject(stub, async (_instance, state) => ({
      target: [...(await state.storage.list({ prefix: leaseStorageKey(`${OTHER_TENANT_ID}:`) })).keys()].sort(),
      neighbour: await state.storage.get(neighbourKey),
      alarm: await state.storage.getAlarm(),
    }));
    expect(baseline.target).toEqual([
      leaseStorageKey(`${OTHER_TENANT_ID}:${OTHER_ATTEMPT}`),
      leaseStorageKey(`${OTHER_TENANT_ID}:${PAUSED_ATTEMPT}`),
    ]);
    expect(baseline.neighbour).toMatchObject({ fence: b.fence });
    expect(baseline.alarm).not.toBeNull();

    await expect(purgeGlobalUsageLeases(env, OTHER_TENANT_ID)).resolves.toBe("purged");
    const after = await runInDurableObject(stub, async (_instance, state) => ({
      target: [...(await state.storage.list({ prefix: leaseStorageKey(`${OTHER_TENANT_ID}:`) })).keys()],
      neighbour: await state.storage.get(neighbourKey),
      alarm: await state.storage.getAlarm(),
    }));
    expect(after.target).toEqual([]);
    expect(after.neighbour).toEqual(baseline.neighbour);
    expect(after.alarm).not.toBeNull();

    await expect(purgeGlobalUsageLeases(env, OTHER_TENANT_ID)).resolves.toBe("purged");
    expect((await storageSnapshot(stub)).keys).toEqual([neighbourKey]);

    // The singleton's alarm belongs to its surviving neighbour too. Running it
    // is allowed to retain an in-flight lease; preservation, not empty global
    // storage, is the postcondition for the account purge.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await storageSnapshot(stub)).keys).toEqual([neighbourKey]);
  });

  it("can recreate a global lease after teardown guard purge and before its hard-delete batch", async () => {
    await env.CONTROL_PLANE.batch([
      env.CONTROL_PLANE.prepare("UPDATE users SET status = 'deleting', deleting_at_ms = ? WHERE id = ?")
        .bind(NOW_MS, OTHER_TENANT_ID),
      env.CONTROL_PLANE.prepare(
        `INSERT INTO wipe_progress (
           tenant_id, phase, lease_seq, updated_at_ms, force,
           completed_at_ms, residue, first_completed_at_ms, first_residue
         ) VALUES (?, 'done', 1, ?, 0, ?, 0, ?, 0)`,
      ).bind(OTHER_TENANT_ID, NOW_MS, NOW_MS, NOW_MS),
    ]);

    let reachedPrefixVerdict!: () => void;
    let releasePrefixVerdict!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedPrefixVerdict = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releasePrefixVerdict = resolve;
    });
    const teardown = tearDownAccount(fromD1(env.CONTROL_PLANE), env, {
      tenantId: OTHER_TENANT_ID,
      nowMs: NOW_MS,
      prefixVerdict: async () => {
        reachedPrefixVerdict();
        await release;
        return "empty";
      },
    });
    await reached;

    // The first global purge has returned (otherwise teardown could not have
    // reached this later prefix verdict). Global acquire has no lifecycle
    // gate, so it can recreate state while the user still names valid limits.
    const late = await globalUsageFor(env).acquireLease(OTHER_TENANT_ID, "attempt-after-purge", NOW_MS + 1);
    expect(late.ok).toBe(true);
    const globalGuard = env.GLOBAL_USAGE_GUARD!;
    const stub = globalGuard.get(globalGuard.idFromName(GLOBAL_USAGE_GUARD_NAME));
    const lateKey = leaseStorageKey(`${OTHER_TENANT_ID}:attempt-after-purge`);
    expect((await storageSnapshot(stub)).keys).toContain(lateKey);

    releasePrefixVerdict();
    await expect(teardown).resolves.toMatchObject({ kind: "torn_down", tenantId: OTHER_TENANT_ID });
    expect((await storageSnapshot(stub)).keys).toContain(lateKey);
    await expect(env.CONTROL_PLANE.prepare("SELECT id FROM users WHERE id = ?").bind(OTHER_TENANT_ID).first()).resolves.toBeNull();
  });

  it("expires valid and legacy AuthRateGuard windows on its runtime alarm while retaining malformed records", async () => {
    const authGuard = env.AUTH_RATE_GUARD!;
    const stub = authGuard.get(authGuard.idFromName(AUTH_RATE_GUARD_NAME));
    const now = Date.now();
    await runInDurableObject(stub, async (_instance, state) => {
      // Expired email/IP and legacy no-window records exercise the fallback
      // global window. The live record is byte-for-byte compared after the
      // first alarm; malformed state is intentionally skipped by production
      // cleanup and is a bounded limitation, not a falsely-clean result.
      await state.storage.put("e:expired", { start: now - AUTH_RATE_EMAIL_WINDOW_MS - 1, count: 1, windowMs: AUTH_RATE_EMAIL_WINDOW_MS });
      await state.storage.put("i:expired", { start: now - AUTH_RATE_IP_WINDOW_MS - 1, count: 1, windowMs: AUTH_RATE_IP_WINDOW_MS });
      await state.storage.put("g:all", { start: now - AUTH_RATE_GLOBAL_WINDOW_MS - 1, count: 1, windowMs: AUTH_RATE_GLOBAL_WINDOW_MS });
      await state.storage.put("e:legacy", { start: now - AUTH_RATE_GLOBAL_WINDOW_MS - 1, count: 1 });
      await state.storage.put("e:live", { start: now, count: 2, windowMs: AUTH_RATE_EMAIL_WINDOW_MS });
      await state.storage.put("bad:shape", { start: "not-a-time", count: "not-a-count" });
      // Keep it well ahead of this test's own clock; runDurableObjectAlarm
      // invokes it immediately, while a +1ms alarm may fire autonomously.
      await state.storage.setAlarm(now + AUTH_RATE_GLOBAL_WINDOW_MS);
    });

    expect((await storageSnapshot(stub)).keys).toHaveLength(6);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const first = await runInDurableObject(stub, async (_instance, state) => ({
      live: await state.storage.get("e:live"),
      malformed: await state.storage.get("bad:shape"),
      keys: [...(await state.storage.list()).keys()].sort(),
      alarm: await state.storage.getAlarm(),
    }));
    expect(first.keys).toEqual(["bad:shape", "e:live"]);
    expect(first.live).toEqual({ start: now, count: 2, windowMs: AUTH_RATE_EMAIL_WINDOW_MS });
    expect(first.malformed).toEqual({ start: "not-a-time", count: "not-a-count" });
    expect(first.alarm).toBe(now + AUTH_RATE_EMAIL_WINDOW_MS);

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("e:live", { start: Date.now() - AUTH_RATE_EMAIL_WINDOW_MS - 1, count: 2, windowMs: AUTH_RATE_EMAIL_WINDOW_MS });
      await state.storage.setAlarm(Date.now() + AUTH_RATE_GLOBAL_WINDOW_MS);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const final = await storageSnapshot(stub);
    expect(final.keys).toEqual(["bad:shape"]);
    expect(final.alarm).toBeNull();
  });
});
