import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SpendStatus } from "../../src/control-plane/spend-status";
import type { PolicyEnvironment } from "./policy";

// #256 operator dead-lease recovery: observation and compare-and-set clear.
// The observation reuses the read-only spend-status details (never a fence),
// keyed by the guards' exact lease keys. The clear rides a dedicated service
// binding (OperatorLeaseClear) so the status read path can never mutate, and
// passes the expiresAt observed in THIS invocation — the DO refuses on
// mismatch, which is what makes a live-holder race a refusal instead of a
// theft.

export const LeaseClearDecisionSchema = z.union([
  z.object({ ok: z.literal(true), cleared: z.boolean() }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["changed", "not_in_flight", "not_overdue"]),
  }),
]);
export type LeaseClearDecision = z.infer<typeof LeaseClearDecisionSchema>;

export const LeaseClearResponseSchema = z.object({
  ok: z.boolean(),
  tenant: LeaseClearDecisionSchema,
  global: LeaseClearDecisionSchema,
});
export type LeaseClearResponse = z.infer<typeof LeaseClearResponseSchema>;

export interface LeaseRowObservation {
  expiresAtMs: number;
  inFlight: boolean;
  heartbeatOverdueMs: number;
}

export interface LeaseObservation {
  observedAtMs: number;
  tenantRow: LeaseRowObservation | null;
  globalRow: LeaseRowObservation | null;
  complete: boolean;
}

function rowFrom(
  records: ReadonlyArray<{ key: string; expiresAtMs: number; inFlight: boolean; heartbeatOverdueMs: number }>,
  key: string,
): LeaseRowObservation | null {
  const row = records.find((record) => record.key === key);
  if (row === undefined) return null;
  const { key: _key, ...rest } = row;
  return rest;
}

// Throws on an unavailable or incomplete observation — a partial scan must
// never be treated as "absent", which would clear a live row on the strength
// of a page the scan did not read.
export function observeFromSpendStatus(
  status: SpendStatus,
  tenant: string,
  attemptId: string,
): LeaseObservation {
  const details = status.details;
  const tenantDetails = status.tenantDetails;
  if (!details || !tenantDetails) throw new Error("details unavailable");
  if (!details.leases.complete || !tenantDetails.leases.complete) {
    throw new Error("lease inspection incomplete");
  }
  return {
    observedAtMs: status.observedAtMs,
    tenantRow: rowFrom(tenantDetails.leases.records, `lease:${attemptId}`),
    globalRow: rowFrom(details.leases.records, `lease:${tenant}:${attemptId}`),
    complete: true,
  };
}

export async function remoteLeaseClear(
  env: PolicyEnvironment,
  tenant: string,
  attemptId: string,
  expected: { tenant: number | null; global: number | null },
): Promise<LeaseClearResponse> {
  try {
    const { getPlatformProxy } = await import("wrangler");
    const proxy = await getPlatformProxy<{ LEASE_CLEAR: Fetcher }>({
      configPath: fileURLToPath(
        new URL("./wrangler-lease-clear.toml", import.meta.url),
      ),
      environment: env,
      persist: false,
      remoteBindings: true,
    });
    try {
      const response = await proxy.env.LEASE_CLEAR.fetch("https://operator/clear", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId: tenant,
          attemptId,
          ...(expected.tenant === null ? {} : { expectedTenantExpiresAt: expected.tenant }),
          ...(expected.global === null ? {} : { expectedGlobalExpiresAt: expected.global }),
        }),
      });
      if (!response.ok) throw new Error("unavailable");
      return LeaseClearResponseSchema.parse(await response.json());
    } finally {
      await proxy.dispose();
    }
  } catch {
    throw new Error(
      "Lease clear unavailable: verify Cloudflare credentials and deployment of OperatorLeaseClear",
    );
  }
}
