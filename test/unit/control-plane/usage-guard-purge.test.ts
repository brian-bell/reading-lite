// The `purge_tenant` body kind on both usage guards (issue 195 S4 / #263).
//
// The two guards need different verbs for the same job because they are
// addressed differently: `TenantUsageGuard` is `idFromName(tenantId)`, so every
// key it holds belongs to the tenant and `deleteAll()` is correct;
// `GlobalUsageGuard` is a singleton shared by every tenant, so it must delete
// by key prefix and leave the neighbours alone.

import { describe, expect, it } from "vitest";
import {
  GlobalUsageGuard,
  purgeGlobalUsageLeases,
} from "../../../src/control-plane/global-usage-guard";
import {
  purgeTenantUsageGuard,
  TenantUsageGuard,
} from "../../../src/control-plane/tenant-usage-guard";
import { leaseStorageKey } from "../../../src/control-plane/processing-lease-state";
import type { Env } from "../../../src/index";

const TENANT = "usr_550e8400-e29b-41d4-a716-446655440000";
const OTHER = "usr_11111111-1111-4111-8111-111111111111";

function memoryStorage(map: Map<string, unknown> = new Map()): {
  storage: DurableObjectStorage;
  map: Map<string, unknown>;
  alarm: () => number | null;
} {
  let alarm: number | null = null;
  const storage = {
    get: async (key: string) => map.get(key),
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: async (key: string) => map.delete(key),
    deleteAll: async () => {
      map.clear();
    },
    list: async (options?: { prefix?: string }) => {
      const prefix = options?.prefix ?? "";
      return new Map([...map].filter(([key]) => key.startsWith(prefix)));
    },
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  } as unknown as DurableObjectStorage;
  return { storage, map, alarm: () => alarm };
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

function lease(fence: string) {
  return { fence, expiresAt: Date.now() + 60_000, inFlight: true };
}

async function post(
  guard: { fetch(request: Request): Promise<Response> },
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await guard.fetch(
    new Request("https://guard/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("GlobalUsageGuard purge_tenant", () => {
  it("drops only the named tenant's leases", async () => {
    const { storage, map } = memoryStorage(
      new Map<string, unknown>([
        [leaseStorageKey(`${TENANT}:att_a`), lease("f1")],
        [leaseStorageKey(`${TENANT}:att_b`), lease("f2")],
        [leaseStorageKey(`${OTHER}:att_c`), lease("f3")],
      ]),
    );
    const guard = new GlobalUsageGuard(guardState(storage), {} as Env);

    const { status, json } = await post(guard, { kind: "purge_tenant", tenantId: TENANT });

    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, purged: 2 });
    // The singleton keeps serving everyone else: a deleted account must not
    // take a live tenant's concurrency lease with it.
    expect([...map.keys()]).toEqual([leaseStorageKey(`${OTHER}:att_c`)]);
  });

  it("is idempotent on a tenant that holds no leases", async () => {
    const { storage } = memoryStorage(
      new Map<string, unknown>([[leaseStorageKey(`${OTHER}:att_c`), lease("f3")]]),
    );
    const guard = new GlobalUsageGuard(guardState(storage), {} as Env);

    const { json } = await post(guard, { kind: "purge_tenant", tenantId: TENANT });
    expect(json).toEqual({ ok: true, purged: 0 });
  });

  it("refuses a malformed tenant id rather than guessing a prefix", async () => {
    const { storage, map } = memoryStorage(
      new Map<string, unknown>([[leaseStorageKey(`${TENANT}:att_a`), lease("f1")]]),
    );
    const guard = new GlobalUsageGuard(guardState(storage), {} as Env);

    // An empty or partial id would make `lease:` the prefix and empty the whole
    // singleton — every tenant's leases, not one account's.
    for (const tenantId of ["", "usr_", TENANT.slice(0, 20), "../"]) {
      const { status, json } = await post(guard, { kind: "purge_tenant", tenantId });
      expect(status, tenantId).toBe(400);
      expect(json, tenantId).toEqual({ error: "invalid_body" });
    }
    expect(map.size).toBe(1);
  });
});

describe("TenantUsageGuard purge_tenant", () => {
  it("empties the object and cancels its alarm", async () => {
    const { storage, map, alarm } = memoryStorage(
      new Map<string, unknown>([
        ["req", { start: 0, count: 4 }],
        ["h:2026-09-04T10", { count: 2 }],
        ["op:att_a", { status: "held", hourKey: "x", monthKey: "y", expiresAt: 1 }],
        [leaseStorageKey("att_a"), lease("f1")],
      ]),
    );
    await storage.setAlarm(Date.now() + 60_000);
    const guard = new TenantUsageGuard(guardState(storage), {} as Env);

    const { status, json } = await post(guard, { kind: "purge_tenant", tenantId: TENANT });

    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(map.size).toBe(0);
    // deleteAll() leaves the alarm behind, which would wake a deleted tenant's
    // object to sweep storage that is already gone.
    expect(alarm()).toBeNull();
  });

  it("refuses a malformed tenant id", async () => {
    const { storage, map } = memoryStorage(new Map<string, unknown>([["req", { start: 0, count: 1 }]]));
    const guard = new TenantUsageGuard(guardState(storage), {} as Env);

    const { status, json } = await post(guard, { kind: "purge_tenant", tenantId: "nope" });
    expect(status).toBe(400);
    expect(json).toEqual({ error: "invalid_body" });
    expect(map.size).toBe(1);
  });
});

describe("purge helpers fail closed", () => {
  function failingNamespace(status: number): DurableObjectNamespace {
    return {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response("no", { status }) }),
    } as unknown as DurableObjectNamespace;
  }

  it("reports an unbound namespace as nothing to clear", async () => {
    await expect(purgeTenantUsageGuard({}, TENANT)).resolves.toBe("unbound");
    await expect(purgeGlobalUsageLeases({}, TENANT)).resolves.toBe("unbound");
  });

  it("throws when a bound namespace answers with an error", async () => {
    // Deliberately not the fail-closed-deny shape the request path uses: a
    // teardown verb that quietly "succeeds" by doing nothing would let the
    // users row go while the guard still held the tenant's state.
    await expect(
      purgeTenantUsageGuard({ TENANT_USAGE_GUARD: failingNamespace(500) }, TENANT),
    ).rejects.toThrow(/purge_tenant failed with 500/);
    await expect(
      purgeGlobalUsageLeases({ GLOBAL_USAGE_GUARD: failingNamespace(503) }, TENANT),
    ).rejects.toThrow(/purge_tenant failed with 503/);
  });

  it("refuses a malformed tenant id before addressing a Durable Object", async () => {
    const ns = failingNamespace(200);
    await expect(purgeTenantUsageGuard({ TENANT_USAGE_GUARD: ns }, "nope")).rejects.toThrow(
      /malformed tenant id/,
    );
  });
});
