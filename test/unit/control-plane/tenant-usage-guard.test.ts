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

function fakeD1(row: Record<string, number> | null, throwOnQuery = false): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => {
          if (throwOnQuery) throw new Error("d1 down");
          return row;
        },
      }),
    }),
  } as unknown as D1Database;
}

function envWithLimits(
  row: Record<string, number> | null = { submissions_per_hour: 2, monthly_readings: 3 },
  throwOnQuery = false,
): Env {
  return { CONTROL_PLANE: fakeD1(row, throwOnQuery) } as Env;
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

  it("reserves distinct hourly and monthly reading slots only up to the D1 limits", async () => {
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
  });
});
