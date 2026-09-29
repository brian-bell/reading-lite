import { describe, expect, it, vi } from "vitest";
import { GlobalUsageGuard } from "../../../src/control-plane/global-usage-guard";
import { utcSpendDay } from "../../../src/control-plane/spend-ledger";
import type { Env } from "../../../src/index";
import { fakeHyperdrive } from "../../helpers/fake-control-plane";

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
  return { HYPERDRIVE: fakeHyperdrive(row) } as Env;
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
      env({ status: "active", daily_spend_microdollars: 50, tenant_daily_spend_microdollars: 50, paid_work_enabled: true, policy_version: 8, catalog_version: 3 }),
    );
    expect(await post(guard, { kind: "reserve_spend", payer: "tenant", tenantId: TENANT, opId: "dispatch-1", quote, nowMs: NOW })).toEqual({
      ok: true,
      state: "reserved",
    });
    expect(await post(guard, { kind: "reserve_spend", payer: "tenant", tenantId: TENANT, opId: "dispatch-2", quote: { ...quote, requestFingerprint: "sha256:two", maxMicrodollars: 1 }, nowMs: NOW })).toMatchObject({
      ok: false,
      reason: "daily_spend",
    });
    expect(await post(guard, { kind: "reserve_spend", payer: "tenant", tenantId: TENANT, opId: "dispatch-3", quote: { ...quote, catalogVersion: 2 }, nowMs: NOW })).toEqual({
      ok: false,
      reason: "catalog_version",
    });
  });

  it("fails global reservations closed while its nullable budget is unset and rejects a deleting user", async () => {
    const unset = new GlobalUsageGuard(
      state(storage()),
      env({ status: "active", daily_spend_microdollars: null, policy_version: 8, catalog_version: 3 }),
    );
    expect(await post(unset, { kind: "reserve_spend", payer: "tenant", tenantId: TENANT, opId: "dispatch-1", quote, nowMs: NOW })).toEqual({
      ok: false,
      reason: "missing_limits",
    });
    const deleting = new GlobalUsageGuard(
      state(storage()),
      env({ status: "deleting", daily_spend_microdollars: 100, policy_version: 8, catalog_version: 3 }),
    );
    expect(await post(deleting, { kind: "reserve_spend", payer: "tenant", tenantId: TENANT, opId: "dispatch-1", quote, nowMs: NOW })).toEqual({
      ok: false,
      reason: "deleted_tenant",
    });
  });

  it("rejects a stale admission day even when the caller replays its old clock", async () => {
    const map = new Map<string,unknown>();
    const guard = new GlobalUsageGuard(state(storage(map)),env({status:"active",daily_spend_microdollars:100,
      tenant_daily_spend_microdollars:100,paid_work_enabled:true,policy_version:1,catalog_version:3}));
    const yesterday=NOW-86400000;
    expect(await post(guard,{kind:"reserve_spend",payer:"tenant",tenantId:TENANT,opId:"old",
      quote:{...quote,dayKey:utcSpendDay(yesterday)},nowMs:yesterday})).toMatchObject({ok:false,reason:"operation_conflict"});
    expect(map.size).toBe(0);
  });

  it("replays a live reservation across UTC midnight without charging again or extending it", async () => {
    const before = Date.parse("2026-09-05T23:59:59Z");
    const clock = vi.spyOn(Date,"now").mockReturnValue(before);
    try {
      const map = new Map<string,unknown>();
      const guard = new GlobalUsageGuard(state(storage(map)),env({status:"active",daily_spend_microdollars:50,
        tenant_daily_spend_microdollars:50,paid_work_enabled:true,policy_version:1,catalog_version:3}));
      const originalQuote = {...quote,dayKey:utcSpendDay(before)};
      const body = {kind:"reserve_spend",payer:"tenant",tenantId:TENANT,opId:"midnight",quote:originalQuote,nowMs:before};
      const key = `spend:op:${TENANT}:midnight`;
      expect(await post(guard,body)).toMatchObject({ok:true,state:"reserved"});
      const original = structuredClone(map.get(key));
      clock.mockReturnValue(before+2000);
      expect(await post(guard,body)).toMatchObject({ok:true,state:"reserved"});
      expect(map.get(key)).toEqual(original);
      expect(map.get(`spend:day:${originalQuote.dayKey}`)).toEqual({microdollars:50});
      expect(map.get(`spend:tenant:${TENANT}:day:${originalQuote.dayKey}`)).toEqual({microdollars:50});
      expect(map.has(`spend:day:${utcSpendDay(before+2000)}`)).toBe(false);
      expect(await post(guard,{...body,quote:{...originalQuote,maxMicrodollars:49}})).toMatchObject({ok:false,reason:"operation_conflict"});
      expect(await post(guard,{...body,kind:"mark_spend_dispatched"})).toMatchObject({ok:true,state:"dispatched",fresh:true});
      expect(await post(guard,body)).toMatchObject({ok:true,state:"dispatched"});
    } finally { clock.mockRestore(); }
  });

  it("does not recreate released or removed operations from yesterday's quote", async () => {
    const before = Date.parse("2026-09-05T23:59:59Z");
    const clock = vi.spyOn(Date,"now").mockReturnValue(before);
    try {
      const map = new Map<string,unknown>();
      const guard = new GlobalUsageGuard(state(storage(map)),env({status:"active",daily_spend_microdollars:50,
        tenant_daily_spend_microdollars:50,paid_work_enabled:true,policy_version:1,catalog_version:3}));
      const originalQuote = {...quote,dayKey:utcSpendDay(before)};
      const body = {kind:"reserve_spend",payer:"tenant",tenantId:TENANT,opId:"released",quote:originalQuote,nowMs:before};
      await post(guard,body);
      await post(guard,{...body,kind:"release_spend"});
      clock.mockReturnValue(before+2000);
      expect(await post(guard,body)).toMatchObject({ok:false,reason:"operation_conflict"});
      const key = `spend:op:${TENANT}:released`;
      map.delete(key); // A record removed by retention or teardown must stay absent.
      expect(await post(guard,body)).toMatchObject({ok:false,reason:"operation_conflict"});
      expect(map.has(key)).toBe(false);
      expect(map.get(`spend:day:${originalQuote.dayKey}`)).toEqual({microdollars:0});
    } finally { clock.mockRestore(); }
  });

  it("requires and records who pays for a reservation", async () => {
    const map = new Map<string, unknown>();
    const guard = new GlobalUsageGuard(
      state(storage(map)),
      env({ status: "active", daily_spend_microdollars: 50, tenant_daily_spend_microdollars: 50, paid_work_enabled: true, policy_version: 8, catalog_version: 3 }),
    );
    const body = { kind: "reserve_spend", tenantId: TENANT, opId: "dispatch-1", quote, nowMs: NOW };
    expect(await post(guard, body)).toEqual({ error: "invalid_body" });
    expect(await post(guard, { ...body, payer: "someone" })).toEqual({ error: "invalid_body" });
    expect(map.size).toBe(0);
    expect(await post(guard, { ...body, payer: "operator" })).toEqual({ ok: true, state: "reserved" });
    expect(map.get(`spend:op:${TENANT}:dispatch-1`)).toMatchObject({ payer: "operator", tenantId: TENANT });
  });

  it.each(["daily_spend_microdollars", "tenant_daily_spend_microdollars", "user_daily_spend_cap_microdollars"])(
    "denies dispatch when %s is tightened below the reserved aggregate", async (limit) => {
      const map = new Map<string, unknown>();
      const policy = {status:"active",daily_spend_microdollars:100,tenant_daily_spend_microdollars:100,
        paid_work_enabled:true,policy_version:1,catalog_version:3};
      const guard = new GlobalUsageGuard(state(storage(map)),env(policy));
      const identity = {tenantId:TENANT,opId:"held",quote};
      await post(guard,{...identity,kind:"reserve_spend",payer:"tenant",nowMs:NOW});
      await post(guard,{...identity,opId:"other",quote:{...quote,maxMicrodollars:20},kind:"reserve_spend",payer:"tenant",nowMs:NOW});
      policy[limit as "daily_spend_microdollars"] = 60; // This request fits; the aggregate 70 does not.
      expect(await post(guard,{...identity,kind:"mark_spend_dispatched"})).toMatchObject({ok:false,reason:"daily_spend"});
      expect(map.get(`spend:op:${TENANT}:held`)).toMatchObject({state:"reserved"});
      expect(await post(guard,{...identity,kind:"release_spend"})).toMatchObject({ok:true,state:"released"});
      expect(map.get(`spend:day:${quote.dayKey}`)).toEqual({microdollars:20});
      expect(map.get(`spend:tenant:${TENANT}:day:${quote.dayKey}`)).toEqual({microdollars:20});
    });

  it.each([50, 60])("allows dispatch when both tightened caps still cover usage (%i)", async (limit) => {
    const policy = {status:"active",daily_spend_microdollars:100,tenant_daily_spend_microdollars:100,
      paid_work_enabled:true,policy_version:1,catalog_version:3};
    const guard = new GlobalUsageGuard(state(storage()),env(policy));
    const identity = {tenantId:TENANT,opId:"fits",quote};
    await post(guard,{...identity,kind:"reserve_spend",payer:"tenant",nowMs:NOW});
    policy.daily_spend_microdollars = policy.tenant_daily_spend_microdollars = limit;
    expect(await post(guard,{...identity,kind:"mark_spend_dispatched"})).toMatchObject({ok:true,state:"dispatched",fresh:true});
  });

  it("keeps dispatched replay and settlement idempotent after both caps are lowered", async () => {
    const map = new Map<string,unknown>();
    const policy = {status:"active",daily_spend_microdollars:100,tenant_daily_spend_microdollars:100,
      paid_work_enabled:true,policy_version:1,catalog_version:3};
    const guard = new GlobalUsageGuard(state(storage(map)),env(policy));
    const identity = {tenantId:TENANT,opId:"sent",quote};
    await post(guard,{...identity,kind:"reserve_spend",payer:"tenant",nowMs:NOW});
    expect(await post(guard,{...identity,kind:"mark_spend_dispatched"})).toMatchObject({ok:true,fresh:true});
    policy.daily_spend_microdollars = policy.tenant_daily_spend_microdollars = 1;
    expect(await post(guard,{...identity,kind:"mark_spend_dispatched"})).toMatchObject({ok:true,state:"dispatched",fresh:false});
    expect(map.get(`spend:day:${quote.dayKey}`)).toEqual({microdollars:50});
    expect(await post(guard,{...identity,kind:"settle_spend",actualMicrodollars:10})).toMatchObject({ok:true,state:"settled"});
    expect(await post(guard,{...identity,kind:"mark_spend_dispatched"})).toMatchObject({ok:true,state:"settled",fresh:false});
    expect(map.get(`spend:day:${quote.dayKey}`)).toEqual({microdollars:10});
  });

  it("serializes concurrent tenant reserves at the cap", async () => {
    const guard = new GlobalUsageGuard(
      state(storage()),
      env({ status: "active", daily_spend_microdollars: 50, tenant_daily_spend_microdollars: 50, paid_work_enabled: true, policy_version: 8, catalog_version: 3 }),
    );
    const results = await Promise.all(
      ["one", "two", "three"].map((opId) =>
        post(guard, {
          kind: "reserve_spend", payer: "tenant",
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

  it("shares the global cap across tenants without charging denied reservations", async () => {
    const otherTenant = "usr_660e8400-e29b-41d4-a716-446655440000";
    const map = new Map<string, unknown>();
    const guard = new GlobalUsageGuard(state(storage(map)), env({
      status: "active", daily_spend_microdollars: 75, tenant_daily_spend_microdollars: 200,
      paid_work_enabled: true, policy_version: 8, catalog_version: 3,
    }));
    const reserve = (tenantId: string, opId: string, amount: number) => post(guard, {
      kind: "reserve_spend", payer: "tenant", tenantId, opId,
      quote: { ...quote, maxMicrodollars: amount }, nowMs: NOW,
    });

    expect(await reserve(TENANT, "first", 50)).toMatchObject({ ok: true, state: "reserved" });
    expect(await reserve(otherTenant, "fits", 25)).toMatchObject({ ok: true, state: "reserved" });
    expect(map.get(`spend:day:${quote.dayKey}`)).toEqual({ microdollars: 75 });
    expect(map.get(`spend:tenant:${TENANT}:day:${quote.dayKey}`)).toEqual({ microdollars: 50 });
    expect(map.get(`spend:tenant:${otherTenant}:day:${quote.dayKey}`)).toEqual({ microdollars: 25 });
    const beforeDenial = structuredClone(map);

    // Both tenants have individual headroom; only the shared global cap is full.
    expect(await reserve(otherTenant, "denied", 1)).toMatchObject({ ok: false, reason: "daily_spend" });
    expect(map).toEqual(beforeDenial);
    expect(map.has(`spend:op:${otherTenant}:denied`)).toBe(false);
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
  return { HYPERDRIVE: fakeHyperdrive(() => row()) } as Env;
}
