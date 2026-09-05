import { describe, expect, it } from "vitest";
import { GlobalUsageGuard } from "../../../src/control-plane/global-usage-guard";
import { utcSpendDay } from "../../../src/control-plane/spend-ledger";
import type { Env } from "../../../src/index";

const TENANT = "usr_550e8400-e29b-41d4-a716-446655440000";
const NOW = Date.now();
const quote = { dayKey: utcSpendDay(NOW), catalogVersion: 3, requestFingerprint: "sha256:request", maxMicrodollars: 50 };

function storage(map = new Map<string, unknown>()): DurableObjectStorage {
  let alarm: number | null = null;
  return {
    get: async (key: string) => map.get(key),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") map.set(key, value);
      else for (const [entryKey, entryValue] of Object.entries(key)) map.set(entryKey, entryValue);
    },
    delete: async (key: string) => void map.delete(key),
    list: async (opts?: { prefix?: string }) => new Map([...map].filter(([key]) => !opts?.prefix || key.startsWith(opts.prefix))),
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => void (alarm = at),
    deleteAlarm: async () => void (alarm = null),
    transaction: async <T>(callback: (tx: DurableObjectStorage) => Promise<T>) => callback(storage(map)),
  } as unknown as DurableObjectStorage;
}

function state(store: DurableObjectStorage): DurableObjectState {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    storage: store,
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

function env(row: Record<string, unknown> | null): Env {
  return { CONTROL_PLANE: { prepare: () => ({ bind: () => ({ first: async () => row }) }) } as unknown as D1Database } as Env;
}

async function post(guard: { fetch(request: Request): Promise<Response> }, body: unknown): Promise<Record<string, unknown>> {
  const response = await guard.fetch(
    new Request("https://usage-guard/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  );
  return (await response.json()) as Record<string, unknown>;
}

describe("spend guard RPCs", () => {
  it("enforces tenant budget and catalog before creating a reservation", async () => {
    const guard = new GlobalUsageGuard(
      state(storage()),
      env({ status: "active", daily_spend_microdollars: 50, tenant_daily_spend_microdollars: 50, paid_work_enabled: 1, policy_version: 8, catalog_version: 3 }),
    );
    expect(await post(guard, { kind: "reserve_spend", tenantId: TENANT, opId: "dispatch-1", quote, nowMs: NOW })).toEqual({
      ok: true,
      state: "reserved",
    });
    expect(await post(guard, { kind: "reserve_spend", tenantId: TENANT, opId: "dispatch-2", quote: { ...quote, requestFingerprint: "sha256:two", maxMicrodollars: 1 }, nowMs: NOW })).toMatchObject({
      ok: false,
      reason: "daily_spend",
    });
    expect(await post(guard, { kind: "reserve_spend", tenantId: TENANT, opId: "dispatch-3", quote: { ...quote, catalogVersion: 2 }, nowMs: NOW })).toEqual({
      ok: false,
      reason: "catalog_version",
    });
  });

  it("fails global reservations closed while its nullable budget is unset and rejects a deleting user", async () => {
    const unset = new GlobalUsageGuard(
      state(storage()),
      env({ status: "active", daily_spend_microdollars: null, policy_version: 8, catalog_version: 3 }),
    );
    expect(await post(unset, { kind: "reserve_spend", tenantId: TENANT, opId: "dispatch-1", quote, nowMs: NOW })).toEqual({
      ok: false,
      reason: "missing_limits",
    });
    const deleting = new GlobalUsageGuard(
      state(storage()),
      env({ status: "deleting", daily_spend_microdollars: 100, policy_version: 8, catalog_version: 3 }),
    );
    expect(await post(deleting, { kind: "reserve_spend", tenantId: TENANT, opId: "dispatch-1", quote, nowMs: NOW })).toEqual({
      ok: false,
      reason: "deleted_tenant",
    });
  });

  it("rejects a stale admission day even when the caller replays its old clock", async () => {
    const map = new Map<string,unknown>();
    const guard = new GlobalUsageGuard(state(storage(map)),env({status:"active",daily_spend_microdollars:100,
      tenant_daily_spend_microdollars:100,paid_work_enabled:1,policy_version:1,catalog_version:3}));
    const yesterday=NOW-86400000;
    expect(await post(guard,{kind:"reserve_spend",tenantId:TENANT,opId:"old",
      quote:{...quote,dayKey:utcSpendDay(yesterday)},nowMs:yesterday})).toMatchObject({ok:false,reason:"operation_conflict"});
    expect(map.size).toBe(0);
  });

  it("serializes concurrent tenant reserves at the cap", async () => {
    const guard = new GlobalUsageGuard(
      state(storage()),
      env({ status: "active", daily_spend_microdollars: 50, tenant_daily_spend_microdollars: 50, paid_work_enabled: 1, policy_version: 8, catalog_version: 3 }),
    );
    const results = await Promise.all(
      ["one", "two", "three"].map((opId) =>
        post(guard, {
          kind: "reserve_spend",
          tenantId: TENANT,
          opId,
          quote: { ...quote, requestFingerprint: `sha256:${opId}`, maxMicrodollars: 25 },
          nowMs: NOW,
        }),
      ),
    );
    expect(results.filter((result) => result.ok === true)).toHaveLength(2);
    expect(results.filter((result) => result.reason === "daily_spend")).toHaveLength(1);
  });

  it("purges only one tenant's global operations, retains aggregate spend, and fences a late release", async () => {
    const otherTenant = "usr_660e8400-e29b-41d4-a716-446655440000";
    const storeMap = new Map<string, unknown>([
      [
        `spend:op:${TENANT}:one`,
        { quote, policyVersion: 8, state: "dispatched" },
      ],
      [
        `spend:op:${TENANT}:reserved`,
        { quote: { ...quote, requestFingerprint: "sha256:reserved", maxMicrodollars: 25 }, policyVersion: 8, state: "reserved", expiresAtMs: Number.MAX_SAFE_INTEGER },
      ],
      [
        `spend:op:${otherTenant}:two`,
        { quote: { ...quote, requestFingerprint: "sha256:other" }, policyVersion: 8, state: "dispatched" },
      ],
      [`spend:day:${quote.dayKey}`, { microdollars: 125 }],
    ]);
    let row: Record<string, unknown> | null = { status: "active", daily_spend_microdollars: 100, policy_version: 8, catalog_version: 3 };
    const guard = new GlobalUsageGuard(state(storage(storeMap)), envProxy(() => row));
    expect(await post(guard, { kind: "purge_tenant", tenantId: TENANT })).toMatchObject({ ok: true });
    expect(storeMap.has(`spend:op:${TENANT}:one`)).toBe(false);
    expect(storeMap.has(`spend:op:${TENANT}:reserved`)).toBe(false);
    expect(storeMap.get(`spend:op:${otherTenant}:two`)).toMatchObject({ state: "dispatched" });
    expect(storeMap.get(`spend:day:${quote.dayKey}`)).toEqual({ microdollars: 100 });
    row = null;
    expect(await post(guard, { kind: "release_spend", tenantId: TENANT, opId: "late", quote })).toEqual({
      ok: false,
      reason: "deleted_tenant",
    });
    expect(storeMap.has(`spend:op:${TENANT}:late`)).toBe(false);
  });
});

function envProxy(row: () => Record<string, unknown> | null): Env {
  return { CONTROL_PLANE: { prepare: () => ({ bind: () => ({ first: async () => row() }) }) } as unknown as D1Database } as Env;
}
