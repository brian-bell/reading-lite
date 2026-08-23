// The operator-side tenant selector (reading-lite-s1k.4.3). Every corpus CLI
// command that reads or mutates corpus state must state WHOSE corpus it is
// acting on before planning anything: either one tenant's namespace or,
// explicitly, the pre-tenant global layout. There is deliberately no default —
// an absent selector fails closed rather than silently operating on the global
// root, mirroring the hosted side where every store is constructed from a
// validated TenantContext.
//
// Spelling is single-homed with the worker: the key root comes from
// tenantKeyRoot (the same function readingStoreFor uses when
// TENANT_DATA_PLANE=1), and the Vectorize namespace is the tenant id, matching
// similarityStoreFor. `global` maps to the empty key root and no namespace —
// the layout production data lives under until the founder corpus migration
// (reading-lite-s1k.6).

import { parseTenantId } from "../../src/control-plane/ids";
import { tenantKeyRoot } from "../../src/modules/stores/reading-store";

export type OperatorTenant =
  | { kind: "global"; keyRoot: ""; namespace: undefined }
  | { kind: "tenant"; tenantId: string; keyRoot: string; namespace: string };

export type ResolveOperatorTenantResult =
  | { ok: true; tenant: OperatorTenant }
  | { ok: false; reason: string };

export function resolveOperatorTenant(
  selector: string | undefined,
): ResolveOperatorTenantResult {
  if (selector === undefined || selector === "") {
    return {
      ok: false,
      reason:
        "--tenant is required: pass a tenant id (usr_…) or 'global' for the pre-tenant layout",
    };
  }
  if (selector === "global") {
    return { ok: true, tenant: { kind: "global", keyRoot: "", namespace: undefined } };
  }
  const tenantId = parseTenantId(selector);
  if (!tenantId) {
    return {
      ok: false,
      reason: `malformed tenant selector: ${JSON.stringify(selector)} (expected usr_… or 'global')`,
    };
  }
  return {
    ok: true,
    tenant: {
      kind: "tenant",
      tenantId: String(tenantId),
      keyRoot: tenantKeyRoot({ tenantId }, true),
      namespace: String(tenantId),
    },
  };
}
