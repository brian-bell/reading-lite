import { describe, expect, it } from "vitest";
import { resolveOperatorTenant } from "../../../scripts/corpus-lib/tenant";
import { tenantKeyRoot } from "../../../src/modules/stores/tenant-root";
import { parseTenantId } from "../../../src/control-plane/ids";

const TENANT_ID = "usr_550e8400-e29b-41d4-a716-446655440000";

describe("resolveOperatorTenant", () => {
  it("fails closed when no selector is given", () => {
    for (const selector of [undefined, ""]) {
      const out = resolveOperatorTenant(selector);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toMatch(/--tenant is required/);
    }
  });

  it("resolves 'global' to the pre-tenant layout", () => {
    const out = resolveOperatorTenant("global");
    expect(out).toEqual({
      ok: true,
      tenant: { kind: "global", keyRoot: "" },
    });
  });

  it("resolves a tenant id to the same key root the worker uses", () => {
    const out = resolveOperatorTenant(TENANT_ID);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    if (out.tenant.kind !== "tenant") throw new Error("expected a tenant selection");
    expect(out.tenant.tenantId).toBe(TENANT_ID);
    // Spelling parity with the hosted data plane: the operator key root must
    // be exactly what contentStoreFor uses when TENANT_DATA_PLANE=1.
    expect(out.tenant.keyRoot).toBe(
      tenantKeyRoot({ tenantId: parseTenantId(TENANT_ID)! }, true),
    );
    expect(out.tenant.keyRoot).toBe(`u/${TENANT_ID}/`);
  });

  it("rejects a malformed tenant id", () => {
    for (const selector of ["usr_nope", "tenant-1", "u/usr_x/", "GLOBAL "]) {
      const out = resolveOperatorTenant(selector);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toMatch(/malformed tenant selector/);
    }
  });
});
