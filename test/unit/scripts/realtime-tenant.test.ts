import { describe, expect, it } from "vitest";
import { verifyRealtimeTenant } from "../../../scripts/corpus-lib/realtime-tenant";
import type { OperatorTenant } from "../../../scripts/corpus-lib/tenant";
import type { WhoamiOutcome } from "../../../scripts/lib/reading-api";

const TENANT_A = "usr_11111111-1111-4111-8111-111111111111";
const TENANT_B = "usr_22222222-2222-4222-8222-222222222222";

const globalTenant: OperatorTenant = { kind: "global", keyRoot: "" };
const tenantA: OperatorTenant = {
  kind: "tenant",
  tenantId: TENANT_A,
  keyRoot: `u/${TENANT_A}/`,
};

function identity(tenantId: string, tenantDataPlane: boolean): WhoamiOutcome {
  return { kind: "identity", tenantId, userId: tenantId, principal: "api_token", tenantDataPlane };
}

describe("verifyRealtimeTenant", () => {
  it("allows a global selector while the data-plane gate is off", () => {
    const verdict = verifyRealtimeTenant(globalTenant, identity(TENANT_A, false));
    expect(verdict).toEqual({ ok: true, note: expect.stringContaining("global layout") });
  });

  it("refuses a global selector once the gate is on — writes land in the token's tenant", () => {
    const verdict = verifyRealtimeTenant(globalTenant, identity(TENANT_A, true));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain(`'${TENANT_A}'`);
    expect(verdict.reason).toContain("never the global layout");
  });

  it("allows a tenant selector when the gate is on and the token matches", () => {
    const verdict = verifyRealtimeTenant(tenantA, identity(TENANT_A, true));
    expect(verdict).toEqual({ ok: true, note: expect.stringContaining(TENANT_A) });
  });

  it("refuses a tenant selector when the token belongs to another tenant", () => {
    const verdict = verifyRealtimeTenant(tenantA, identity(TENANT_B, true));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain(TENANT_B);
    expect(verdict.reason).toContain(TENANT_A);
  });

  it("refuses a tenant selector while the gate is off — writes would land globally", () => {
    const verdict = verifyRealtimeTenant(tenantA, identity(TENANT_A, false));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("gate is off");
  });

  it("fails closed when the worker predates whoami (404), pointing at --batch", () => {
    const verdict = verifyRealtimeTenant(tenantA, {
      kind: "http_error",
      status: 404,
      message: "not found",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("/api/whoami");
    expect(verdict.reason).toContain("--batch");
  });

  it("fails closed on any other whoami error, including transport", () => {
    for (const who of [
      { kind: "http_error", status: 500, message: "internal" },
      { kind: "transport_error", message: "ECONNRESET" },
    ] satisfies WhoamiOutcome[]) {
      const verdict = verifyRealtimeTenant(globalTenant, who);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.reason).toContain("refusing to submit");
    }
  });
});
