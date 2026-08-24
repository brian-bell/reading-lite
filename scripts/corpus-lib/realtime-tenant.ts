// Realtime-write tenant verification (reading-lite-1xk). The realtime recover
// path writes through the Reading API, where the acting tenant is the BEARER
// TOKEN's principal — the worker confines every write to that tenant
// regardless of the operator's --tenant, which scopes only the CLI's direct
// R2 reads. Before submitting, the CLI asks the worker who the token is
// (GET /api/whoami) and refuses any combination where API writes would land
// somewhere other than the selected layout:
//
//   selector   gate off                    gate on
//   global     ok (writes hit global)      refuse (writes hit token tenant)
//   usr_X      refuse (writes hit global)  ok iff token tenant == usr_X
//
// Every non-identity outcome fails closed: an unverifiable token could import
// one tenant's audited content into another.
//
// The verdict is point-in-time — a TENANT_DATA_PLANE flip or a rolling worker
// deploy after it could re-route later writes. It is therefore only the
// preflight half of the guarantee: the caller also pins the verified layout
// on every subsequent write via x-expected-tenant (see EXPECTED_TENANT_HEADER
// in src/schemas/api.ts), which the worker checks atomically on the same
// request as the mutation. Even without the pin, no third tenant is reachable
// — the worker confines every write to the bearer's own principal or the
// global layout.
//
// Deployment-ordering invariant: the pin only protects once every serving
// worker version enforces it, so TENANT_DATA_PLANE must not be flipped while
// a pre-pin worker could still serve. This holds by sequencing — the flip is
// the s1k.6 founder cutover, many deploys after the pin ships, and a gate-off
// whoami answer makes a usr_ realtime run refuse anyway.

import type { WhoamiOutcome } from "../lib/reading-api";
import type { OperatorTenant } from "./tenant";

export type RealtimeTenantVerdict =
  | { ok: true; note: string }
  | { ok: false; reason: string };

export function verifyRealtimeTenant(
  tenant: OperatorTenant,
  who: WhoamiOutcome,
): RealtimeTenantVerdict {
  if (who.kind === "http_error" && who.status === 404) {
    return {
      ok: false,
      reason:
        "the worker does not expose GET /api/whoami, so the bearer token's tenant cannot be " +
        "verified; deploy a worker with whoami support, or use --batch (scoped by --tenant end to end).",
    };
  }
  if (who.kind !== "identity") {
    const detail =
      who.kind === "http_error" ? `${who.status} ${who.message}`.trim() : who.message;
    return {
      ok: false,
      reason: `could not verify the bearer token's tenant (whoami ${who.kind}: ${detail}); refusing to submit.`,
    };
  }

  if (tenant.kind === "tenant") {
    if (!who.tenantDataPlane) {
      return {
        ok: false,
        reason:
          "the worker's tenant data-plane gate is off, so realtime API writes land on the " +
          `global layout, not tenant '${tenant.tenantId}'; use --tenant global, or --batch.`,
      };
    }
    if (who.tenantId !== tenant.tenantId) {
      return {
        ok: false,
        reason:
          `the bearer token acts as tenant '${who.tenantId}', not --tenant '${tenant.tenantId}'; ` +
          "refusing to submit under a mismatched token.",
      };
    }
    return {
      ok: true,
      note: `verified: bearer token acts as tenant '${tenant.tenantId}' (whoami, data-plane gate on).`,
    };
  }

  if (who.tenantDataPlane) {
    return {
      ok: false,
      reason:
        "the worker's tenant data-plane gate is on, so realtime API writes land under the " +
        `token's tenant '${who.tenantId}', never the global layout; rerun with --tenant '${who.tenantId}', or use --batch.`,
    };
  }
  return {
    ok: true,
    note: "verified: data-plane gate off, realtime API writes act on the global layout (whoami).",
  };
}
