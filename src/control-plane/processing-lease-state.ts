import { PROCESSING_LEASE_TTL_MS } from "./constants";
import { scheduleCleanupAlarm } from "./do-alarm";

// Shared expiring-fenced-lease book for TenantUsageGuard and GlobalUsageGuard.
// One lease per attempt key. Capacity is in-flight rows plus unexpired paused
// rows. Duplicate acquire of the same key returns the existing fence (no second
// permit). An in-flight holder blocks a second paid start until pause (429) or
// complete (release). Sweep must not steal an in-flight row when its TTL
// elapses — the owner heartbeat/presentLease path still renews.

export const LEASE_KEY_PREFIX = "lease:";

export type LeaseRecord = {
  fence: string;
  expiresAt: number;
  inFlight: boolean;
};

export type LeaseDenyReason = "contention" | "stale_fence";

export type LeaseDecision =
  | { ok: true; fence: string; alreadyRunning: boolean; expiresAt: number }
  | { ok: false; reason: LeaseDenyReason };

export function leaseStorageKey(id: string): string {
  return `${LEASE_KEY_PREFIX}${id}`;
}

export function isLeaseKey(key: string): boolean {
  return key.startsWith(LEASE_KEY_PREFIX);
}

export function newLeaseFence(): string {
  return crypto.randomUUID();
}

function asLease(value: unknown): LeaseRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.fence !== "string" || row.fence.length === 0) return null;
  if (typeof row.expiresAt !== "number" || !Number.isFinite(row.expiresAt)) return null;
  return {
    fence: row.fence,
    expiresAt: row.expiresAt,
    inFlight: row.inFlight === true,
  };
}

function leaseOccupiesSlot(lease: LeaseRecord, nowMs: number): boolean {
  return lease.inFlight || nowMs < lease.expiresAt;
}

export async function sweepExpiredLeases(
  storage: DurableObjectStorage,
  nowMs: number,
): Promise<number | null> {
  const entries = await storage.list({ prefix: LEASE_KEY_PREFIX });
  let nextAlarm: number | null = null;
  for (const [key, value] of entries) {
    if (!isLeaseKey(key)) continue;
    const lease = asLease(value);
    if (!lease) {
      await storage.delete(key);
      continue;
    }
    if (lease.inFlight) {
      if (nowMs < lease.expiresAt && (nextAlarm == null || lease.expiresAt < nextAlarm)) {
        nextAlarm = lease.expiresAt;
      }
      continue;
    }
    if (nowMs >= lease.expiresAt) {
      await storage.delete(key);
      continue;
    }
    if (nextAlarm == null || lease.expiresAt < nextAlarm) nextAlarm = lease.expiresAt;
  }
  return nextAlarm;
}

async function liveLeaseCount(storage: DurableObjectStorage, nowMs: number): Promise<number> {
  const entries = await storage.list({ prefix: LEASE_KEY_PREFIX });
  let count = 0;
  for (const [key, value] of entries) {
    if (!isLeaseKey(key)) continue;
    const lease = asLease(value);
    if (lease && leaseOccupiesSlot(lease, nowMs)) count += 1;
  }
  return count;
}

async function putLease(
  storage: DurableObjectStorage,
  key: string,
  lease: LeaseRecord,
): Promise<void> {
  await storage.put(key, lease);
  await scheduleCleanupAlarm(storage, Date.now() + PROCESSING_LEASE_TTL_MS);
}

export async function acquireLease(
  storage: DurableObjectStorage,
  opts: { id: string; limit: number; nowMs: number },
): Promise<LeaseDecision> {
  await sweepExpiredLeases(storage, opts.nowMs);
  const key = leaseStorageKey(opts.id);
  const existing = asLease(await storage.get(key));
  if (existing && leaseOccupiesSlot(existing, opts.nowMs)) {
    if (existing.inFlight) {
      return {
        ok: true,
        fence: existing.fence,
        alreadyRunning: true,
        expiresAt: existing.expiresAt,
      };
    }
    const resumed: LeaseRecord = {
      ...existing,
      inFlight: true,
      expiresAt: opts.nowMs + PROCESSING_LEASE_TTL_MS,
    };
    await putLease(storage, key, resumed);
    return { ok: true, fence: resumed.fence, alreadyRunning: false, expiresAt: resumed.expiresAt };
  }

  const live = await liveLeaseCount(storage, opts.nowMs);
  if (live >= opts.limit) {
    return { ok: false, reason: "contention" };
  }
  const created: LeaseRecord = {
    fence: newLeaseFence(),
    expiresAt: opts.nowMs + PROCESSING_LEASE_TTL_MS,
    inFlight: true,
  };
  await putLease(storage, key, created);
  return { ok: true, fence: created.fence, alreadyRunning: false, expiresAt: created.expiresAt };
}

function fenceMismatchOrIdleExpired(
  existing: LeaseRecord | null,
  opts: { fence: string; nowMs: number },
): { stale: true; drop: boolean } | { stale: false; lease: LeaseRecord } {
  if (!existing) return { stale: true, drop: false };
  if (existing.fence !== opts.fence) return { stale: true, drop: false };
  if (!existing.inFlight && opts.nowMs >= existing.expiresAt) return { stale: true, drop: true };
  return { stale: false, lease: existing };
}

export async function renewLease(
  storage: DurableObjectStorage,
  opts: { id: string; fence: string; nowMs: number; preserveInFlight?: boolean },
): Promise<LeaseDecision> {
  const key = leaseStorageKey(opts.id);
  const existing = asLease(await storage.get(key));
  const verdict = fenceMismatchOrIdleExpired(existing, opts);
  if (verdict.stale) {
    if (verdict.drop) await storage.delete(key);
    return { ok: false, reason: "stale_fence" };
  }
  const next: LeaseRecord = {
    ...verdict.lease,
    inFlight: opts.preserveInFlight === true ? verdict.lease.inFlight : true,
    expiresAt: opts.nowMs + PROCESSING_LEASE_TTL_MS,
  };
  await putLease(storage, key, next);
  return { ok: true, fence: next.fence, alreadyRunning: false, expiresAt: next.expiresAt };
}

export async function pauseLease(
  storage: DurableObjectStorage,
  opts: { id: string; fence: string; nowMs: number },
): Promise<LeaseDecision> {
  const key = leaseStorageKey(opts.id);
  const existing = asLease(await storage.get(key));
  const verdict = fenceMismatchOrIdleExpired(existing, opts);
  if (verdict.stale) {
    if (verdict.drop) await storage.delete(key);
    return { ok: false, reason: "stale_fence" };
  }
  const next: LeaseRecord = {
    ...verdict.lease,
    inFlight: false,
    expiresAt: opts.nowMs + PROCESSING_LEASE_TTL_MS,
  };
  await putLease(storage, key, next);
  return { ok: true, fence: next.fence, alreadyRunning: false, expiresAt: next.expiresAt };
}

export async function releaseLease(
  storage: DurableObjectStorage,
  opts: { id: string; fence: string; nowMs: number },
): Promise<LeaseDecision> {
  const key = leaseStorageKey(opts.id);
  const existing = asLease(await storage.get(key));
  if (!existing) return { ok: true, fence: opts.fence, alreadyRunning: false, expiresAt: opts.nowMs };
  if (existing.fence !== opts.fence) return { ok: false, reason: "stale_fence" };
  await storage.delete(key);
  return { ok: true, fence: opts.fence, alreadyRunning: false, expiresAt: existing.expiresAt };
}

// #256 dead-lease recovery. An inFlight row whose holder died is invisible to
// the sweep (B1: sweeping inFlight would let a second paid start overlap the
// fence), so recovery is explicit. peekLease reads the row without touching
// capacity — acquire would create a fresh row this path never uses and would
// contend with the live foreign rows that fill the cap in exactly the wedged
// state being recovered. clearDeadLease removes the row only under
// compare-and-set on the observed expiresAt — the operator's fence stand-in,
// since fences never leave the guard. A row that moved (renewed by a live
// holder's heartbeat, paused, released, re-acquired) refuses rather than
// steals.

export type LeasePeek =
  | { present: false }
  | { present: true; fence: string; expiresAt: number; inFlight: boolean };

export async function peekLease(
  storage: DurableObjectStorage,
  opts: { id: string },
): Promise<LeasePeek> {
  const lease = asLease(await storage.get(leaseStorageKey(opts.id)));
  if (!lease) return { present: false };
  return {
    present: true,
    fence: lease.fence,
    expiresAt: lease.expiresAt,
    inFlight: lease.inFlight,
  };
}

export type DeadLeaseClearDecision =
  | { ok: true; cleared: boolean }
  | { ok: false; reason: "changed" | "not_in_flight" | "not_overdue" };

// Compare-and-set removal of one lease row. `expectedExpiresAt` is the
// caller's observation of the row at decision time; a row that moved
// (renewed by a live holder's heartbeat, paused, released, re-acquired)
// refuses rather than steals. `requireOverdue` (the default) additionally
// demands that the row's TTL lapsed — the heartbeat-based proof that the
// holder is dead, which is the operator's and the defer-ceiling path's only
// evidence. The Worker's terminal/purged recovery passes false: there the
// proof is that the work is over or its target is gone, not that the holder
// stopped, and refusing to touch a not-yet-expired row would strand a
// holder that died seconds after committing.
export async function clearDeadLease(
  storage: DurableObjectStorage,
  opts: { id: string; expectedExpiresAt: number | null; nowMs: number; requireOverdue?: boolean },
): Promise<DeadLeaseClearDecision> {
  const key = leaseStorageKey(opts.id);
  const existing = asLease(await storage.get(key));
  // Absent is success: the goal is "no orphaned row", and a row legitimately
  // released or swept already satisfies it. Re-running a completed clear
  // converges instead of erroring.
  if (!existing) return { ok: true, cleared: false };
  // The observed expiresAt is the compare-and-set fence. null means the caller
  // observed absence, so a row that appeared since is a NEW holder's live
  // permit; any other mismatch means a heartbeat, pause, or re-acquire moved
  // the row and the observation is stale.
  if (opts.expectedExpiresAt === null || existing.expiresAt !== opts.expectedExpiresAt) {
    return { ok: false, reason: "changed" };
  }
  if (!existing.inFlight) {
    // A paused row is 429-parked, not orphaned: its holder means to resume,
    // and the ordinary expiry sweep owns its end.
    return { ok: false, reason: "not_in_flight" };
  }
  if (opts.requireOverdue !== false && existing.expiresAt > opts.nowMs) {
    // Not overdue: the holder may merely be between heartbeats. Only a row
    // whose TTL lapsed without a renew is evidence the holder is gone.
    return { ok: false, reason: "not_overdue" };
  }
  await storage.delete(key);
  return { ok: true, cleared: true };
}
