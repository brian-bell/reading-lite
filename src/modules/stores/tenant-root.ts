// The tenant root every hosted R2 key sits under. With the tenant gate on
// (TENANT_DATA_PLANE=1, pinned in staging and production) a tenant's objects
// live under `u/{tenantId}/`; with it off the root is empty, which is how local
// dev addresses the seeded fixture pack. Stored `key_prefix` values and content
// keys stay relative; the root is applied where a key meets the bucket.

import { parseTenantId, type TenantContext } from "../../control-plane/ids";

export function tenantDataPlaneEnabled(env: { TENANT_DATA_PLANE?: string }): boolean {
  return env.TENANT_DATA_PLANE === "1";
}

export function tenantKeyRoot(tenant: TenantContext, enabled: boolean): string {
  const tenantId = parseTenantId(String(tenant.tenantId));
  if (!tenantId) {
    throw new Error("malformed tenant id");
  }
  if (!enabled) return "";
  return `u/${tenantId}/`;
}
