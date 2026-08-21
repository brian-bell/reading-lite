import { describe, expect, it } from "vitest";
import { parseTenantId } from "../../../src/control-plane/ids";
import {
  tenantDataPlaneEnabled,
  tenantKeyRoot,
} from "../../../src/modules/stores/reading-store";

const TENANT = { tenantId: parseTenantId("usr_550e8400-e29b-41d4-a716-446655440000")! };

describe("tenant data-plane gate", () => {
  it("treats only TENANT_DATA_PLANE=1 as enabled", () => {
    expect(tenantDataPlaneEnabled({})).toBe(false);
    expect(tenantDataPlaneEnabled({ TENANT_DATA_PLANE: "" })).toBe(false);
    expect(tenantDataPlaneEnabled({ TENANT_DATA_PLANE: "0" })).toBe(false);
    expect(tenantDataPlaneEnabled({ TENANT_DATA_PLANE: "1" })).toBe(true);
  });

  it("returns an empty root when the gate is off and a tenant prefix when on", () => {
    expect(tenantKeyRoot(TENANT, false)).toBe("");
    expect(tenantKeyRoot(TENANT, true)).toBe("u/usr_550e8400-e29b-41d4-a716-446655440000/");
  });

  it("refuses a malformed tenant id before it can enter a path", () => {
    expect(() => tenantKeyRoot({ tenantId: "founder" as never }, true)).toThrow(/malformed tenant id/);
  });
});
