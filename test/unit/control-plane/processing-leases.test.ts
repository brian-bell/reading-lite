import { describe, expect, it } from "vitest";
import { PROCESSING_LEASE_TTL_MS } from "../../../src/control-plane/constants";
import { GlobalUsageGuard } from "../../../src/control-plane/global-usage-guard";
import {
  acquireProcessingLeases,
  clearOrphanedProcessingLeases,
  DeferPaidWorkError,
  heartbeatProcessingLeases,
  pauseProcessingLeases,
  pauseOrReleaseProcessingLeases,
  peekProcessingLeaseReleaseHold,
  releaseProcessingLeases,
  renewProcessingLeases,
  throwIfDeferred,
  type ProcessingLeaseDeps,
  type ProcessingLeaseHold,
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

  it("rejects renew and release with a stale fence; in-flight past TTL can still renew", async () => {
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
    ).toMatchObject({ ok: true, fence: held.fence });
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

  it("heartbeat after pause extends TTL without resurrecting inFlight", async () => {
    const map = new Map<string, unknown>();
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), tenantEnv());
    const held = await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_hb", nowMs: NOW });
    expect(
      await post(guard, { kind: "pause_lease", attemptId: "at_hb", fence: held.fence, nowMs: NOW + 1 }),
    ).toMatchObject({ ok: true });
    expect(
      await post(guard, {
        kind: "renew_lease",
        attemptId: "at_hb",
        fence: held.fence,
        nowMs: NOW + 2,
        preserveInFlight: true,
      }),
    ).toMatchObject({ ok: true, fence: held.fence });
    expect(map.get(leaseStorageKey("at_hb"))).toMatchObject({ inFlight: false, fence: held.fence });
    expect(
      await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_other", nowMs: NOW + 2 }),
    ).toMatchObject({ ok: false, reason: "contention" });
    expect(
      await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_hb", nowMs: NOW + 2 }),
    ).toMatchObject({ ok: true, already_running: false, fence: held.fence });
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

  it("alarm expires a paused lease so a later acquire is not blocked", async () => {
    const map = new Map<string, unknown>([
      [leaseStorageKey("at_stale"), { fence: "old", expiresAt: NOW - 1, inFlight: false }],
    ]);
    const storage = memoryStorage(false, map);
    const guard = new TenantUsageGuard(guardState(storage), tenantEnv());
    await guard.alarm();
    expect(map.has(leaseStorageKey("at_stale"))).toBe(false);
    expect(
      await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_fresh", nowMs: Date.now() }),
    ).toMatchObject({ ok: true });
  });

  it("does not sweep an in-flight lease past TTL and keeps the slot held", async () => {
    const map = new Map<string, unknown>([
      [leaseStorageKey("at_live"), { fence: "held", expiresAt: NOW - 1, inFlight: true }],
    ]);
    const storage = memoryStorage(false, map);
    const guard = new TenantUsageGuard(guardState(storage), tenantEnv());
    await guard.alarm();
    expect(map.get(leaseStorageKey("at_live"))).toMatchObject({ fence: "held", inFlight: true });
    expect(
      await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_live", nowMs: NOW }),
    ).toMatchObject({ ok: true, already_running: true, fence: "held" });
    expect(
      await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_other", nowMs: NOW }),
    ).toMatchObject({ ok: false, reason: "contention" });
  });

  it("pause then complete still releases; paused expiry frees the slot", async () => {
    const map = new Map<string, unknown>();
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), tenantEnv());
    const held = await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_p2", nowMs: NOW });
    expect(
      await post(guard, { kind: "pause_lease", attemptId: "at_p2", fence: held.fence, nowMs: NOW + 1 }),
    ).toMatchObject({ ok: true });
    expect(map.get(leaseStorageKey("at_p2"))).toMatchObject({ inFlight: false });
    expect(
      await post(guard, { kind: "release_lease", attemptId: "at_p2", fence: held.fence, nowMs: NOW + 2 }),
    ).toMatchObject({ ok: true });
    expect(map.has(leaseStorageKey("at_p2"))).toBe(false);
    expect(
      await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_after", nowMs: NOW + 2 }),
    ).toMatchObject({ ok: true, already_running: false });
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

  it("expired paused fence cannot renew after alarm sweep", async () => {
    const map = new Map<string, unknown>([
      [
        leaseStorageKey(`${TENANT}:at_old`),
        { fence: "f1", expiresAt: Date.now() - 1, inFlight: false },
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

  it("in-flight past TTL can still renew and then release", async () => {
    const map = new Map<string, unknown>([
      [
        leaseStorageKey(`${TENANT}:at_hold`),
        { fence: "f1", expiresAt: Date.now() - 1, inFlight: true },
      ],
    ]);
    const guard = new GlobalUsageGuard(guardState(memoryStorage(false, map)), globalEnv());
    await guard.alarm();
    expect(
      await post(guard, {
        kind: "renew_lease",
        tenantId: TENANT,
        attemptId: "at_hold",
        fence: "f1",
        nowMs: Date.now(),
      }),
    ).toMatchObject({ ok: true, fence: "f1" });
    expect(
      await post(guard, {
        kind: "release_lease",
        tenantId: TENANT,
        attemptId: "at_hold",
        fence: "f1",
        nowMs: Date.now(),
      }),
    ).toMatchObject({ ok: true });
    expect(
      await post(guard, { kind: "acquire_lease", tenantId: TENANT, attemptId: "at_next", nowMs: Date.now() }),
    ).toMatchObject({ ok: true, already_running: false });
  });
});

describe("tenant-first lease saga", () => {
  function depsFrom(
    tenantAcquire: ProcessingLeaseDecision[],
    globalAcquire: Array<ProcessingLeaseDecision | Error>,
    released: string[],
    globalOverride?: Partial<GlobalUsage>,
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
      peekLease: async () => ({ ok: false, reason: "unavailable" }),
      clearDeadLease: async () => ({ ok: false, reason: "changed" }),
      ...globalOverride,
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

  it("already_running returns a release-only hold with both fences, without taking a second global permit", async () => {
    const released: string[] = [];
    const globalOverride: Partial<GlobalUsage> = {
      acquireLease: async () => {
        throw new Error("must not acquire a global permit on a release-only path");
      },
      peekLease: async () => ({
        ok: true,
        present: true,
        fence: "gf_orphan",
        expiresAtMs: NOW - 1,
        inFlight: true,
      }),
    };
    const result = await acquireProcessingLeases(
      {} as Env,
      TENANT,
      "at_1",
      NOW,
      depsFrom([{ ok: true, fence: "tf", alreadyRunning: true, expiresAtMs: NOW - 1 }], [], released, globalOverride),
    );
    expect(result).toEqual({
      ok: true,
      alreadyRunning: true,
      releaseHold: {
        tenantId: TENANT,
        attemptId: "at_1",
        tenantFence: "tf",
        tenantExpiresAtMs: NOW - 1,
        globalFence: "gf_orphan",
        globalExpiresAtMs: NOW - 1,
      },
    });
    expect(released).toEqual([]);
  });

  it("already_running without a global row yields a null-fence release hold", async () => {
    const released: string[] = [];
    const result = await acquireProcessingLeases(
      {} as Env,
      TENANT,
      "at_1",
      NOW,
      depsFrom([{ ok: true, fence: "tf", alreadyRunning: true, expiresAtMs: NOW - 1 }], [], released),
    );
    expect(result).toMatchObject({
      ok: true,
      alreadyRunning: true,
      releaseHold: { tenantFence: "tf", globalFence: null, globalExpiresAtMs: null },
    });
    expect(released).toEqual([]);
  });

  it("throwIfDeferred raises defer_paid_work on contention and not on a hold", async () => {
    expect(() => throwIfDeferred({ ok: false, reason: "contention" })).toThrow(DeferPaidWorkError);
    const hold = throwIfDeferred({
      ok: true,
      alreadyRunning: false,
      hold: { tenantId: TENANT, attemptId: "at_1", tenantFence: "t", globalFence: "g" },
    });
    expect(hold).toMatchObject({ kind: "work", hold: { tenantFence: "t", globalFence: "g" } });
    const releaseOnly = throwIfDeferred({
      ok: true,
      alreadyRunning: true,
      releaseHold: {
        tenantId: TENANT,
        attemptId: "at_1",
        tenantFence: "t",
        tenantExpiresAtMs: NOW,
        globalFence: null,
        globalExpiresAtMs: null,
      },
    });
    expect(releaseOnly.kind).toBe("release_only");
  });

  it("adopts a same-attempt global already_running instead of compensating tenant", async () => {
    const released: string[] = [];
    const result = await acquireProcessingLeases(
      {} as Env,
      TENANT,
      "at_1",
      NOW,
      depsFrom(
        [{ ok: true, fence: "tf", alreadyRunning: false, expiresAtMs: NOW + 1 }],
        [{ ok: true, fence: "gf", alreadyRunning: true, expiresAtMs: NOW + 1 }],
        released,
      ),
    );
    expect(result).toEqual({
      ok: true,
      alreadyRunning: false,
      hold: { tenantId: TENANT, attemptId: "at_1", tenantFence: "tf", globalFence: "gf" },
    });
    expect(released).toEqual([]);
  });

  it("recovers a lost global-acquire response on retry by adopting the orphaned fence", async () => {
    const released: string[] = [];
    let tenantAcquires = 0;
    let globalAcquires = 0;
    const tenant: TenantUsage = {
      ...failClosedUsage(),
      acquireLease: async () => {
        tenantAcquires += 1;
        return { ok: true, fence: `tf_${tenantAcquires}`, alreadyRunning: false, expiresAtMs: NOW + 1 };
      },
      releaseLease: async () => {
        released.push("tenant");
      },
    };
    const global: GlobalUsage = {
      acquireLease: async () => {
        globalAcquires += 1;
        if (globalAcquires === 1) throw new Error("response lost");
        return { ok: true, fence: "gf_orphan", alreadyRunning: true, expiresAtMs: NOW + 1 };
      },
      renewLease: async () => ({ ok: false, reason: "unavailable" }),
      pauseLease: async () => ({ ok: false, reason: "unavailable" }),
      releaseLease: async () => {
        released.push("global");
      },
      peekLease: async () => ({ ok: false, reason: "unavailable" }),
      clearDeadLease: async () => ({ ok: false, reason: "changed" }),
    };
    const first = await acquireProcessingLeases({} as Env, TENANT, "at_1", NOW, { tenant, global });
    expect(first).toEqual({ ok: false, reason: "unavailable" });
    expect(released).toEqual(["tenant"]);
    released.length = 0;
    const retry = await acquireProcessingLeases({} as Env, TENANT, "at_1", NOW, { tenant, global });
    expect(retry).toEqual({
      ok: true,
      alreadyRunning: false,
      hold: { tenantId: TENANT, attemptId: "at_1", tenantFence: "tf_2", globalFence: "gf_orphan" },
    });
    expect(released).toEqual([]);
  });

  it("compensates tenant when a foreign live global contends", async () => {
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

  const HOLD: ProcessingLeaseHold = {
    tenantId: TENANT,
    attemptId: "at_1",
    tenantFence: "tf",
    globalFence: "gf",
  };

  function opsDeps(opts: {
    released: string[];
    calls: string[];
    tenantRenew?: ProcessingLeaseDecision | Error;
    globalRenew?: ProcessingLeaseDecision | Error;
    tenantPause?: ProcessingLeaseDecision | Error;
    globalPause?: ProcessingLeaseDecision | Error;
  }): ProcessingLeaseDeps {
    const next = (value: ProcessingLeaseDecision | Error | undefined): ProcessingLeaseDecision => {
      if (value instanceof Error) throw value;
      return value ?? { ok: false, reason: "unavailable" };
    };
    const tenant: TenantUsage = {
      ...failClosedUsage(),
      renewLease: async () => {
        opts.calls.push("tenant.renew");
        return next(opts.tenantRenew);
      },
      pauseLease: async () => {
        opts.calls.push("tenant.pause");
        return next(opts.tenantPause);
      },
      releaseLease: async () => {
        opts.released.push("tenant");
      },
    };
    const global: GlobalUsage = {
      acquireLease: async () => ({ ok: false, reason: "unavailable" }),
      renewLease: async () => {
        opts.calls.push("global.renew");
        return next(opts.globalRenew);
      },
      pauseLease: async () => {
        opts.calls.push("global.pause");
        return next(opts.globalPause);
      },
      releaseLease: async () => {
        opts.released.push("global");
      },
      peekLease: async () => ({ ok: false, reason: "unavailable" }),
      clearDeadLease: async () => ({ ok: false, reason: "changed" }),
    };
    return { tenant, global };
  }

  it("releases the tenant lease when global renew denies after tenant renew", async () => {
    const released: string[] = [];
    const calls: string[] = [];
    const result = await renewProcessingLeases(
      {} as Env,
      HOLD,
      NOW,
      opsDeps({
        released,
        calls,
        tenantRenew: { ok: true, fence: "tf", alreadyRunning: false, expiresAtMs: NOW + 1 },
        globalRenew: { ok: false, reason: "stale_fence" },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "stale_fence" });
    expect(calls).toEqual(["tenant.renew", "global.renew"]);
    expect(released).toEqual(["tenant"]);
  });

  it("releases the tenant lease when global renew throws after tenant renew", async () => {
    const released: string[] = [];
    const calls: string[] = [];
    const result = await renewProcessingLeases(
      {} as Env,
      HOLD,
      NOW,
      opsDeps({
        released,
        calls,
        tenantRenew: { ok: true, fence: "tf", alreadyRunning: false, expiresAtMs: NOW + 1 },
        globalRenew: new Error("do timeout"),
      }),
    );
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(calls).toEqual(["tenant.renew", "global.renew"]);
    expect(released).toEqual(["tenant"]);
  });

  it("does not touch global when tenant renew fails", async () => {
    const released: string[] = [];
    const calls: string[] = [];
    const result = await renewProcessingLeases(
      {} as Env,
      HOLD,
      NOW,
      opsDeps({
        released,
        calls,
        tenantRenew: { ok: false, reason: "stale_fence" },
        globalRenew: { ok: true, fence: "gf", alreadyRunning: false, expiresAtMs: NOW + 1 },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "stale_fence" });
    expect(calls).toEqual(["tenant.renew"]);
    expect(released).toEqual([]);
  });

  it("restores tenant inFlight when global pause denies after tenant pause", async () => {
    const released: string[] = [];
    const calls: string[] = [];
    const result = await pauseProcessingLeases(
      {} as Env,
      HOLD,
      NOW,
      opsDeps({
        released,
        calls,
        tenantPause: { ok: true, fence: "tf", alreadyRunning: false, expiresAtMs: NOW + 1 },
        globalPause: { ok: false, reason: "stale_fence" },
        tenantRenew: { ok: true, fence: "tf", alreadyRunning: false, expiresAtMs: NOW + 1 },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "stale_fence" });
    expect(calls).toEqual(["tenant.pause", "global.pause", "tenant.renew"]);
    expect(released).toEqual([]);
  });

  it("restores tenant inFlight when global pause throws after tenant pause", async () => {
    const released: string[] = [];
    const calls: string[] = [];
    const result = await pauseProcessingLeases(
      {} as Env,
      HOLD,
      NOW,
      opsDeps({
        released,
        calls,
        tenantPause: { ok: true, fence: "tf", alreadyRunning: false, expiresAtMs: NOW + 1 },
        globalPause: new Error("do timeout"),
        tenantRenew: { ok: true, fence: "tf", alreadyRunning: false, expiresAtMs: NOW + 1 },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(calls).toEqual(["tenant.pause", "global.pause", "tenant.renew"]);
    expect(released).toEqual([]);
  });

  it("heartbeat renews both sides without releasing tenant when global denies", async () => {
    const released: string[] = [];
    const calls: string[] = [];
    await heartbeatProcessingLeases(
      {} as Env,
      HOLD,
      NOW,
      opsDeps({
        released,
        calls,
        tenantRenew: { ok: true, fence: "tf", alreadyRunning: false, expiresAtMs: NOW + 1 },
        globalRenew: { ok: false, reason: "stale_fence" },
      }),
    );
    expect(calls).toEqual(["tenant.renew", "global.renew"]);
    expect(released).toEqual([]);
  });

  it("heartbeat renews both sides without releasing tenant when global throws", async () => {
    const released: string[] = [];
    const calls: string[] = [];
    await heartbeatProcessingLeases(
      {} as Env,
      HOLD,
      NOW,
      opsDeps({
        released,
        calls,
        tenantRenew: { ok: true, fence: "tf", alreadyRunning: false, expiresAtMs: NOW + 1 },
        globalRenew: new Error("do timeout"),
      }),
    );
    expect(calls).toEqual(["tenant.renew", "global.renew"]);
    expect(released).toEqual([]);
  });

  it("heartbeat still renews global when tenant renew fails", async () => {
    const released: string[] = [];
    const calls: string[] = [];
    await heartbeatProcessingLeases(
      {} as Env,
      HOLD,
      NOW,
      opsDeps({
        released,
        calls,
        tenantRenew: { ok: false, reason: "stale_fence" },
        globalRenew: { ok: true, fence: "gf", alreadyRunning: false, expiresAtMs: NOW + 1 },
      }),
    );
    expect(calls).toEqual(["tenant.renew", "global.renew"]);
    expect(released).toEqual([]);
  });

  it("heartbeat asks both sides to preserve inFlight", async () => {
    const flags: Array<boolean | undefined> = [];
    const released: string[] = [];
    const tenant: TenantUsage = {
      ...failClosedUsage(),
      renewLease: async (_attemptId, _fence, _nowMs, opts) => {
        flags.push(opts?.preserveInFlight);
        return { ok: true, fence: "tf", alreadyRunning: false, expiresAtMs: NOW + 1 };
      },
      releaseLease: async () => {
        released.push("tenant");
      },
    };
    const global: GlobalUsage = {
      acquireLease: async () => ({ ok: false, reason: "unavailable" }),
      renewLease: async (_tenantId, _attemptId, _fence, _nowMs, opts) => {
        flags.push(opts?.preserveInFlight);
        return { ok: true, fence: "gf", alreadyRunning: false, expiresAtMs: NOW + 1 };
      },
      pauseLease: async () => ({ ok: false, reason: "unavailable" }),
      releaseLease: async () => {
        released.push("global");
      },
      peekLease: async () => ({ ok: false, reason: "unavailable" }),
      clearDeadLease: async () => ({ ok: false, reason: "changed" }),
    };
    await heartbeatProcessingLeases({} as Env, HOLD, NOW, { tenant, global });
    expect(flags).toEqual([true, true]);
    expect(released).toEqual([]);
  });

  it("heartbeat still renews global when tenant renew throws", async () => {
    const released: string[] = [];
    const calls: string[] = [];
    await heartbeatProcessingLeases(
      {} as Env,
      HOLD,
      NOW,
      opsDeps({
        released,
        calls,
        tenantRenew: new Error("do timeout"),
        globalRenew: { ok: true, fence: "gf", alreadyRunning: false, expiresAtMs: NOW + 1 },
      }),
    );
    expect(calls).toEqual(["tenant.renew", "global.renew"]);
    expect(released).toEqual([]);
  });

  it("does not pause global when tenant pause fails", async () => {
    const released: string[] = [];
    const calls: string[] = [];
    const result = await pauseProcessingLeases(
      {} as Env,
      HOLD,
      NOW,
      opsDeps({
        released,
        calls,
        tenantPause: { ok: false, reason: "stale_fence" },
        globalPause: { ok: true, fence: "gf", alreadyRunning: false, expiresAtMs: NOW + 1 },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "stale_fence" });
    expect(calls).toEqual(["tenant.pause"]);
    expect(released).toEqual([]);
  });

  it("releases both leases when pause is not ok so a retry can acquire", async () => {
    const released: string[] = [];
    const calls: string[] = [];
    const result = await pauseOrReleaseProcessingLeases(
      {} as Env,
      HOLD,
      NOW,
      opsDeps({
        released,
        calls,
        tenantPause: { ok: false, reason: "stale_fence" },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "stale_fence" });
    expect(calls).toEqual(["tenant.pause"]);
    expect(released).toEqual(["global", "tenant"]);
  });

  it("releases both leases when global pause fails after tenant restore", async () => {
    const released: string[] = [];
    const calls: string[] = [];
    const result = await pauseOrReleaseProcessingLeases(
      {} as Env,
      HOLD,
      NOW,
      opsDeps({
        released,
        calls,
        tenantPause: { ok: true, fence: "tf", alreadyRunning: false, expiresAtMs: NOW + 1 },
        globalPause: { ok: false, reason: "stale_fence" },
        tenantRenew: { ok: true, fence: "tf", alreadyRunning: false, expiresAtMs: NOW + 1 },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "stale_fence" });
    expect(calls).toEqual(["tenant.pause", "global.pause", "tenant.renew"]);
    expect(released).toEqual(["global", "tenant"]);
  });
});

describe("dead-lease recovery verbs (#256)", () => {
  const OVERDUE = Date.now() - 60_000;

  function seedRow(
    map: Map<string, unknown>,
    id: string,
    opts: { expiresAt: number; inFlight?: boolean; fence?: string },
  ): { fence: string; expiresAt: number } {
    const fence = opts.fence ?? "f_dead";
    map.set(leaseStorageKey(id), { fence, expiresAt: opts.expiresAt, inFlight: opts.inFlight ?? true });
    return { fence, expiresAt: opts.expiresAt };
  }

  it("peek_lease reports an in-flight row without creating one", async () => {
    const map = new Map<string, unknown>();
    seedRow(map, "at_seen", { expiresAt: OVERDUE });
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), tenantEnv());
    expect(await post(guard, { kind: "peek_lease", attemptId: "at_seen" })).toMatchObject({
      ok: true,
      present: true,
      fence: "f_dead",
      in_flight: true,
      expires_at: OVERDUE,
    });
    expect(await post(guard, { kind: "peek_lease", attemptId: "at_missing" })).toEqual({
      ok: true,
      present: false,
    });
    expect([...map.keys()].filter((key) => key.startsWith("lease:"))).toHaveLength(1);
  });

  it("peek_lease reports a corrupt row as absent", async () => {
    const map = new Map<string, unknown>([[leaseStorageKey("at_corrupt"), { fence: 42 }]]);
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), tenantEnv());
    expect(await post(guard, { kind: "peek_lease", attemptId: "at_corrupt" })).toEqual({
      ok: true,
      present: false,
    });
  });

  it("global peek_lease keys by tenant and attempt", async () => {
    const map = new Map<string, unknown>();
    seedRow(map, `${TENANT}:at_g`, { expiresAt: OVERDUE, fence: "f_g" });
    const guard = new GlobalUsageGuard(guardState(memoryStorage(false, map)), globalEnv());
    expect(
      await post(guard, { kind: "peek_lease", tenantId: TENANT, attemptId: "at_g" }),
    ).toMatchObject({ ok: true, present: true, fence: "f_g", in_flight: true });
    expect(
      await post(guard, { kind: "peek_lease", tenantId: TENANT, attemptId: "at_none" }),
    ).toEqual({ ok: true, present: false });
  });

  it("clear_dead_lease deletes an overdue in-flight row with the observed expiresAt", async () => {
    const map = new Map<string, unknown>();
    const row = seedRow(map, "at_dead", { expiresAt: OVERDUE });
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), tenantEnv());
    expect(
      await post(guard, {
        kind: "clear_dead_lease",
        attemptId: "at_dead",
        expectedExpiresAt: row.expiresAt,
      }),
    ).toEqual({ ok: true, cleared: true });
    expect(map.has(leaseStorageKey("at_dead"))).toBe(false);
  });

  it("clear_dead_lease on an absent row is idempotent success", async () => {
    const guard = new TenantUsageGuard(guardState(memoryStorage()), tenantEnv());
    expect(
      await post(guard, { kind: "clear_dead_lease", attemptId: "at_gone", expectedExpiresAt: OVERDUE }),
    ).toEqual({ ok: true, cleared: false });
    expect(await post(guard, { kind: "clear_dead_lease", attemptId: "at_gone" })).toEqual({
      ok: true,
      cleared: false,
    });
  });

  it("clear_dead_lease refuses a row whose expiresAt changed since observation", async () => {
    const map = new Map<string, unknown>();
    seedRow(map, "at_live", { expiresAt: OVERDUE });
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), tenantEnv());
    // A live holder renewed between observation and clear: the row moved.
    expect(
      await post(guard, { kind: "clear_dead_lease", attemptId: "at_live", expectedExpiresAt: OVERDUE - 1 }),
    ).toEqual({ ok: false, reason: "changed" });
    expect(map.has(leaseStorageKey("at_live"))).toBe(true);
  });

  it("clear_dead_lease refuses a row that appeared after an absent observation", async () => {
    const map = new Map<string, unknown>();
    seedRow(map, "at_new", { expiresAt: OVERDUE });
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), tenantEnv());
    expect(await post(guard, { kind: "clear_dead_lease", attemptId: "at_new" })).toEqual({
      ok: false,
      reason: "changed",
    });
    expect(map.has(leaseStorageKey("at_new"))).toBe(true);
  });

  it("clear_dead_lease refuses a paused row — the expiry sweep owns it", async () => {
    const map = new Map<string, unknown>();
    const row = seedRow(map, "at_parked", { expiresAt: OVERDUE, inFlight: false });
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), tenantEnv());
    expect(
      await post(guard, {
        kind: "clear_dead_lease",
        attemptId: "at_parked",
        expectedExpiresAt: row.expiresAt,
      }),
    ).toEqual({ ok: false, reason: "not_in_flight" });
    expect(map.has(leaseStorageKey("at_parked"))).toBe(true);
  });

  it("clear_dead_lease refuses a not-yet-overdue row — the holder may be between heartbeats", async () => {
    const map = new Map<string, unknown>();
    const row = seedRow(map, "at_fresh", { expiresAt: Date.now() + 60_000 });
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), tenantEnv());
    expect(
      await post(guard, {
        kind: "clear_dead_lease",
        attemptId: "at_fresh",
        expectedExpiresAt: row.expiresAt,
      }),
    ).toEqual({ ok: false, reason: "not_overdue" });
    expect(map.has(leaseStorageKey("at_fresh"))).toBe(true);
  });

  it("requireOverdue:false clears a fresh in-flight row for work-state-justified recovery", async () => {
    // Terminal/purged recovery: the proof is the work state, not the holder's
    // pulse, so a row that died seconds after committing is still reclaimable
    // while its TTL has time left.
    const map = new Map<string, unknown>();
    const row = seedRow(map, "at_justdied", { expiresAt: Date.now() + 60_000 });
    const guard = new TenantUsageGuard(guardState(memoryStorage(false, map)), tenantEnv());
    expect(
      await post(guard, {
        kind: "clear_dead_lease",
        attemptId: "at_justdied",
        expectedExpiresAt: row.expiresAt,
        requireOverdue: false,
      }),
    ).toEqual({ ok: true, cleared: true });
    expect(map.has(leaseStorageKey("at_justdied"))).toBe(false);
    // The compare-and-set and in-flight gates still apply without the overdue
    // check: a renewed row refuses, and a paused row still belongs to the
    // expiry sweep.
    const renewed = seedRow(map, "at_renewed", { expiresAt: Date.now() + 120_000 });
    expect(
      await post(guard, {
        kind: "clear_dead_lease",
        attemptId: "at_renewed",
        expectedExpiresAt: renewed.expiresAt - 1,
        requireOverdue: false,
      }),
    ).toEqual({ ok: false, reason: "changed" });
    const parked = seedRow(map, "at_parked2", { expiresAt: Date.now() - 1, inFlight: false });
    expect(
      await post(guard, {
        kind: "clear_dead_lease",
        attemptId: "at_parked2",
        expectedExpiresAt: parked.expiresAt,
        requireOverdue: false,
      }),
    ).toEqual({ ok: false, reason: "not_in_flight" });
  });

  it("global clear_dead_lease keys by tenant and attempt and uses the guard clock", async () => {
    const map = new Map<string, unknown>();
    const row = seedRow(map, `${TENANT}:at_gclear`, { expiresAt: OVERDUE, fence: "f_gc" });
    const guard = new GlobalUsageGuard(guardState(memoryStorage(false, map)), globalEnv());
    expect(
      await post(guard, {
        kind: "clear_dead_lease",
        tenantId: TENANT,
        attemptId: "at_gclear",
        expectedExpiresAt: row.expiresAt,
      }),
    ).toEqual({ ok: true, cleared: true });
    expect(map.has(leaseStorageKey(`${TENANT}:at_gclear`))).toBe(false);
  });

  it("releaseProcessingLeases skips the global side of a null-fence release hold", async () => {
    const released: string[] = [];
    const tenant: TenantUsage = {
      ...failClosedUsage(),
      releaseLease: async () => {
        released.push("tenant");
      },
    };
    const global: GlobalUsage = {
      acquireLease: async () => ({ ok: false, reason: "unavailable" }),
      renewLease: async () => ({ ok: false, reason: "unavailable" }),
      pauseLease: async () => ({ ok: false, reason: "unavailable" }),
      releaseLease: async () => {
        released.push("global");
      },
      peekLease: async () => ({ ok: false, reason: "unavailable" }),
      clearDeadLease: async () => ({ ok: false, reason: "changed" }),
    };
    await releaseProcessingLeases(
      {} as Env,
      {
        tenantId: TENANT,
        attemptId: "at_rel",
        tenantFence: "tf",
        tenantExpiresAtMs: NOW,
        globalFence: null,
        globalExpiresAtMs: null,
      },
      NOW,
      { tenant, global },
    );
    expect(released).toEqual(["tenant"]);
  });

  it("clearOrphanedProcessingLeases compare-and-set clears both sides with the observed expiresAt", async () => {
    const calls: Array<{ side: string; attemptId: string; expected: number }> = [];
    const tenant: TenantUsage = {
      ...failClosedUsage(),
      clearDeadLease: async (attemptId, expectedExpiresAt) => {
        calls.push({ side: "tenant", attemptId, expected: expectedExpiresAt });
        return { ok: true, cleared: true };
      },
    };
    const global: GlobalUsage = {
      acquireLease: async () => ({ ok: false, reason: "unavailable" }),
      renewLease: async () => ({ ok: false, reason: "unavailable" }),
      pauseLease: async () => ({ ok: false, reason: "unavailable" }),
      releaseLease: async () => undefined,
      peekLease: async () => ({ ok: false, reason: "unavailable" }),
      clearDeadLease: async (_tenantId, attemptId, expectedExpiresAt) => {
        calls.push({ side: "global", attemptId, expected: expectedExpiresAt });
        // The holder renewed between observation and clear: the DO refuses.
        return { ok: false, reason: "changed" };
      },
    };
    await clearOrphanedProcessingLeases(
      {} as Env,
      {
        tenantId: TENANT,
        attemptId: "at_overdue",
        tenantFence: "tf",
        tenantExpiresAtMs: NOW - 60_000,
        globalFence: "gf",
        globalExpiresAtMs: NOW - 60_000,
      },
      { tenant, global },
    );
    // Both sides were attempted with the OBSERVED expiry — the CAS fence that
    // makes a live holder's renewal a refusal. A refused global side neither
    // throws nor hides the tenant decision, which is the one callers gate on.
    expect(calls).toEqual([
      { side: "global", attemptId: "at_overdue", expected: NOW - 60_000 },
      { side: "tenant", attemptId: "at_overdue", expected: NOW - 60_000 },
    ]);
  });

  it("clearOrphanedProcessingLeases surfaces a refused tenant clear instead of swallowing it", async () => {
    const tenant: TenantUsage = {
      ...failClosedUsage(),
      clearDeadLease: async () => ({ ok: false, reason: "changed" }),
    };
    const global: GlobalUsage = {
      acquireLease: async () => ({ ok: false, reason: "unavailable" }),
      renewLease: async () => ({ ok: false, reason: "unavailable" }),
      pauseLease: async () => ({ ok: false, reason: "unavailable" }),
      releaseLease: async () => undefined,
      peekLease: async () => ({ ok: false, reason: "unavailable" }),
      clearDeadLease: async () => ({ ok: true, cleared: true }),
    };
    const decision = await clearOrphanedProcessingLeases(
      {} as Env,
      {
        tenantId: TENANT,
        attemptId: "at_moved",
        tenantFence: "tf",
        tenantExpiresAtMs: NOW - 60_000,
        globalFence: "gf",
        globalExpiresAtMs: NOW - 60_000,
      },
      { tenant, global },
    );
    // The stalled-then-resumed race: the tenant row renewed, so the clear
    // refuses and the caller must NOT terminalize on it.
    expect(decision).toEqual({ ok: false, reason: "changed" });
  });

  it("clearOrphanedProcessingLeases skips an absent global row entirely", async () => {
    const calls: string[] = [];
    const tenant: TenantUsage = {
      ...failClosedUsage(),
      clearDeadLease: async () => {
        calls.push("tenant");
        return { ok: true, cleared: false };
      },
    };
    const global: GlobalUsage = {
      acquireLease: async () => ({ ok: false, reason: "unavailable" }),
      renewLease: async () => ({ ok: false, reason: "unavailable" }),
      pauseLease: async () => ({ ok: false, reason: "unavailable" }),
      releaseLease: async () => undefined,
      peekLease: async () => ({ ok: false, reason: "unavailable" }),
      clearDeadLease: async () => {
        calls.push("global");
        return { ok: true, cleared: false };
      },
    };
    await clearOrphanedProcessingLeases(
      {} as Env,
      {
        tenantId: TENANT,
        attemptId: "at_rel",
        tenantFence: "tf",
        tenantExpiresAtMs: NOW,
        globalFence: null,
        globalExpiresAtMs: null,
      },
      { tenant, global },
    );
    expect(calls).toEqual(["tenant"]);
  });

  it("peekProcessingLeaseReleaseHold builds a hold only from an in-flight tenant row", async () => {
    const peeked: Array<{ inFlight: boolean } | null> = [];
    const globalPeeks: Array<boolean | null> = [];
    const makeDeps = (row: { fence: string; expiresAtMs: number; inFlight: boolean } | null) => ({
      tenant: {
        ...failClosedUsage(),
        peekLease: async () => {
          peeked.push(row === null ? null : { inFlight: row.inFlight });
          if (row === null) return { ok: true, present: false } as const;
          return {
            ok: true,
            present: true,
            fence: row.fence,
            expiresAtMs: row.expiresAtMs,
            inFlight: row.inFlight,
          } as const;
        },
      },
      global: {
        acquireLease: async () => ({ ok: false, reason: "unavailable" }),
        renewLease: async () => ({ ok: false, reason: "unavailable" }),
        pauseLease: async () => ({ ok: false, reason: "unavailable" }),
        releaseLease: async () => undefined,
        clearDeadLease: async () => ({ ok: false, reason: "changed" }),
        peekLease: async () => {
          globalPeeks.push(null);
          return {
            ok: true,
            present: true,
            fence: "gf",
            expiresAtMs: NOW,
            inFlight: true,
          } as const;
        },
      } as GlobalUsage,
    });

    const hold = await peekProcessingLeaseReleaseHold(
      {} as Env,
      TENANT,
      "at_orphan",
      makeDeps({ fence: "tf", expiresAtMs: NOW - 5_000, inFlight: true }),
    );
    expect(hold).toEqual({
      tenantId: TENANT,
      attemptId: "at_orphan",
      tenantFence: "tf",
      tenantExpiresAtMs: NOW - 5_000,
      globalFence: "gf",
      globalExpiresAtMs: NOW,
    });

    // Absent and paused tenant rows yield null without touching the global.
    expect(
      await peekProcessingLeaseReleaseHold({} as Env, TENANT, "at_absent", makeDeps(null)),
    ).toBeNull();
    expect(
      await peekProcessingLeaseReleaseHold(
        {} as Env,
        TENANT,
        "at_parked",
        makeDeps({ fence: "tf", expiresAtMs: NOW, inFlight: false }),
      ),
    ).toBeNull();
    expect(globalPeeks).toHaveLength(1);
  });
});
