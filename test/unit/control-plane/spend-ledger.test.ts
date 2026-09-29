import { describe, expect, it } from "vitest";
import {
  markSpendDispatched,
  releaseSpend,
  reserveSpend,
  settleSpend,
  sweepExpiredSpend,
  utcSpendDay,
  utcSpendDayResetAt,
  type SpendQuote,
} from "../../../src/control-plane/spend-ledger";

const limits = {globalMicrodollars:1000, tenantMicrodollars:1000};
const NOW = Date.parse("2026-09-05T23:59:00.000Z");
const quote = (overrides: Partial<SpendQuote> = {}): SpendQuote => ({
  dayKey: utcSpendDay(NOW),
  catalogVersion: 4,
  requestFingerprint: "sha256:request-a",
  maxMicrodollars: 100,
  ...overrides,
});

function storage(map = new Map<string, unknown>()): DurableObjectStorage {
  return {
    get: async (key: string) => map.get(key),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") map.set(key, value);
      else for (const [entryKey, entryValue] of Object.entries(key)) map.set(entryKey, entryValue);
    },
    delete: async (key: string) => void map.delete(key),
    list: async (opts?: { prefix?: string }) => new Map([...map].filter(([key]) => !opts?.prefix || key.startsWith(opts.prefix))),
    transaction: async <T>(callback: (tx: DurableObjectStorage) => Promise<T>) => callback(storage(map)),
  } as unknown as DurableObjectStorage;
}

describe("spend ledger", () => {
  it("holds a maximum then settles actual usage atomically and idempotently", async () => {
    const map = new Map<string, unknown>();
    const book = storage(map);
    expect(await reserveSpend(book, { payer:"tenant", tenantId:"tenant", tenantLimitMicrodollars:1000, opKey: "spend:op:one", quote: quote(), policyVersion: 7, limitMicrodollars: 150 })).toEqual({
      ok: true,
      state: "reserved",
    });
    expect(map.get(`spend:day:${quote().dayKey}`)).toEqual({ microdollars: 100 });
    expect(await markSpendDispatched(book, { limits, opKey: "spend:op:one", quote: quote() })).toEqual({
      ok: true,
      state: "dispatched",
      fresh: true,
    });
    expect(await settleSpend(book, { opKey: "spend:op:one", quote: quote(), actualMicrodollars: 37 })).toEqual({
      ok: true,
      state: "settled",
    });
    expect(map.get(`spend:day:${quote().dayKey}`)).toEqual({ microdollars: 37 });
    expect(await settleSpend(book, { opKey: "spend:op:one", quote: quote(), actualMicrodollars: 37 })).toEqual({
      ok: true,
      state: "settled",
    });
  });

  it("permits dispatch exactly once and keeps an unknown dispatched maximum", async () => {
    const map = new Map<string, unknown>();
    const book = storage(map);
    await reserveSpend(book, { payer:"tenant", tenantId:"tenant", tenantLimitMicrodollars:1000, opKey: "spend:op:one", quote: quote(), policyVersion: 7, limitMicrodollars: 100 });
    expect(await markSpendDispatched(book, { limits, opKey: "spend:op:one", quote: quote() })).toEqual({
      ok: true,
      state: "dispatched",
      fresh: true,
    });
    expect(await markSpendDispatched(book, { limits, opKey: "spend:op:one", quote: quote() })).toEqual({
      ok: true,
      state: "dispatched",
      fresh: false,
    });
    expect(await releaseSpend(book, { opKey: "spend:op:one", quote: quote() })).toEqual({ ok: true, state: "dispatched" });
    expect(map.get(`spend:day:${quote().dayKey}`)).toEqual({ microdollars: 100 });
  });

  it("does not create a cancellation record for a missing operation", async () => {
    const map = new Map<string, unknown>();
    expect(await releaseSpend(storage(map), {opKey:"missing",quote:quote()})).toEqual({ok:true,state:"released"});
    expect(map.size).toBe(0);
  });

  it("rejects quote reuse, caps actual use, and reports a UTC reset", async () => {
    const book = storage();
    await reserveSpend(book, { payer:"tenant", tenantId:"tenant", tenantLimitMicrodollars:1000, opKey: "spend:op:one", quote: quote(), policyVersion: 7, limitMicrodollars: 100 });
    expect(await reserveSpend(book, { payer:"tenant", tenantId:"tenant", tenantLimitMicrodollars:1000, opKey: "spend:op:one", quote: quote({ maxMicrodollars: 99 }), policyVersion: 7, limitMicrodollars: 100 })).toEqual({
      ok: false,
      reason: "operation_conflict",
    });
    await markSpendDispatched(book, { limits, opKey: "spend:op:one", quote: quote() });
    expect(await settleSpend(book, { opKey: "spend:op:one", quote: quote(), actualMicrodollars: 101 })).toEqual({
      ok: false,
      reason: "actual_exceeds_max",
    });
    expect(await reserveSpend(book, { payer:"tenant", tenantId:"tenant", tenantLimitMicrodollars:1000, opKey: "spend:op:two", quote: quote({ requestFingerprint: "sha256:two", maxMicrodollars: 1 }), policyVersion: 7, limitMicrodollars: 100 })).toEqual({
      ok: false,
      reason: "daily_spend",
      resetAtMs: utcSpendDayResetAt(NOW),
    });
  });

  it("records who pays and refuses a replay that names the other payer", async () => {
    const map = new Map<string, unknown>();
    const book = storage(map);
    const reserve = (payer: "tenant" | "operator") => reserveSpend(book, { payer, tenantId:"tenant", tenantLimitMicrodollars:1000, opKey: "spend:op:one", quote: quote(), policyVersion: 7, limitMicrodollars: 1000 });
    expect(await reserve("operator")).toEqual({ ok: true, state: "reserved" });
    expect(map.get("spend:op:one")).toMatchObject({ payer: "operator", state: "reserved" });
    expect(await reserve("tenant")).toEqual({ ok: false, reason: "operation_conflict" });
    expect(map.get(`spend:day:${quote().dayKey}`)).toEqual({ microdollars: 100 });
    await markSpendDispatched(book, { limits, opKey: "spend:op:one", quote: quote(), nowMs: NOW });
    await settleSpend(book, { opKey: "spend:op:one", quote: quote(), actualMicrodollars: 40 });
    expect(map.get("spend:op:one")).toMatchObject({ payer: "operator", state: "settled" });
  });

  it("fails closed on a corrupt aggregate counter and never underflows it", async () => {
    const map = new Map<string, unknown>([[`spend:day:${quote().dayKey}`, { microdollars: "bad" }]]);
    const book = storage(map);
    expect(await reserveSpend(book, { payer:"tenant", tenantId:"tenant", tenantLimitMicrodollars:1000, opKey: "spend:op:bad", quote: quote(), policyVersion: 7, limitMicrodollars: 100 })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    map.set("spend:op:one", { quote: quote(), policyVersion: 7, state: "reserved" });
    map.set(`spend:day:${quote().dayKey}`, { microdollars: 99 });
    expect(await releaseSpend(book, { opKey: "spend:op:one", quote: quote() })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("expires only an undispatched reservation, refunds it, and denies a late mark", async () => {
    const map = new Map<string, unknown>();
    const book = storage(map);
    await reserveSpend(book, { payer:"tenant", tenantId:"tenant", tenantLimitMicrodollars:1000, opKey: "spend:op:expired", quote: quote(), policyVersion: 7, limitMicrodollars: 100, expiresAtMs: 10 });
    expect(await sweepExpiredSpend(book, 10)).toBe(Date.parse("2026-09-07T00:00:00Z"));
    expect(map.get(`spend:day:${quote().dayKey}`)).toEqual({ microdollars: 0 });
    expect(await markSpendDispatched(book, { limits, opKey: "spend:op:expired", quote: quote(), nowMs: 10 })).toMatchObject({ ok: false });
  });

  it("does not expire a dispatched maximum", async () => {
    const map = new Map<string, unknown>();
    const book = storage(map);
    await reserveSpend(book, { payer:"tenant", tenantId:"tenant", tenantLimitMicrodollars:1000, opKey: "spend:op:live", quote: quote(), policyVersion: 7, limitMicrodollars: 100, expiresAtMs: 10 });
    await markSpendDispatched(book, { limits, opKey: "spend:op:live", quote: quote(), nowMs: 9 });
    await sweepExpiredSpend(book, 10);
    expect(map.get(`spend:day:${quote().dayKey}`)).toEqual({ microdollars: 100 });
    expect(map.get("spend:op:live")).toMatchObject({ state: "dispatched" });
  });
  it("updates both budgets together through release, expiry, and late settlement", async () => {
    const map = new Map<string,unknown>();
    const book = storage(map);
    const reserve = (opKey:string, q=quote()) => reserveSpend(book,{opKey,quote:q,policyVersion:1,payer:"tenant",
      tenantId:"tenant",tenantLimitMicrodollars:100,limitMicrodollars:200,expiresAtMs:NOW+600000});
    await reserve("a");
    expect(map.get(`spend:tenant:tenant:day:${quote().dayKey}`)).toEqual({microdollars:100});
    expect(await reserve("b")).toMatchObject({ok:false,reason:"daily_spend"});
    expect(map.get(`spend:day:${quote().dayKey}`)).toEqual({microdollars:100});
    await releaseSpend(book,{opKey:"a",quote:quote()});
    expect(map.get(`spend:tenant:tenant:day:${quote().dayKey}`)).toEqual({microdollars:0});
    await reserve("c");
    await markSpendDispatched(book,{limits,opKey:"c",quote:quote(),nowMs:NOW});
    const tomorrow=quote({dayKey:"2026-09-06"});
    await reserve("d",tomorrow);
    await settleSpend(book,{opKey:"c",quote:quote(),actualMicrodollars:7});
    expect(map.get(`spend:day:${quote().dayKey}`)).toEqual({microdollars:7});
    expect(map.get(`spend:tenant:tenant:day:${quote().dayKey}`)).toEqual({microdollars:7});
    expect(map.get("spend:day:2026-09-06")).toEqual({microdollars:100});
    await sweepExpiredSpend(book,NOW+600000);
    expect(map.get("spend:tenant:tenant:day:2026-09-06")).toEqual({microdollars:0});
  });

  it("discards old operation records without refunding uncertain charges", async () => {
    const map = new Map<string,unknown>();
    const book = storage(map);
    await reserveSpend(book,{payer:"tenant",tenantId:"tenant",tenantLimitMicrodollars:1000,opKey:"a",quote:quote(),policyVersion:1,limitMicrodollars:100,expiresAtMs:NOW+600000});
    await markSpendDispatched(book,{limits,opKey:"a",quote:quote(),nowMs:NOW});
    await sweepExpiredSpend(book,Date.parse("2026-09-07T00:00:00Z"));
    expect(map.has("a")).toBe(false);
    expect(map.get(`spend:day:${quote().dayKey}`)).toEqual({microdollars:100});
    expect(await settleSpend(book,{opKey:"a",quote:quote(),actualMicrodollars:0})).toMatchObject({ok:false});
  });

});
