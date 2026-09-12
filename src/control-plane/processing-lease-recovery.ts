import { z } from "zod";
import type { Env } from "../index";
import { GLOBAL_USAGE_GUARD_NAME } from "./constants";
import { parseTenantId } from "./ids";
import { checkLeaseRecovery, leaseStorageKey, peekLease, retireLease } from "./processing-lease-state";

// One recovery protocol for queue deliveries and operators. The global guard
// holds its lock while validating its own row and conditionally retiring the
// tenant row. A tenant refusal never deletes global capacity; a global refusal
// never touches the tenant. No tenant handler calls the global guard, so this
// lock order has no cycle. Errors propagate as unavailable, never as absence.
// Retirement prevents reacquisition before processReading writes its terminal
// manifest. If a response/write is lost, observe both sides again and replay.
const Expiry = z.number().finite().nonnegative();
const Attempt = z.string().min(1);
const Tenant = z.string().refine(value => parseTenantId(value) !== null);
const Expected = z.object({ tenant: Expiry.nullable(), global: Expiry.nullable() });
export const LeaseRecoveryRequestSchema = z.object({
  kind: z.literal("recover_leases"),
  tenantId: Tenant,
  attemptId: Attempt,
  expected: Expected.optional(), // absent = observe inside the recovery authority
  requireOverdue: z.boolean().default(true),
});
export type LeaseRecoveryRequest = z.infer<typeof LeaseRecoveryRequestSchema>;
export const TenantRecoveryRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("peek_lease"), attemptId: Attempt }),
  z.object({ kind: z.literal("retire_lease"), attemptId: Attempt,
    expectedExpiresAt: Expiry.nullable(), requireOverdue: z.boolean() }),
]);
export type TenantRecoveryRequest = z.infer<typeof TenantRecoveryRequestSchema>;
const ObservationSchema = z.discriminatedUnion("present", [
  z.object({ present: z.literal(false) }),
  z.object({ present: z.literal(true), expiresAt: Expiry, inFlight: z.boolean() }),
]);
export const LeaseClearDecisionSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), cleared: z.boolean() }),
  z.object({ ok: z.literal(false), reason: z.enum(["changed", "not_in_flight", "not_overdue", "peer_refused"]) }),
]);
export const LeaseClearResponseSchema = z.object({
  ok: z.boolean(), tenant: LeaseClearDecisionSchema, global: LeaseClearDecisionSchema,
}).refine(value => value.ok === (value.tenant.ok && value.global.ok));
export type LeaseClearResponse = z.infer<typeof LeaseClearResponseSchema>;
const peerRefused = { ok: false, reason: "peer_refused" } as const;

export async function tenantLeaseRecovery(storage: DurableObjectStorage, request: TenantRecoveryRequest): Promise<unknown> {
  if (request.kind === "peek_lease") return peekLease(storage, { id: request.attemptId });
  return retireLease(storage, { id: request.attemptId, expectedExpiresAt: request.expectedExpiresAt,
    requireOverdue: request.requireOverdue, nowMs: Date.now() });
}

// Must run inside GlobalUsageGuard.blockConcurrencyWhile, including the tenant
// RPC. Global heartbeats/acquires cannot interleave between observation and
// delete. The tenant CAS catches a heartbeat on the other side of the pair.
export async function recoverLeasePair(
  storage: DurableObjectStorage,
  env: Pick<Env, "TENANT_USAGE_GUARD">,
  request: LeaseRecoveryRequest,
): Promise<LeaseClearResponse> {
  const id = `${request.tenantId}:${request.attemptId}`;
  const globalRow = await peekLease(storage, { id });
  const globalDecision = checkLeaseRecovery(globalRow,
    request.expected ? request.expected.global : globalRow.present ? globalRow.expiresAt : null,
    Date.now(), request.requireOverdue);
  if (!globalDecision.ok) return { ok: false, tenant: peerRefused, global: globalDecision };
  const ns = env.TENANT_USAGE_GUARD;
  if (!ns) throw new Error("tenant guard unavailable");
  const stub = ns.get(ns.idFromName(request.tenantId));
  const call = async (body: TenantRecoveryRequest): Promise<unknown> => {
    const res = await stub.fetch("https://tenant-usage-guard/", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("tenant recovery unavailable");
    return res.json();
  };
  let expectedTenant = request.expected?.tenant;
  if (expectedTenant === undefined) {
    const row = ObservationSchema.parse(await call({ kind: "peek_lease", attemptId: request.attemptId }));
    expectedTenant = row.present ? row.expiresAt : null;
  }
  const tenant = LeaseClearDecisionSchema.parse(await call({ kind: "retire_lease",
    attemptId: request.attemptId, expectedExpiresAt: expectedTenant, requireOverdue: request.requireOverdue }));
  if (!tenant.ok) return { ok: false, tenant, global: peerRefused };
  // Retirement is durable before this delete. On a crash here a new delivery
  // cannot start paid work, and recovery can still find the global-only row.
  if (globalRow.present) await storage.delete(leaseStorageKey(id));
  return { ok: true, tenant, global: globalDecision };
}

export type LeaseRecoveryOutcome =
  | { kind: "completed"; result: LeaseClearResponse }
  | { kind: "refused"; result: LeaseClearResponse }
  | { kind: "unavailable" };

export async function recoverProcessingLeases(
  env: Pick<Env, "GLOBAL_USAGE_GUARD">,
  tenantId: string,
  attemptId: string,
  options: { expected?: { tenant: number | null; global: number | null }; requireOverdue?: boolean } = {},
): Promise<LeaseRecoveryOutcome> {
  try {
    const ns = env.GLOBAL_USAGE_GUARD;
    if (!ns) return { kind: "unavailable" };
    const body = LeaseRecoveryRequestSchema.parse({ kind: "recover_leases", tenantId, attemptId, ...options });
    const response = await ns.get(ns.idFromName(GLOBAL_USAGE_GUARD_NAME)).fetch("https://global-usage-guard/", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.ok) return { kind: "unavailable" };
    const result = LeaseClearResponseSchema.parse(await response.json());
    return { kind: result.ok ? "completed" : "refused", result };
  } catch {
    return { kind: "unavailable" };
  }
}
