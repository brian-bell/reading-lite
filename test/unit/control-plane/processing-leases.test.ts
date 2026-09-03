import { describe, expect, it } from "vitest";
import { PROCESSING_LEASE_TTL_MS } from "../../../src/control-plane/constants";
import { GlobalUsageGuard } from "../../../src/control-plane/global-usage-guard";
import {
  acquireProcessingLeases,
  DeferPaidWorkError,
  throwIfDeferred,
  type ProcessingLeaseDeps,
} from "../../../src/control-plane/processing-leases";
import { leaseStorageKey } from "../../../src/control-plane/processing-lease-state";
import {
  failClosedUsage,
  TenantUsageGuard,
  type ProcessingLeaseDecision,
  type TenantUsage,
} from "../../../src/control-plane/tenant-usage-guard";
import type { GlobalUsage } from "../../../src/control-plane/global-usage-guard";
import type { Env } from "../../../src/index";

const TENANT = "usr_550e8400-e29b-41d4-a716-446655440000";
const TENANT_B = "usr_11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-09-03T02:14:00.000Z");

function memoryStorage(
  yieldBeforeRead = false,
  map: Map<string, unknown> = new Map(),
): DurableObjectStorage & { map: Map<string, unknown> } {
  let alarm: number | null = null;
  const storage = {
    map,
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
  };
  return storage as unknown as DurableObjectStorage & { map: Map<string, unknown> };
}

function guardState(storage: DurableObjectStorage): DurableObjectState {
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
      first: async () => {
        if (throwOnQuery) throw new Error("d1 down");
        return row;
      },
    }),
  } as unknown as D1Database;
}

function tenantEnv(
  row: Record<string, number> | null = {
    submissions_per_hour: 20,
    monthly_readings: 20,
    max_concurrent_work: 1,
  },
  throwOnQuery = false,
): Env {
  return { CONTROL_PLANE: fakeD1(row, throwOnQuery) } as Env;
}

function globalEnv(row: Record<string, number> | null = { max_concurrent_work: 1 }, throwOnQuery = false): Env {
  return { CONTROL_PLANE: fakeD1(row, throwOnQuery) } as Env;
}

async function post(guard: { fetch(request: Request): Promise<Response> }, body: unknown): Promise<Record<string, unknown>> {
  const res = await guard.fetch(
    new Request("https://usage-guard/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

describe("TenantUsageGuard processing leases", () => {
  it("issues a fenced lease up to max_concurrent_work and denies the next attempt", async () => {
    const map = new Map<string, unknown>();
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), tenantEnv());
    const first = await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_1", nowMs: NOW });
    expect(first.ok).toBe(true);
    expect(typeof first.fence).toBe("string");
    expect(first.already_running).toBe(false);
    const denied = await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_2", nowMs: NOW });
    expect(denied).toMatchObject({ ok: false, reason: "contention" });
    expect(map.has(leaseStorageKey("at_2"))).toBe(false);
  });

  it("returns the existing fence for a duplicate acquire of the same attempt", async () => {
    const map = new Map<string, unknown>();
    const guard = new TenantUsageGuard(
      guardState(memoryStorage(false, map)),
      tenantEnv({ max_concurrent_work: 2 }),
    );
    const first = await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_same", nowMs: NOW });
    const again = await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_same", nowMs: NOW });
    expect(again).toMatchObject({ ok: true, fence: first.fence, already_running: true });
    expect([...map.keys()].filter((key) => key.startsWith("lease:"))).toHaveLength(1);
  });

  it("rejects renew, pause, and release with a stale or expired fence", async () => {
    const guard = new TenantUsageGuard(guardState(memoryStorage()), tenantEnv());
    const held = await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_f", nowMs: NOW });
    expect(
      await post(guard, { kind: "renew_lease", attemptId: "at_f", fence: "not-the-fence", nowMs: NOW }),
    ).toMatchObject({ ok: false, reason: "stale_fence" });
    expect(
      await post(guard, { kind: "release_lease", attemptId: "at_f", fence: "not-the-fence", nowMs: NOW }),
    ).toMatchObject({ ok: false, reason: "stale_fence" });
    expect(
      await post(guard, {
        kind: "renew_lease",
        attemptId: "at_f",
        fence: held.fence,
        nowMs: NOW + PROCESSING_LEASE_TTL_MS + 1,
      }),
    ).toMatchObject({ ok: false, reason: "stale_fence" });
  });

  it("lets the holder renew and then release so a second attempt can acquire", async () => {
    const guard = new TenantUsageGuard(guardState(memoryStorage()), tenantEnv());
    const held = await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_a", nowMs: NOW });
    expect(
      await post(guard, { kind: "renew_lease", attemptId: "at_a", fence: held.fence, nowMs: NOW + 1_000 }),
    ).toMatchObject({ ok: true, fence: held.fence });
    expect(
      await post(guard, { kind: "release_lease", attemptId: "at_a", fence: held.fence, nowMs: NOW + 1_000 }),
    ).toMatchObject({ ok: true });
    expect(
      await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_b", nowMs: NOW + 1_000 }),
    ).toMatchObject({ ok: true, already_running: false });
  });

  it("pause keeps the permit so a later acquire of the same attempt resumes the fence", async () => {
    const map = new Map<string, unknown>();
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), tenantEnv());
    const held = await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_p", nowMs: NOW });
    expect(
      await post(guard, { kind: "pause_lease", attemptId: "at_p", fence: held.fence, nowMs: NOW + 1 }),
    ).toMatchObject({ ok: true, fence: held.fence });
    const resumed = await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_p", nowMs: NOW + 2 });
    expect(resumed).toMatchObject({ ok: true, fence: held.fence, already_running: false });
    expect(
      await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_other", nowMs: NOW + 2 }),
    ).toMatchObject({ ok: false, reason: "contention" });
  });

  it("does not let a concurrent acquire burst past the cap", async () => {
    const guard = new TenantUsageGuard(
      guardState(memoryStorage(true)),
      tenantEnv({ max_concurrent_work: 2 }),
    );
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: `at_${i}`, nowMs: NOW }),
      ),
    );
    expect(responses.filter((row) => row.ok === true)).toHaveLength(2);
    expect(responses.filter((row) => row.ok === false)).toHaveLength(6);
  });

  it("fails closed when max_concurrent_work is missing without touching ingress slots", async () => {
    const map = new Map<string, unknown>();
    const guard = new TenantUsageGuard(
      guardState(memoryStorage(false, map)),
      tenantEnv({ submissions_per_hour: 2, monthly_readings: 3 }),
    );
    expect(await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_x", nowMs: NOW })).toEqual({
      ok: false,
      reason: "missing_limits",
    });
    expect(await post(guard, { kind: "admit_request", tenantId: TENANT, nowMs: NOW })).toMatchObject({ ok: true });
    expect(map.has(leaseStorageKey("at_x"))).toBe(false);
  });

  it("alarm expires a lease so a later acquire is not blocked", async () => {
    const map = new Map<string, unknown>([
      [leaseStorageKey("at_stale"), { fence: "old", expiresAt: NOW - 1, inFlight: true }],
    ]);
    const storage = memoryStorage(false, map);
    const guard = new TenantUsageGuard(guardState(storage), tenantEnv());
    await guard.alarm();
    expect(map.has(leaseStorageKey("at_stale"))).toBe(false);
    expect(
      await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_fresh", nowMs: Date.now() }),
    ).toMatchObject({ ok: true });
  });

  it("does not schedule a cleanup alarm in the past", async () => {
    const storage = memoryStorage();
    const guard = new TenantUsageGuard(guardState(storage), tenantEnv());
    await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_a", nowMs: 1 });
    const alarm = await storage.getAlarm();
    expect(alarm == null || alarm > Date.now()).toBe(true);
  });
});

describe("GlobalUsageGuard processing leases", () => {
  it("serializes global concurrency across tenants and is idempotent per attempt", async () => {
    const guard = new GlobalUsageGuard(guardState(memoryStorage()), globalEnv({ max_concurrent_work: 1 }));
    const first = await post(guard, {
      kind: "acquire_lease",
      tenantId: TENANT,
      attemptId: "at_1",
      nowMs: NOW,
    });
    expect(first.ok).toBe(true);
    const dup = await post(guard, {
      kind: "acquire_lease",
      tenantId: TENANT,
      attemptId: "at_1",
      nowMs: NOW,
    });
    expect(dup).toMatchObject({ ok: true, fence: first.fence, already_running: true });
    expect(
      await post(guard, { kind: "acquire_lease", tenantId: TENANT_B, attemptId: "at_2", nowMs: NOW }),
    ).toMatchObject({ ok: false, reason: "contention" });
  });

  it("fails closed when system_policy concurrency is missing", async () => {
    const guard = new GlobalUsageGuard(guardState(memoryStorage()), globalEnv(null));
    expect(
      await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_1", nowMs: NOW }),
    ).toEqual({ ok: false, reason: "missing_limits" });
  });

  it("expired fence cannot renew after alarm sweep", async () => {
    const map = new Map<string, unknown>([
      [
        leaseStorageKey(`${TENANT}:at_old`),
        { fence: "f1", expiresAt: Date.now() - 1, inFlight: true },
      ],
    ]);
    const guard = new GlobalUsageGuard(guardState(memoryStorage(false, map)), globalEnv());
    await guard.alarm();
    expect(
      await post(guard, {
        kind: "renew_lease",
        tenantId: TENANT,
        attemptId: "at_old",
        fence: "f1",
        nowMs: Date.now(),
      }),
    ).toMatchObject({ ok: false, reason: "stale_fence" });
  });
});

describe("tenant-first lease saga", () => {
  function depsFrom(
    tenantAcquire: ProcessingLeaseDecision[],
    globalAcquire: Array<ProcessingLeaseDecision | Error>,
    released: string[],
  ): ProcessingLeaseDeps {
    const tenant: TenantUsage = {
      ...failClosedUsage(),
      acquireLease: async () => tenantAcquire.shift() ?? { ok: false, reason: "unavailable" },
      releaseLease: async () => {
        released.push("tenant");
      },
    };
    const global: GlobalUsage = {
      acquireLease: async () => {
        const next = globalAcquire.shift();
        if (next instanceof Error) throw next;
        return next ?? { ok: false, reason: "unavailable" };
      },
      renewLease: async () => ({ ok: false, reason: "unavailable" }),
      pauseLease: async () => ({ ok: false, reason: "unavailable" }),
      releaseLease: async () => {
        released.push("global");
      },
    };
    return { tenant, global };
  }

  it("compensates the tenant lease when global denies", async () => {
    const released: string[] = [];
    const result = await acquireProcessingLeases(
      {} as Env,
      TENANT,
      "at_1",
      NOW,
      depsFrom(
        [{ ok: true, fence: "tf", alreadyRunning: false, expiresAtMs: NOW + 1 }],
        [{ ok: false, reason: "contention" }],
        released,
      ),
    );
    expect(result).toEqual({ ok: false, reason: "contention" });
    expect(released).toEqual(["tenant"]);
  });

  it("treats an uncertain global response as denied and compensates tenant", async () => {
    const released: string[] = [];
    const result = await acquireProcessingLeases(
      {} as Env,
      TENANT,
      "at_1",
      NOW,
      depsFrom(
        [{ ok: true, fence: "tf", alreadyRunning: false, expiresAtMs: NOW + 1 }],
        [new Error("do timeout")],
        released,
      ),
    );
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(released).toEqual(["tenant"]);
  });

  it("returns already_running without taking a second global permit", async () => {
    const released: string[] = [];
    const result = await acquireProcessingLeases(
      {} as Env,
      TENANT,
      "at_1",
      NOW,
      depsFrom([{ ok: true, fence: "tf", alreadyRunning: true, expiresAtMs: NOW + 1 }], [], released),
    );
    expect(result).toEqual({ ok: true, alreadyRunning: true });
    expect(released).toEqual([]);
  });

  it("throwIfDeferred raises defer_paid_work on contention and not on a hold", async () => {
    expect(() => throwIfDeferred({ ok: false, reason: "contention" })).toThrow(DeferPaidWorkError);
    const hold = throwIfDeferred({
      ok: true,
      alreadyRunning: false,
      hold: { tenantId: TENANT, attemptId: "at_1", tenantFence: "t", globalFence: "g" },
    });
    expect(hold).toMatchObject({ tenantFence: "t", globalFence: "g" });
  });
});
