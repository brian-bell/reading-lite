import type { Env } from "../index";
import { PROCESSING_DEFER_DELAY_SECONDS, PROCESSING_LEASE_HEARTBEAT_MS } from "./constants";
import { globalUsageFor, type GlobalUsage } from "./global-usage-guard";
import { tenantUsageFor, type ProcessingLeaseDecision, type TenantUsage } from "./tenant-usage-guard";

// Tenant-first concurrency saga (ADR 0001). Acquire the tenant lease, then the
// global lease for the same attempt. Global deny and uncertain global after a
// fresh tenant acquire compensate the tenant. Fresh tenant + global
// alreadyRunning for THIS same attempt is saga recovery: the global persist
// landed but the response was lost, so adopt that fence rather than
// compensating tenant and deferring (B1 will not sweep the orphaned inFlight
// global). A foreign live attempt still contends and defers. presentLease renew
// and pause are tenant-first and all-or-nothing: a global failure rolls the
// tenant mutation back (release after renew, restore inFlight after pause).
// Heartbeat renews each side best-effort, never compensates, and preserves
// inFlight so a late TTL refresh cannot unpause a 429-parked row. Uncertain
// responses are held/denied — never fail open. Duplicate deliveries of the
// same (tenantId, attemptId) reuse the existing fence.

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
    // Same-attempt inFlight global (lost acquire response): keep the fresh
    // tenant permit and adopt the existing global fence. A different live
    // attempt occupies a different lease id and surfaces as contention above.
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
    await deps.tenant.renewLease(hold.attemptId, hold.tenantFence, nowMs, { preserveInFlight: true });
  } catch {
    // Best-effort TTL refresh. Compensation stays on presentLease/abort.
  }
  try {
    await deps.global.renewLease(hold.tenantId, hold.attemptId, hold.globalFence, nowMs, {
      preserveInFlight: true,
    });
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

export async function pauseOrReleaseProcessingLeases(
  env: Env,
  hold: ProcessingLeaseHold,
  nowMs: number,
  deps: ProcessingLeaseDeps = processingLeaseDepsFor(env, hold.tenantId),
): Promise<ProcessingLeaseDecision> {
  const paused = await pauseProcessingLeases(env, hold, nowMs, deps);
  if (!paused.ok) await releaseProcessingLeases(env, hold, nowMs, deps);
  return paused;
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

export class StaleProcessingLeaseError extends Error {
  constructor() {
    super("processing lease fence is stale");
    this.name = "StaleProcessingLeaseError";
  }
}

export async function presentLeaseBeforePaidDispatch(
  env: Env,
  hold: ProcessingLeaseHold,
  nowMs: () => number,
): Promise<void> {
  const renewed = await renewProcessingLeases(env, hold, nowMs());
  if (renewed.ok) return;
  if (renewed.reason === "stale_fence") throw new StaleProcessingLeaseError();
  throw new DeferPaidWorkError();
}

export function startProcessingLeaseHeartbeat(
  env: Env,
  hold: ProcessingLeaseHold,
  nowMs: () => number,
): () => Promise<void> {
  let generation = 0;
  let inflight: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    const epoch = generation;
    const previous = inflight;
    inflight = (async () => {
      try {
        await previous;
      } catch {
        // Prior heartbeat is best-effort.
      }
      if (epoch !== generation) return;
      await heartbeatProcessingLeases(env, hold, nowMs());
    })();
  }, PROCESSING_LEASE_HEARTBEAT_MS);
  return async () => {
    generation += 1;
    clearInterval(timer);
    try {
      await inflight;
    } catch {
      // Heartbeat is best-effort; stop must not fail the 429/abort path.
    }
  };
}
