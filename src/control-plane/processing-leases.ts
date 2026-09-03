import type { Env } from "../index";
import { PROCESSING_DEFER_DELAY_SECONDS } from "./constants";
import { globalUsageFor, type GlobalUsage } from "./global-usage-guard";
import { tenantUsageFor, type ProcessingLeaseDecision, type TenantUsage } from "./tenant-usage-guard";

// Tenant-first concurrency saga (ADR 0001). Acquire the tenant lease, then the
// global lease for the same attempt. Global deny, uncertain global, and global
// alreadyRunning after a fresh tenant acquire all compensate the tenant.
// presentLease renew and pause are tenant-first and all-or-nothing: a global
// failure rolls the tenant mutation back (release after renew, restore inFlight
// after pause). Heartbeat renews each side best-effort and never compensates —
// a mid-job TTL refresh must not releaseLease while work continues.
// Uncertain responses are held/denied — never fail open. Duplicate deliveries
// of the same (tenantId, attemptId) reuse the existing fence.

export class DeferPaidWorkError extends Error {
  readonly delaySeconds: number;
  constructor(delaySeconds = PROCESSING_DEFER_DELAY_SECONDS) {
    super("defer_paid_work");
    this.name = "DeferPaidWorkError";
    this.delaySeconds = delaySeconds;
  }
}

export type ProcessingLeaseHold = {
  tenantId: string;
  attemptId: string;
  tenantFence: string;
  globalFence: string;
};

export type AcquireProcessingLeasesResult =
  | { ok: true; alreadyRunning: true }
  | { ok: true; alreadyRunning: false; hold: ProcessingLeaseHold }
  | { ok: false; reason: "contention" | "missing_limits" | "unavailable" | "stale_fence" };

export interface ProcessingLeaseDeps {
  tenant: TenantUsage;
  global: GlobalUsage;
}

export function processingLeaseDepsFor(env: Env, tenantId: string): ProcessingLeaseDeps {
  return { tenant: tenantUsageFor(env, tenantId), global: globalUsageFor(env) };
}

export async function acquireProcessingLeases(
  env: Env,
  tenantId: string,
  attemptId: string,
  nowMs: number,
  deps: ProcessingLeaseDeps = processingLeaseDepsFor(env, tenantId),
): Promise<AcquireProcessingLeasesResult> {
  const tenantResult = await deps.tenant.acquireLease(attemptId, nowMs);
  if (!tenantResult.ok) return { ok: false, reason: tenantResult.reason };
  if (tenantResult.alreadyRunning) return { ok: true, alreadyRunning: true };

  let globalResult: ProcessingLeaseDecision;
  try {
    globalResult = await deps.global.acquireLease(tenantId, attemptId, nowMs);
  } catch {
    await compensateTenant(deps.tenant, attemptId, tenantResult.fence, nowMs);
    return { ok: false, reason: "unavailable" };
  }
  if (!globalResult.ok) {
    await compensateTenant(deps.tenant, attemptId, tenantResult.fence, nowMs);
    return { ok: false, reason: globalResult.reason };
  }
  if (globalResult.alreadyRunning) {
    // Fresh tenant acquire (alreadyRunning is false — we returned earlier
    // otherwise) plus a live global lease for this attempt: drop the new
    // tenant permit so an uncertain global persist cannot leak it, then
    // still report already_running so dispatch keeps its ack path.
    await compensateTenant(deps.tenant, attemptId, tenantResult.fence, nowMs);
    return { ok: true, alreadyRunning: true };
  }
  return {
    ok: true,
    alreadyRunning: false,
    hold: {
      tenantId,
      attemptId,
      tenantFence: tenantResult.fence,
      globalFence: globalResult.fence,
    },
  };
}

async function compensateTenant(
  tenant: TenantUsage,
  attemptId: string,
  fence: string,
  nowMs: number,
): Promise<void> {
  try {
    await tenant.releaseLease(attemptId, fence, nowMs);
  } catch {
    // Uncertain compensation: tenant lease stays held until expiry.
  }
}

export async function renewProcessingLeases(
  env: Env,
  hold: ProcessingLeaseHold,
  nowMs: number,
  deps: ProcessingLeaseDeps = processingLeaseDepsFor(env, hold.tenantId),
): Promise<ProcessingLeaseDecision> {
  const tenant = await deps.tenant.renewLease(hold.attemptId, hold.tenantFence, nowMs);
  if (!tenant.ok) return tenant;
  let global: ProcessingLeaseDecision;
  try {
    global = await deps.global.renewLease(hold.tenantId, hold.attemptId, hold.globalFence, nowMs);
  } catch {
    await compensateTenant(deps.tenant, hold.attemptId, hold.tenantFence, nowMs);
    return { ok: false, reason: "unavailable" };
  }
  if (!global.ok) {
    await compensateTenant(deps.tenant, hold.attemptId, hold.tenantFence, nowMs);
    return global;
  }
  return tenant;
}

export async function heartbeatProcessingLeases(
  env: Env,
  hold: ProcessingLeaseHold,
  nowMs: number,
  deps: ProcessingLeaseDeps = processingLeaseDepsFor(env, hold.tenantId),
): Promise<void> {
  try {
    await deps.tenant.renewLease(hold.attemptId, hold.tenantFence, nowMs);
  } catch {
    // Best-effort TTL refresh. Compensation stays on presentLease/abort.
  }
  try {
    await deps.global.renewLease(hold.tenantId, hold.attemptId, hold.globalFence, nowMs);
  } catch {
    // Best-effort TTL refresh. Compensation stays on presentLease/abort.
  }
}

export async function pauseProcessingLeases(
  env: Env,
  hold: ProcessingLeaseHold,
  nowMs: number,
  deps: ProcessingLeaseDeps = processingLeaseDepsFor(env, hold.tenantId),
): Promise<ProcessingLeaseDecision> {
  const tenant = await deps.tenant.pauseLease(hold.attemptId, hold.tenantFence, nowMs);
  if (!tenant.ok) return tenant;
  let global: ProcessingLeaseDecision;
  try {
    global = await deps.global.pauseLease(hold.tenantId, hold.attemptId, hold.globalFence, nowMs);
  } catch {
    await restoreTenantInFlight(deps.tenant, hold.attemptId, hold.tenantFence, nowMs);
    return { ok: false, reason: "unavailable" };
  }
  if (!global.ok) {
    await restoreTenantInFlight(deps.tenant, hold.attemptId, hold.tenantFence, nowMs);
    return global;
  }
  return tenant;
}

async function restoreTenantInFlight(
  tenant: TenantUsage,
  attemptId: string,
  fence: string,
  nowMs: number,
): Promise<void> {
  try {
    await tenant.renewLease(attemptId, fence, nowMs);
  } catch {
    // Uncertain restore: tenant stays paused until expiry or a later renew.
  }
}

export async function releaseProcessingLeases(
  env: Env,
  hold: ProcessingLeaseHold,
  nowMs: number,
  deps: ProcessingLeaseDeps = processingLeaseDepsFor(env, hold.tenantId),
): Promise<void> {
  try {
    await deps.global.releaseLease(hold.tenantId, hold.attemptId, hold.globalFence, nowMs);
  } catch {
    // Conservative: uncertain global release stays counted until expiry.
  }
  try {
    await deps.tenant.releaseLease(hold.attemptId, hold.tenantFence, nowMs);
  } catch {
    // Conservative: uncertain tenant release stays counted until expiry.
  }
}

export function throwIfDeferred(result: AcquireProcessingLeasesResult): ProcessingLeaseHold | "already_running" {
  if (result.ok && result.alreadyRunning) return "already_running";
  if (result.ok) return result.hold;
  throw new DeferPaidWorkError();
}
