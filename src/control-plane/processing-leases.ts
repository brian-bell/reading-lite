import type { Env } from "../index";
import { PROCESSING_DEFER_DELAY_SECONDS, PROCESSING_LEASE_HEARTBEAT_MS } from "./constants";
import { globalUsageFor, type GlobalUsage } from "./global-usage-guard";
import type { DeadLeaseClearDecision } from "./processing-lease-state";
import {
  tenantUsageFor,
  type LeasePeekDecision,
  type ProcessingLeaseDecision,
  type TenantUsage,
} from "./tenant-usage-guard";

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
//
// #256: a tenant alreadyRunning answer returns a RELEASE-ONLY hold instead of
// a bare marker. The inFlight row belongs to a delivery that is either still
// running this attempt (the hold must never steal, renew, or dispatch paid
// work) or died (the hold is the only thing that can ever release the row,
// because the sweep deliberately never touches inFlight). The release gates —
// terminal manifest, defer ceiling, or an operator's compare-and-set clear —
// decide when that release is legitimate; this module only carries the fences.

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

// A hold adopted from an attempt whose tenant row is already inFlight. It
// authorizes RELEASE ONLY: never a heartbeat, a renew, or a paid dispatch.
// The global observation is one of three states:
//   - present: an inFlight global row (fence + expiresAt)
//   - confirmed absent / paused: globalUnknown false, fences null — tenant-only
//   - unknown: peek threw or returned unavailable. This is NOT absence. Death
//     cannot be proved from the tenant row alone (a live holder may have
//     renewed only its global side), and the already-running path must stay
//     on LiveHolderDeferError rather than mapping onto acquire-unavailable
//     (the ceiling catch would markFailed).
// The expiresAt stamps ride along for overdue diagnostics; fences never leave
// the worker.
export type ProcessingLeaseReleaseHold = {
  tenantId: string;
  attemptId: string;
  tenantFence: string;
  tenantExpiresAtMs: number;
  globalUnknown: boolean;
  globalFence: string | null;
  globalExpiresAtMs: number | null;
};

export type AcquireProcessingLeasesResult =
  | { ok: true; alreadyRunning: true; releaseHold: ProcessingLeaseReleaseHold }
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
  if (tenantResult.alreadyRunning) {
    // Release-only adoption (#256): the tenant row for THIS attempt is
    // inFlight, so a delivery is either already running it (never steal,
    // never re-dispatch paid work) or the holder died. Peek the global row
    // rather than acquiring one: a fresh global row would consume a slot
    // this path never uses and could itself be orphaned, and acquire would
    // contend with the live foreign rows that fill the cap in exactly the
    // wedged state this recovers.
    return {
      ok: true,
      alreadyRunning: true,
      releaseHold: {
        tenantId,
        attemptId,
        tenantFence: tenantResult.fence,
        tenantExpiresAtMs: tenantResult.expiresAtMs,
        ...(await peekGlobalInFlight(deps, tenantId, attemptId)),
      },
    };
  }

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

type GlobalLeaseObservation =
  | { globalUnknown: true; globalFence: null; globalExpiresAtMs: null }
  | { globalUnknown: false; globalFence: string; globalExpiresAtMs: number }
  | { globalUnknown: false; globalFence: null; globalExpiresAtMs: null };

// The global half of a release-only hold. Confirmed absence and a paused
// (!inFlight) row stay tenant-only. An unavailable peek — thrown or
// `{ ok: false }` — is an explicit unknown: prove-dead is false and
// clearOrphaned must not tenant-clear. Do not collapse that onto acquire
// `{ ok: false, reason: "unavailable" }`; throwIfDeferred would turn it
// into DeferPaidWorkError and the ceiling catch would markFailed.
async function peekGlobalInFlight(
  deps: ProcessingLeaseDeps,
  tenantId: string,
  attemptId: string,
): Promise<GlobalLeaseObservation> {
  let peek: LeasePeekDecision;
  try {
    peek = await deps.global.peekLease(tenantId, attemptId);
  } catch {
    return { globalUnknown: true, globalFence: null, globalExpiresAtMs: null };
  }
  if (!peek.ok) {
    return { globalUnknown: true, globalFence: null, globalExpiresAtMs: null };
  }
  if (!peek.present || !peek.inFlight) {
    return { globalUnknown: false, globalFence: null, globalExpiresAtMs: null };
  }
  return { globalUnknown: false, globalFence: peek.fence, globalExpiresAtMs: peek.expiresAtMs };
}

// Peek-only release hold for paths that never acquired: the reading is
// provably terminal (or purged), so an inFlight tenant row for this attempt
// is a dead holder's leftover. A live holder that just terminalized and has
// not released yet is harmless — release is idempotent and it has no further
// paid dispatch for the fence to protect. Absent or non-inFlight tenant row →
// null (nothing to recover).
export async function peekProcessingLeaseReleaseHold(
  env: Env,
  tenantId: string,
  attemptId: string,
  deps: ProcessingLeaseDeps = processingLeaseDepsFor(env, tenantId),
): Promise<ProcessingLeaseReleaseHold | null> {
  let tenantPeek: LeasePeekDecision;
  try {
    tenantPeek = await deps.tenant.peekLease(attemptId);
  } catch {
    return null;
  }
  if (!tenantPeek.ok || !tenantPeek.present || !tenantPeek.inFlight) return null;
  return {
    tenantId,
    attemptId,
    tenantFence: tenantPeek.fence,
    tenantExpiresAtMs: tenantPeek.expiresAtMs,
    ...(await peekGlobalInFlight(deps, tenantId, attemptId)),
  };
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
  hold: ProcessingLeaseHold | ProcessingLeaseReleaseHold,
  nowMs: number,
  deps: ProcessingLeaseDeps = processingLeaseDepsFor(env, hold.tenantId),
): Promise<void> {
  // A release-only hold with no observed global row has nothing to release on
  // that side; a work hold always carries its own fence.
  if (hold.globalFence !== null) {
    try {
      await deps.global.releaseLease(hold.tenantId, hold.attemptId, hold.globalFence, nowMs);
    } catch {
      // Conservative: uncertain global release stays counted until expiry.
    }
  }
  try {
    await deps.tenant.releaseLease(hold.attemptId, hold.tenantFence, nowMs);
  } catch {
    // Conservative: uncertain tenant release stays counted until expiry.
  }
}

// Atomic compare-and-set clear for the release-only recovery paths. The
// delivery's own gate (whatever evidence it used) is NOT proof by itself — a
// stalled holder can renew between observation and this call, and renew
// preserves the fence, so a blind release would delete the freshly renewed
// row anyway. The DO's clear_dead_lease re-verifies the observed expiresAt at
// delete time under its own lock: a row that moved refuses, absent converges,
// and a refusal leaves the rows to their possibly-live holder. The
// defer-ceiling path passes requireOverdue (default) — its only death
// evidence is the lapsed heartbeat. The terminal/purged paths pass false:
// their proof is the work state, and refusing to touch a not-yet-expired row
// would strand a holder that died seconds after committing.
//
// Global-first: do not tenant-clear until the observed global row is cleared
// or confirmed absent. A leftover tenant row is what peekProcessingLeaseReleaseHold
// needs to see the global side again; tenant-clearing first after a global
// error or `changed` (live holder renewed) is permanent global-capacity loss
// and can terminalize under an in-flight provider request. An unknown-global
// hold refuses without touching either row. Callers gate markFailed on this
// decision — a refusal becomes LiveHolderDeferError and both rows remain.
export async function clearOrphanedProcessingLeases(
  env: Env,
  hold: ProcessingLeaseReleaseHold,
  deps: ProcessingLeaseDeps = processingLeaseDepsFor(env, hold.tenantId),
  opts: { requireOverdue?: boolean } = {},
): Promise<DeadLeaseClearDecision> {
  if (hold.globalUnknown) {
    return { ok: false, reason: "changed" };
  }
  if (hold.globalFence !== null && hold.globalExpiresAtMs !== null) {
    let globalDecision: DeadLeaseClearDecision;
    try {
      globalDecision = await deps.global.clearDeadLease(
        hold.tenantId,
        hold.attemptId,
        hold.globalExpiresAtMs,
        opts,
      );
    } catch {
      return { ok: false, reason: "changed" };
    }
    if (!globalDecision.ok) return globalDecision;
  }
  try {
    return await deps.tenant.clearDeadLease(hold.attemptId, hold.tenantExpiresAtMs, opts);
  } catch {
    // An errored clear proves nothing; report it as a refusal so callers
    // treat the holder as possibly live.
    return { ok: false, reason: "changed" };
  }
}

// A release-only hold proves its holder dead only through the heartbeat: an
// inFlight row whose TTL lapsed without a renew is the same evidence the
// operator clear requires. Unknown global is not "no evidence" — a live
// holder can have an overdue tenant row and a fresh global row that this
// delivery failed to observe. A confirmed-absent or paused global may stay
// tenant-only. A row still inside its TTL may belong to a live holder
// between heartbeats, so it must not be released on age-of-attempt alone.
export function releaseHoldProvesDeadHolder(hold: ProcessingLeaseReleaseHold, nowMs: number): boolean {
  if (hold.globalUnknown) return false;
  if (nowMs < hold.tenantExpiresAtMs) return false;
  if (hold.globalExpiresAtMs !== null && nowMs < hold.globalExpiresAtMs) return false;
  return true;
}

export type AcquiredProcessingLeases =
  | { kind: "work"; hold: ProcessingLeaseHold }
  | { kind: "release_only"; hold: ProcessingLeaseReleaseHold };

export function throwIfDeferred(result: AcquireProcessingLeasesResult): AcquiredProcessingLeases {
  if (result.ok && result.alreadyRunning) return { kind: "release_only", hold: result.releaseHold };
  if (result.ok) return { kind: "work", hold: result.hold };
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
