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
  if (await isRetired(storage, opts.id)) return { ok: false, reason: "stale_fence" };
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
  if (await isRetired(storage, opts.id)) return { ok: false, reason: "stale_fence" };
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
  if (await isRetired(storage, opts.id)) return { ok: false, reason: "stale_fence" };
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

// Recovery observations contain no dispatch credentials.
export type LeasePeek =
  | { present: false }
  | { present: true; expiresAt: number; inFlight: boolean };

export async function peekLease(storage: DurableObjectStorage, opts: { id: string }): Promise<LeasePeek> {
  const raw = await storage.get(leaseStorageKey(opts.id));
  if (raw === undefined) return { present: false };
  const lease = asLease(raw);
  if (!lease) throw new Error("invalid stored lease");
  return { present: true, expiresAt: lease.expiresAt, inFlight: lease.inFlight };
}

export type DeadLeaseClearDecision =
  | { ok: true; cleared: boolean }
  | { ok: false; reason: "changed" | "not_in_flight" | "not_overdue" };

export function checkLeaseRecovery(
  row: LeasePeek,
  expectedExpiresAt: number | null,
  nowMs: number,
  requireOverdue: boolean,
): DeadLeaseClearDecision {
  if (!row.present) return { ok: true, cleared: false };
  if (row.expiresAt !== expectedExpiresAt) return { ok: false, reason: "changed" };
  if (!row.inFlight) return { ok: false, reason: "not_in_flight" };
  if (requireOverdue && row.expiresAt > nowMs) return { ok: false, reason: "not_overdue" };
  return { ok: true, cleared: true };
}

// Only recovered attempts get a marker. It consumes no capacity and contains
// no credentials/content. Keep it until tenant teardown: a delayed delivery
// must never reacquire this attempt, including after recovery dies before the
// terminal manifest write. User retries mint a different attempt id.
const retirementKey = (id: string) => `retired-lease:${id}`;

async function isRetired(storage: DurableObjectStorage, id: string): Promise<boolean> {
  return await storage.get(retirementKey(id)) !== undefined;
}

// Called under the tenant guard's lock. Persist retirement BEFORE deleting
// capacity, so a crash or lost response remains safe and replayable.
export async function retireLease(
  storage: DurableObjectStorage,
  opts: { id: string; expectedExpiresAt: number | null; nowMs: number; requireOverdue: boolean },
): Promise<DeadLeaseClearDecision> {
  const row = await peekLease(storage, opts);
  const decision = checkLeaseRecovery(row, opts.expectedExpiresAt, opts.nowMs, opts.requireOverdue);
  if (!decision.ok) return decision;
  await storage.put(retirementKey(opts.id), true);
  if (row.present) await storage.delete(leaseStorageKey(opts.id));
  return decision;
}
