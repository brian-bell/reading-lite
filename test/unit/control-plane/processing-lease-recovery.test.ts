import { describe, expect, it } from "vitest";
import type { Env } from "../../../src/index";
import { GlobalUsageGuard } from "../../../src/control-plane/global-usage-guard";
import { TenantUsageGuard } from "../../../src/control-plane/tenant-usage-guard";
import { acquireLease, renewLease, pauseLease, releaseLease, sweepExpiredLeases } from "../../../src/control-plane/processing-lease-state";
import { recoverProcessingLeases } from "../../../src/control-plane/processing-lease-recovery";

const TENANT = "usr_550e8400-e29b-41d4-a716-446655440000";
const ATTEMPT = "at_recover";
const EXPIRED = Date.now() - 60_000;
function book() {
  const rows = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => rows.get(key),
    put: async (key: string, value: unknown) => { rows.set(key, value); },
    delete: async (key: string) => rows.delete(key),
    list: async (opts: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(opts.prefix))),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  } as unknown as DurableObjectStorage;
  let tail = Promise.resolve<unknown>(undefined);
  const state = { storage, blockConcurrencyWhile: <T>(fn: () => Promise<T>) => {
    const result = tail.then(fn, fn);
    tail = result.catch(() => {});
    return result;
  } } as DurableObjectState;
  return { rows, storage, state };
}
function fixture(options: { tenant?: boolean; global?: boolean; tenantExpiry?: number; globalExpiry?: number; paused?: boolean } = {}) {
  const tenant = book();
  const global = book();
  const row = (expiresAt: number) => ({ fence: "original", expiresAt, inFlight: !options.paused });
  if (options.tenant !== false) tenant.rows.set(`lease:${ATTEMPT}`, row(options.tenantExpiry ?? EXPIRED));
  if (options.global !== false) global.rows.set(`lease:${TENANT}:${ATTEMPT}`, row(options.globalExpiry ?? EXPIRED));
  const tenantGuard = new TenantUsageGuard(tenant.state, {} as Env);
  const calls: string[] = [];
  let intercept = async (_body: Record<string, unknown>, next: () => Promise<Response>) => next();
  const tenantNs = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push(body.kind);
      return intercept(body, () => tenantGuard.fetch(new Request(url, init)));
    } }),
  } as unknown as DurableObjectNamespace;
  const globalGuard = new GlobalUsageGuard(global.state, { TENANT_USAGE_GUARD: tenantNs } as Env);
  const env = { GLOBAL_USAGE_GUARD: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (url: string, init: RequestInit) => globalGuard.fetch(new Request(url, init)) }),
  } } as unknown as Env;
  return { tenant, global, env, calls, globalGuard,
    intercept(fn: typeof intercept) { intercept = fn; },
    recover: (opts = {}) => recoverProcessingLeases(env, TENANT, ATTEMPT, opts),
  };
}

describe("paired lease recovery", () => {
  it.each([{ tenant: true, global: true }, { tenant: false, global: true },
    { tenant: true, global: false }, { tenant: false, global: false }])(
    "recovers every partial state and prevents old-attempt reacquisition: %j", async options => {
      const f = fixture(options);
      expect(await f.recover()).toMatchObject({ kind: "completed" });
      expect(f.tenant.rows.has(`lease:${ATTEMPT}`)).toBe(false);
      expect(f.global.rows.size).toBe(0);
      expect(await f.recover()).toMatchObject({ kind: "completed", result: {
        tenant: { ok: true, cleared: false }, global: { ok: true, cleared: false },
      } });
      const opts = { id: ATTEMPT, nowMs: Date.now(), limit: 1, fence: "original" };
      expect(await acquireLease(f.tenant.storage, opts)).toEqual({ ok: false, reason: "stale_fence" });
      expect(await renewLease(f.tenant.storage, opts)).toEqual({ ok: false, reason: "stale_fence" });
      await releaseLease(f.tenant.storage, opts);
      await sweepExpiredLeases(f.tenant.storage, Date.now() + 100_000_000);
      expect(await acquireLease(f.tenant.storage, opts)).toEqual({ ok: false, reason: "stale_fence" });
      expect(await acquireLease(f.tenant.storage, { ...opts, id: "at_new" })).toMatchObject({ ok: true });
    },
  );

  it.each(["tenant", "global"] as const)("a fresh %s refuses the whole pair", async side => {
    const f = fixture({ [`${side}Expiry`]: Date.now() + 60_000 });
    expect(await f.recover()).toMatchObject({ kind: "refused", result: { [side]: { reason: "not_overdue" } } });
    expect(f.tenant.rows.size).toBe(1);
    expect(f.global.rows.size).toBe(1);
  });

  it("does not delete global when a tenant heartbeat races the observation", async () => {
    const f = fixture();
    f.intercept(async (body, next) => {
      if (body.kind === "retire_lease") await renewLease(f.tenant.storage,
        { id: ATTEMPT, fence: "original", nowMs: Date.now() });
      return next();
    });
    expect(await f.recover()).toMatchObject({ kind: "refused", result: {
      tenant: { reason: "changed" }, global: { reason: "peer_refused" },
    } });
    expect(f.global.rows.size).toBe(1);
    expect(f.tenant.rows.has(`retired-lease:${ATTEMPT}`)).toBe(false);
  });

  it("holds the global lock across tenant retirement so a global heartbeat cannot interleave", async () => {
    const f = fixture();
    let lateRenew: Promise<Response> | undefined;
    f.intercept(async (body, next) => {
      if (body.kind === "retire_lease") {
        lateRenew = f.globalGuard.fetch(new Request("https://guard/", { method: "POST",
          body: JSON.stringify({ kind: "renew_lease", tenantId: TENANT, attemptId: ATTEMPT,
            fence: "original", nowMs: Date.now() }) }));
      }
      return next();
    });
    expect(await f.recover()).toMatchObject({ kind: "completed" });
    expect(await (await lateRenew!).json()).toEqual({ ok: false, reason: "stale_fence" });
  });

  it.each(["peek_lease", "retire_lease"])("retries a lost %s response without losing global recovery", async kind => {
    const f = fixture();
    f.intercept(async (body, next) => {
      const response = await next();
      if (body.kind === kind) { await response.json(); return new Response(null, { status: 503 }); }
      return response;
    });
    expect(await f.recover()).toEqual({ kind: "unavailable" });
    expect(f.global.rows.size).toBe(1);
    f.intercept(async (_body, next) => next());
    expect(await f.recover()).toMatchObject({ kind: "completed" });
    expect(f.global.rows.size).toBe(0);
  });

  it("keeps retirement durable if tenant deletion fails after the marker write", async () => {
    const f = fixture();
    const remove = f.tenant.storage.delete;
    f.tenant.storage.delete = async () => { throw new Error("storage outage"); };
    expect(await f.recover()).toEqual({ kind: "unavailable" });
    const opts = { id: ATTEMPT, fence: "original", limit: 1, nowMs: Date.now() };
    expect(await acquireLease(f.tenant.storage, opts)).toMatchObject({ reason: "stale_fence" });
    expect(await renewLease(f.tenant.storage, opts)).toMatchObject({ reason: "stale_fence" });
    expect(await pauseLease(f.tenant.storage, opts)).toMatchObject({ reason: "stale_fence" });
    f.tenant.storage.delete = remove;
    expect(await f.recover()).toMatchObject({ kind: "completed" });
  });

  it("does not confuse a corrupt or malformed observation with absence", async () => {
    const f = fixture();
    f.tenant.rows.set(`lease:${ATTEMPT}`, { broken: true });
    expect(await f.recover()).toEqual({ kind: "unavailable" });
    expect(f.global.rows.size).toBe(1);
    f.intercept(async () => Response.json({}));
    expect(await f.recover()).toEqual({ kind: "unavailable" });
  });

  it("checks absent and stale operator expectations instead of taking a new snapshot", async () => {
    const f = fixture();
    expect(await f.recover({ expected: { tenant: null, global: null } })).toMatchObject({ kind: "refused" });
    expect(await f.recover({ expected: { tenant: EXPIRED - 1, global: EXPIRED } })).toMatchObject({ kind: "refused" });
    expect(f.tenant.rows.size).toBe(1);
    expect(f.global.rows.size).toBe(1);
  });

  it("requires explicit work-over policy to recover unexpired rows", async () => {
    const f = fixture({ tenantExpiry: Date.now() + 60_000, globalExpiry: Date.now() + 60_000 });
    expect(await f.recover()).toMatchObject({ kind: "refused" });
    expect(await f.recover({ requireOverdue: false })).toMatchObject({ kind: "completed" });
  });

  it("refuses paused rows even when work-over policy skips the expiry gate", async () => {
    const f = fixture({ paused: true });
    expect(await f.recover({ requireOverdue: false })).toMatchObject({ kind: "refused" });
    expect(f.tenant.rows.size).toBe(1);
    expect(f.global.rows.size).toBe(1);
  });
});
