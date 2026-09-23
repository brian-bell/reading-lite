import { describe, expect, it } from "vitest";
import {
  TenantUsageGuard,
  failClosedUsage,
  tenantUsageFor,
  utcHourKey,
  utcHourResetAt,
  utcMonthKey,
  utcMonthResetAt,
} from "../../../src/control-plane/tenant-usage-guard";
import type { Env } from "../../../src/index";
import { READING_RESERVATION_LIVE_TTL_MS, READING_RESERVATION_TTL_MS } from "../../../src/control-plane/constants";
import { fakeHyperdrive } from "../../helpers/fake-control-plane";

const TENANT = "usr_550e8400-e29b-41d4-a716-446655440000";
const NOW = Date.parse("2026-09-03T02:14:00.000Z");

function memoryStorage(
  yieldBeforeRead = false,
  map: Map<string, unknown> = new Map(),
): DurableObjectStorage {
  let alarm: number | null = null;
  return {
    get: async (key: string) => {
      const current = map.get(key);
      if (yieldBeforeRead) await new Promise((resolve) => setTimeout(resolve, 0));
      return current;
    },
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    deleteAll: async () => {
      map.clear();
    },
    list: async () => new Map(map),
    getAlarm: async () => alarm,
    setAlarm: async (expiresAt: number) => {
      alarm = expiresAt;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  } as unknown as DurableObjectStorage;
}

function guardState(storage: DurableObjectStorage = memoryStorage()): DurableObjectState {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    storage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const run = chain.then(callback, callback);
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  } as DurableObjectState;
}

function fakePlane(row: Record<string, number> | null, throwOnQuery = false): Hyperdrive {
  return fakeHyperdrive(throwOnQuery ? new Error("database down") : row);
}

function envWithLimits(
  row: Record<string, number> | null = { submissions_per_hour: 2, monthly_readings: 3 },
  throwOnQuery = false,
): Env {
  return { HYPERDRIVE: fakePlane(row, throwOnQuery) } as Env;
}

async function post(guard: TenantUsageGuard, body: unknown): Promise<Record<string, unknown>> {
  const res = await guard.fetch(
    new Request("https://tenant-usage-guard/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

describe("utc period keys", () => {
  it("uses UTC hour and month boundaries", () => {
    expect(utcHourKey(NOW)).toBe("2026-09-03T02");
    expect(utcMonthKey(NOW)).toBe("2026-09");
    expect(utcHourResetAt(NOW)).toBe(Date.parse("2026-09-03T03:00:00.000Z"));
    expect(utcMonthResetAt(NOW)).toBe(Date.parse("2026-10-01T00:00:00.000Z"));
  });
});

describe("TenantUsageGuard", () => {
  it("admits requests until the hourly ceiling then denies without a reading slot", async () => {
    const map = new Map<string, unknown>();
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), envWithLimits());
    const body = { kind: "admit_request", tenantId: TENANT, nowMs: NOW };
    expect((await post(guard, body)).ok).toBe(true);
    expect((await post(guard, body)).ok).toBe(true);
    const denied = await post(guard, body);
    expect(denied).toMatchObject({ ok: false, reason: "request_rate" });
    expect(map.has(`h:${utcHourKey(NOW)}`)).toBe(false);
    expect(map.has(`m:${utcMonthKey(NOW)}`)).toBe(false);
  });

  it("reserves distinct hourly and monthly reading slots only up to the tenant limits", async () => {
    const map = new Map<string, unknown>();
    const guard = new TenantUsageGuard(
      guardState(memoryStorage(false, map)),
      envWithLimits({ submissions_per_hour: 20, monthly_readings: 2 }),
    );
    expect((await post(guard, { kind: "reserve_reading", tenantId: TENANT, opId: "at_1", nowMs: NOW })).ok).toBe(true);
    expect((await post(guard, { kind: "reserve_reading", tenantId: TENANT, opId: "at_2", nowMs: NOW })).ok).toBe(true);
    const denied = await post(guard, { kind: "reserve_reading", tenantId: TENANT, opId: "at_3", nowMs: NOW });
    expect(denied).toMatchObject({ ok: false, reason: "monthly", reset_at: utcMonthResetAt(NOW) });
    expect(map.get(`m:${utcMonthKey(NOW)}`)).toEqual({ count: 2 });
  });

  it("does not consume a second slot for an idempotent reserve of the same op id", async () => {
    const map = new Map<string, unknown>();
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), envWithLimits());
    const body = { kind: "reserve_reading", tenantId: TENANT, opId: "at_same", nowMs: NOW };
    expect((await post(guard, body)).ok).toBe(true);
    expect((await post(guard, body)).ok).toBe(true);
    expect(map.get(`h:${utcHourKey(NOW)}`)).toEqual({ count: 1 });
    expect(map.get(`m:${utcMonthKey(NOW)}`)).toEqual({ count: 1 });
  });

  it("releases only a held reservation and ignores commit-then-release", async () => {
    const map = new Map<string, unknown>();
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), envWithLimits());
    expect((await post(guard, { kind: "reserve_reading", tenantId: TENANT, opId: "at_held", nowMs: NOW })).ok).toBe(
      true,
    );
    expect((await post(guard, { kind: "release_reading", opId: "at_held" })).ok).toBe(true);
    expect(map.get(`h:${utcHourKey(NOW)}`)).toBeUndefined();
    expect((await post(guard, { kind: "reserve_reading", tenantId: TENANT, opId: "at_keep", nowMs: NOW })).ok).toBe(
      true,
    );
    expect((await post(guard, { kind: "commit_reading", opId: "at_keep" })).ok).toBe(true);
    expect((await post(guard, { kind: "release_reading", opId: "at_keep" })).ok).toBe(true);
    expect(map.get(`m:${utcMonthKey(NOW)}`)).toEqual({ count: 1 });
  });

  it.each([
    ["was never held, or expired and was swept", []],
    ["was released", [{ kind: "release_reading", opId: "at_gone" }]],
  ])("commit_reading refuses a reservation that %s", async (_, before) => {
    const map = new Map<string, unknown>();
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), envWithLimits());
    if (before.length > 0) {
      expect((await post(guard, { kind: "reserve_reading", tenantId: TENANT, opId: "at_gone", nowMs: NOW })).ok).toBe(true);
    }
    for (const body of before) await post(guard, body);
    expect(await post(guard, { kind: "commit_reading", opId: "at_gone" })).toEqual({ ok: false, reason: "expired" });
    expect(map.get(`m:${utcMonthKey(NOW)}`)).toBeUndefined();
  });

  it("commit_reading is idempotent once consumed and charges the slot once", async () => {
    const map = new Map<string, unknown>();
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), envWithLimits());
    expect((await post(guard, { kind: "reserve_reading", tenantId: TENANT, opId: "at_twice", nowMs: NOW })).ok).toBe(true);
    expect(await post(guard, { kind: "commit_reading", opId: "at_twice" })).toEqual({ ok: true });
    expect(await post(guard, { kind: "commit_reading", opId: "at_twice" })).toEqual({ ok: true });
    expect(map.get(`m:${utcMonthKey(NOW)}`)).toEqual({ count: 1 });
  });

  it("does not let a concurrent reserve burst all pass the monthly ceiling", async () => {
    const guard = new TenantUsageGuard(
      guardState(memoryStorage(true)),
      envWithLimits({ submissions_per_hour: 20, monthly_readings: 2 }),
    );
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post(guard, { kind: "reserve_reading", tenantId: TENANT, opId: `at_${i}`, nowMs: NOW }),
      ),
    );
    expect(responses.filter((row) => row.ok === true)).toHaveLength(2);
    expect(responses.filter((row) => row.ok === false)).toHaveLength(6);
  });

  it("fails closed when tenant_limits is missing or invalid", async () => {
    const missing = new TenantUsageGuard(guardState(), envWithLimits(null));
    expect(await post(missing, { kind: "admit_request", tenantId: TENANT, nowMs: NOW })).toEqual({
      ok: false,
      reason: "missing_limits",
    });
    const invalid = new TenantUsageGuard(
      guardState(),
      envWithLimits({ submissions_per_hour: 0, monthly_readings: 10 }),
    );
    expect(await post(invalid, { kind: "reserve_reading", tenantId: TENANT, opId: "at_x", nowMs: NOW })).toEqual({
      ok: false,
      reason: "missing_limits",
    });
    const down = new TenantUsageGuard(guardState(), envWithLimits({ submissions_per_hour: 2, monthly_readings: 3 }, true));
    expect(await post(down, { kind: "admit_request", tenantId: TENANT, nowMs: NOW })).toEqual({
      ok: false,
      reason: "missing_limits",
    });
  });

  // One limits read serves every RPC within GUARD_POLICY_CACHE_MS, a missing
  // row is never cached, and purge_tenant forgets what the instance knew.
  it("reuses the limits row within the configured TTL and forgets it on purge", async () => {
    const answers: (Record<string, number> | null)[] = [null, { submissions_per_hour: 20, monthly_readings: 20, max_concurrent_work: 1 }];
    let reads = 0;
    const env = {
      GUARD_POLICY_CACHE_MS: "60000",
      HYPERDRIVE: fakeHyperdrive(() => {
        reads += 1;
        return answers[Math.min(reads, answers.length) - 1]!;
      }),
    } as Env;
    const guard = new TenantUsageGuard(guardState(memoryStorage()), env);
    const admit = { kind: "admit_request", tenantId: TENANT, nowMs: NOW };

    expect(await post(guard, admit)).toMatchObject({ ok: false, reason: "missing_limits" });
    expect((await post(guard, admit)).ok).toBe(true);
    expect((await post(guard, admit)).ok).toBe(true);
    expect((await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_1", nowMs: NOW })).ok).toBe(true);
    expect(reads).toBe(2);

    expect(await post(guard, { kind: "purge_tenant", tenantId: TENANT })).toEqual({ ok: true });
    expect((await post(guard, admit)).ok).toBe(true);
    expect(reads).toBe(3);
  });

  it("reads the limits row on every RPC when no TTL is configured", async () => {
    let reads = 0;
    const guard = new TenantUsageGuard(
      guardState(memoryStorage()),
      { HYPERDRIVE: fakeHyperdrive(() => { reads += 1; return { submissions_per_hour: 20, monthly_readings: 20 }; }) } as Env,
    );
    const admit = { kind: "admit_request", tenantId: TENANT, nowMs: NOW };
    await post(guard, admit);
    await post(guard, admit);
    expect(reads).toBe(2);
  });

  it("alarm expires a held reservation and restores the monthly count", async () => {
    const map = new Map<string, unknown>([
      [
        "op:at_stale",
        { status: "held", hourKey: utcHourKey(NOW), monthKey: utcMonthKey(NOW), expiresAt: NOW - 1 },
      ],
      [`h:${utcHourKey(NOW)}`, { count: 1 }],
      [`m:${utcMonthKey(NOW)}`, { count: 1 }],
    ]);
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), envWithLimits());
    await guard.alarm();
    expect(map.has("op:at_stale")).toBe(false);
    expect(map.get(`m:${utcMonthKey(NOW)}`)).toBeUndefined();
  });

  it("alarm drops expired consumed ops without decrementing paid-work counts", async () => {
    const now = Date.now();
    const hourKey = utcHourKey(now);
    const monthKey = utcMonthKey(now);
    const map = new Map<string, unknown>([
      [
        "op:at_consumed",
        { status: "consumed", hourKey, monthKey, expiresAt: now - 1 },
      ],
      [`h:${hourKey}`, { count: 1 }],
      [`m:${monthKey}`, { count: 1 }],
    ]);
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), envWithLimits());
    await guard.alarm();
    expect(map.has("op:at_consumed")).toBe(false);
    expect(map.get(`m:${monthKey}`)).toEqual({ count: 1 });
    expect(map.get(`h:${hourKey}`)).toEqual({ count: 1 });
  });

  it("alarm keeps an unexpired consumed op and schedules its cleanup", async () => {
    const now = Date.now();
    const expiresAt = now + 60_000;
    const map = new Map<string, unknown>([
      [
        "op:at_live",
        {
          status: "consumed",
          hourKey: utcHourKey(now),
          monthKey: utcMonthKey(now),
          expiresAt,
        },
      ],
    ]);
    const storage = memoryStorage(false, map);
    const guard = new TenantUsageGuard(guardState(storage), envWithLimits());
    await guard.alarm();
    expect(map.has("op:at_live")).toBe(true);
    expect(await storage.getAlarm()).toBe(expiresAt);
  });

  it("reserve_reading holds an unused slot only for the short TTL", async () => {
    const map = new Map<string, unknown>();
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), envWithLimits());
    const before = Date.now();
    expect((await post(guard, { kind: "reserve_reading", tenantId: TENANT, opId: "at_new", nowMs: NOW })).ok).toBe(true);
    const { expiresAt } = map.get("op:at_new") as { expiresAt: number };
    expect(expiresAt).toBeGreaterThanOrEqual(before + READING_RESERVATION_TTL_MS);
    expect(expiresAt).toBeLessThan(before + READING_RESERVATION_LIVE_TTL_MS);
  });

  it("refresh_reading extends a held reservation to the live TTL so cleanup keeps it", async () => {
    const originalExpiry = NOW + 60 * 60 * 1000;
    const map = new Map<string, unknown>([
      [
        "op:at_defer",
        {
          status: "held",
          hourKey: utcHourKey(NOW),
          monthKey: utcMonthKey(NOW),
          expiresAt: originalExpiry,
        },
      ],
      [`h:${utcHourKey(NOW)}`, { count: 1 }],
      [`m:${utcMonthKey(NOW)}`, { count: 1 }],
    ]);
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), envWithLimits());
    const later = NOW + 60 * 60 * 1000 + 1;
    expect(
      await post(guard, { kind: "refresh_reading", tenantId: TENANT, opId: "at_defer", nowMs: later }),
    ).toEqual({ ok: true });
    const row = map.get("op:at_defer") as { status: string; expiresAt: number };
    expect(row.status).toBe("held");
    expect(row.expiresAt).toBe(later + READING_RESERVATION_LIVE_TTL_MS);
    // A refresh stamped with an earlier clock must not shorten the hold.
    await post(guard, { kind: "refresh_reading", tenantId: TENANT, opId: "at_defer", nowMs: NOW });
    expect((map.get("op:at_defer") as { expiresAt: number }).expiresAt).toBe(later + READING_RESERVATION_LIVE_TTL_MS);
    expect(map.get(`m:${utcMonthKey(NOW)}`)).toEqual({ count: 1 });
  });

  it("refresh_reading does not resurrect consumed or released reservations", async () => {
    const map = new Map<string, unknown>([
      [
        "op:at_consumed",
        {
          status: "consumed",
          hourKey: utcHourKey(NOW),
          monthKey: utcMonthKey(NOW),
          expiresAt: NOW + 1,
        },
      ],
    ]);
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), envWithLimits());
    expect(
      await post(guard, { kind: "refresh_reading", tenantId: TENANT, opId: "at_consumed", nowMs: NOW + 10 }),
    ).toEqual({ ok: true });
    expect(map.get("op:at_consumed")).toMatchObject({ status: "consumed", expiresAt: NOW + 1 });
  });

  it("commit after a refreshed hold still consumes hourly and monthly counts", async () => {
    const map = new Map<string, unknown>();
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), envWithLimits());
    expect((await post(guard, { kind: "reserve_reading", tenantId: TENANT, opId: "at_1", nowMs: NOW })).ok).toBe(true);
    expect(
      (await post(guard, { kind: "refresh_reading", tenantId: TENANT, opId: "at_1", nowMs: NOW + 2 * 60 * 60 * 1000 })).ok,
    ).toBe(true);
    expect((await post(guard, { kind: "commit_reading", opId: "at_1" })).ok).toBe(true);
    expect(map.get("op:at_1")).toMatchObject({ status: "consumed" });
    expect(map.get(`h:${utcHourKey(NOW)}`)).toEqual({ count: 1 });
    expect(map.get(`m:${utcMonthKey(NOW)}`)).toEqual({ count: 1 });
    expect((await post(guard, { kind: "release_reading", opId: "at_1" })).ok).toBe(true);
    expect(map.get(`m:${utcMonthKey(NOW)}`)).toEqual({ count: 1 });
  });

});

describe("tenantUsageFor", () => {
  it("fails closed without a Durable Object binding", async () => {
    const usage = tenantUsageFor({ APP_ENV: "production" } as Env, TENANT);
    expect(await usage.admitRequest(NOW)).toEqual({ ok: false, reason: "unavailable" });
    expect(await usage.reserveReading("at_1", NOW)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("failClosedUsage denies admit and reserve but no-ops release", async () => {
    const usage = failClosedUsage();
    expect(await usage.admitRequest(NOW)).toMatchObject({ ok: false });
    await expect(usage.releaseReading("at_1")).resolves.toBeUndefined();
    expect(await usage.acquireLease("at_1", NOW)).toEqual({ ok: false, reason: "unavailable" });
  });
});
