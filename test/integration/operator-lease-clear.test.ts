import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OperatorLeaseClear } from "../../src/control-plane/operator-lease-clear";
import type { Env } from "../../src/index";
import { GLOBAL_USAGE_GUARD_NAME } from "../../src/control-plane/constants";
import { FOUNDER_TENANT_ID } from "../helpers/tenant-fixtures";

// #256: the operator clear path is a service-binding-only entrypoint that
// forwards one compare-and-set verb to both guards. These tests drive the
// entrypoint class directly against the real test bindings, the same way
// operator-status.test.ts exercises OperatorStatus.
function endpoint(bindings = env as unknown as Env) {
  return new OperatorLeaseClear(createExecutionContext(), bindings);
}

function clearRequest(body: unknown): Request {
  return new Request("https://operator/clear", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function holdBothSides(attemptId: string, nowMs: number) {
  const tenantNs = (env as unknown as Env).TENANT_USAGE_GUARD!;
  const globalNs = (env as unknown as Env).GLOBAL_USAGE_GUARD!;
  const tenant = await (
    await tenantNs.get(tenantNs.idFromName(FOUNDER_TENANT_ID)).fetch("https://guard/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "acquire_lease", tenantId: FOUNDER_TENANT_ID, attemptId, nowMs }),
    })
  ).json() as { ok: boolean; fence?: string; expires_at?: number };
  const global = await (
    await globalNs.get(globalNs.idFromName(GLOBAL_USAGE_GUARD_NAME)).fetch("https://guard/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "acquire_lease", tenantId: FOUNDER_TENANT_ID, attemptId, nowMs }),
    })
  ).json() as { ok: boolean; fence?: string; expires_at?: number };
  return { tenant, global };
}

// Vitest isolated-storage requires every guard response body to be consumed:
// an unread response keeps the DO request context open and blocks the
// per-test storage pop (the sqlite-shm WAL failure), so every helper here
// reads .json() even for writes.
async function releaseBothSides(attemptId: string, fences: { tenant?: string; global?: string }) {
  const tenantNs = (env as unknown as Env).TENANT_USAGE_GUARD!;
  const globalNs = (env as unknown as Env).GLOBAL_USAGE_GUARD!;
  if (fences.tenant) {
    await (
      await tenantNs.get(tenantNs.idFromName(FOUNDER_TENANT_ID)).fetch("https://guard/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "release_lease", attemptId, fence: fences.tenant, nowMs: Date.now() }),
      })
    ).json();
  }
  if (fences.global) {
    await (
      await globalNs.get(globalNs.idFromName(GLOBAL_USAGE_GUARD_NAME)).fetch("https://guard/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "release_lease",
          tenantId: FOUNDER_TENANT_ID,
          attemptId,
          fence: fences.global,
          nowMs: Date.now(),
        }),
      })
    ).json();
  }
}

const OVERDUE_MS = Date.now() - 30 * 60 * 1000;

describe("operator lease-clear entrypoint", () => {
  it("rejects non-POST and malformed bodies without reaching the guards", async () => {
    expect((await endpoint().fetch(new Request("https://operator/clear"))).status).toBe(405);
    expect(
      (await endpoint().fetch(clearRequest({ attemptId: "at_x" }))).status,
    ).toBe(400);
    expect(
      (await endpoint().fetch(clearRequest({ tenantId: "not-a-tenant", attemptId: "at_x" }))).status,
    ).toBe(400);
    expect(
      (await endpoint().fetch(
        clearRequest({ tenantId: FOUNDER_TENANT_ID, attemptId: "at_x", expectedTenantExpiresAt: -1 }),
      )).status,
    ).toBe(400);
    expect(
      (await endpoint().fetch(new Request("https://operator/clear?x=1", { method: "POST" }))).status,
    ).toBe(400);
    expect((await endpoint().fetch(new Request("https://operator/nope", { method: "POST" }))).status).toBe(404);
  });

  it("clears an overdue orphan on both guards under the observed expiresAt", async () => {
    const held = await holdBothSides("at_entry_orphan", OVERDUE_MS);
    expect(held.tenant.ok).toBe(true);
    expect(held.global.ok).toBe(true);
    try {
      const response = await endpoint().fetch(
        clearRequest({
          tenantId: FOUNDER_TENANT_ID,
          attemptId: "at_entry_orphan",
          expectedTenantExpiresAt: held.tenant.expires_at,
          expectedGlobalExpiresAt: held.global.expires_at,
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        tenant: { ok: true, cleared: true },
        global: { ok: true, cleared: true },
      });
      // Retiring the attempt closes the clear-before-terminal-write window:
      // even a delayed delivery that already read pending cannot reacquire it.
      const ns = (env as unknown as Env).TENANT_USAGE_GUARD!;
      const replay = await (await ns.get(ns.idFromName(FOUNDER_TENANT_ID)).fetch("https://guard/", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "acquire_lease", tenantId: FOUNDER_TENANT_ID,
          attemptId: "at_entry_orphan", nowMs: Date.now() }),
      })).json();
      expect(replay).toMatchObject({ ok: false, reason: "stale_fence" });
      // A re-run converges: both rows are gone, so the clear is an honest
      // no-op success (idempotence for repeated recovery).
      const rerun = await endpoint().fetch(
        clearRequest({ tenantId: FOUNDER_TENANT_ID, attemptId: "at_entry_orphan" }),
      );
      expect(await rerun.json()).toEqual({
        ok: true,
        tenant: { ok: true, cleared: false },
        global: { ok: true, cleared: false },
      });
    } finally {
      await releaseBothSides("at_entry_orphan", {});
    }
  });

  it("refuses a live-holder race: a renewed row is changed, not cleared", async () => {
    const held = await holdBothSides("at_entry_live", Date.now());
    expect(held.tenant.ok).toBe(true);
    expect(held.global.ok).toBe(true);
    try {
      const response = await endpoint().fetch(
        clearRequest({
          tenantId: FOUNDER_TENANT_ID,
          attemptId: "at_entry_live",
          // Observed expiresAt matches, but the row is not overdue yet.
          expectedTenantExpiresAt: held.tenant.expires_at,
          expectedGlobalExpiresAt: held.global.expires_at,
        }),
      );
      const body = (await response.json()) as { ok: boolean; tenant: { reason?: string }; global: { reason?: string } };
      expect(body.ok).toBe(false);
      expect(body.tenant.reason).toBe("peer_refused");
      expect(body.global.reason).toBe("not_overdue");
    } finally {
      await releaseBothSides("at_entry_live", { tenant: held.tenant.fence, global: held.global.fence });
    }
  });

  it("refuses a stale observation: the row moved after the operator looked", async () => {
    const held = await holdBothSides("at_entry_stale", OVERDUE_MS);
    expect(held.tenant.ok).toBe(true);
    try {
      // The holder renewed between observation and clear: expiresAt moved.
      const tenantNs = (env as unknown as Env).TENANT_USAGE_GUARD!;
      await (
        await tenantNs.get(tenantNs.idFromName(FOUNDER_TENANT_ID)).fetch("https://guard/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "renew_lease",
            attemptId: "at_entry_stale",
            fence: held.tenant.fence,
            nowMs: Date.now(),
          }),
        })
      ).json();
      const response = await endpoint().fetch(
        clearRequest({
          tenantId: FOUNDER_TENANT_ID,
          attemptId: "at_entry_stale",
          expectedTenantExpiresAt: held.tenant.expires_at,
          expectedGlobalExpiresAt: held.global.expires_at,
        }),
      );
      const body = (await response.json()) as { ok: boolean; tenant: { reason?: string } };
      expect(body.ok).toBe(false);
      expect(body.tenant.reason).toBe("changed");
      expect((body as unknown as { global: { ok: boolean } }).global.ok).toBe(false);
    } finally {
      await releaseBothSides("at_entry_stale", { tenant: held.tenant.fence, global: held.global.fence });
    }
  });

  it("fails closed when the recovery authority is unbound", async () => {
    const response = await endpoint({ ...env, GLOBAL_USAGE_GUARD: undefined } as unknown as Env).fetch(
      clearRequest({ tenantId: FOUNDER_TENANT_ID, attemptId: "at_x" }),
    );
    expect(response.status).toBe(503);
  });
});
