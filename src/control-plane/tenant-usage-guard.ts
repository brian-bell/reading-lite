import { TenantRecoveryRequestSchema, tenantLeaseRecovery, type TenantRecoveryRequest } from "./processing-lease-recovery";
import { inspectTenant } from "./operator-inspection";
import type { Env } from "../index";
import { bumpWindow } from "./auth-rate-guard";
import { INGRESS_REQUEST_WINDOW_MS, READING_RESERVATION_TTL_MS } from "./constants";
import { scheduleCleanupAlarm } from "./do-alarm";
import { logUnboundGuardPurge } from "./global-usage-guard";
import { parseTenantId } from "./ids";
import {
  acquireLease as acquireStoredLease,
  isLeaseKey,
  pauseLease as pauseStoredLease,
  releaseLease as releaseStoredLease,
  renewLease as renewStoredLease,
  sweepExpiredLeases,
  type LeaseDecision,
} from "./processing-lease-state";

// TenantUsageGuard serializes one tenant's ingress request-rate token bucket,
// paid-work reading-slot reservations (hourly + monthly), and concurrent-work
// leases. D1 tenant_limits is the policy source of truth; callers cannot supply
// limits. Missing or invalid limits, and an unavailable Durable Object, fail
// closed.
//
// Request-rate counts every intake write. Reading slots are reserved only for
// an activation attempt (idempotent on attempt id) and released when the
// attempt never reaches summarization dispatch. GlobalUsageGuard owns spend
// and the paid-work switch. Concurrent-work leases are fenced
// and expiring; the holder presents the fence before renew, paid dispatch,
// and release.

type WindowRecord = { start: number; count: number; windowMs?: number };
type CounterRecord = { count: number };
type ReservationStatus = "held" | "consumed" | "released";
type Reservation = {
  status: ReservationStatus;
  hourKey: string;
  monthKey: string;
  expiresAt: number;
};

type TenantIngressLimits = {
  submissionsPerHour: number;
  monthlyReadings: number;
};

type AdmitRequestBody = { kind: "admit_request"; tenantId: string; nowMs: number };
type ReserveReadingBody = {
  kind: "reserve_reading";
  tenantId: string;
  opId: string;
  nowMs: number;
};
type RefreshReadingBody = {
  kind: "refresh_reading";
  tenantId: string;
  opId: string;
  nowMs: number;
};
type ReleaseReadingBody = { kind: "release_reading"; opId: string };
type CommitReadingBody = { kind: "commit_reading"; opId: string };
type AcquireLeaseBody = { kind: "acquire_lease"; tenantId: string; attemptId: string; nowMs: number };
type FenceLeaseBody = {
  kind: "renew_lease" | "pause_lease" | "release_lease";
  attemptId: string;
  fence: string;
  nowMs: number;
  preserveInFlight?: boolean;
};
/**
 * Account teardown (issue 195 S4): empty this tenant's guard entirely.
 *
 * This DO is `idFromName(tenantId)`, so every key it holds — the request-rate
 * window, the hourly/monthly counters, the reading reservations, and the
 * concurrency leases — belongs to the one tenant being deleted. That is what
 * makes `deleteAll()` the right verb here and the wrong one on the singleton
 * `GlobalUsageGuard`, which purges by key prefix instead.
 *
 * `deleteAll()` does not cancel a pending alarm, so the alarm is deleted too;
 * otherwise the object would be woken up again after deletion to sweep storage
 * that is already gone.
 */
type PurgeTenantBody = { kind: "purge_tenant"; tenantId: string };
type GuardBody =
  | TenantRecoveryRequest
  | { kind: "tenant_status"; tenantId: string }
  | PurgeTenantBody
  | AdmitRequestBody
  | ReserveReadingBody
  | RefreshReadingBody
  | ReleaseReadingBody
  | CommitReadingBody
  | AcquireLeaseBody
  | FenceLeaseBody;

export type UsageDenyReason =
  | "request_rate"
  | "hourly"
  | "monthly"
  | "missing_limits"
  | "unavailable";

export type LeaseDenyReason = "contention" | "stale_fence" | "missing_limits" | "unavailable";

export type ProcessingLeaseDecision =
  | { ok: true; fence: string; alreadyRunning: boolean; expiresAtMs: number }
  | { ok: false; reason: LeaseDenyReason };

export type UsageDecision =
  | { ok: true }
  | { ok: false; reason: UsageDenyReason; resetAtMs?: number };

export interface TenantUsage {
  admitRequest(nowMs: number): Promise<UsageDecision>;
  reserveReading(opId: string, nowMs: number): Promise<UsageDecision>;
  refreshReading(opId: string, nowMs: number): Promise<void>;
  releaseReading(opId: string): Promise<void>;
  commitReading(opId: string): Promise<UsageDecision>;
  acquireLease(attemptId: string, nowMs: number): Promise<ProcessingLeaseDecision>;
  renewLease(
    attemptId: string,
    fence: string,
    nowMs: number,
    opts?: { preserveInFlight?: boolean },
  ): Promise<ProcessingLeaseDecision>;
  pauseLease(attemptId: string, fence: string, nowMs: number): Promise<ProcessingLeaseDecision>;
  releaseLease(attemptId: string, fence: string, nowMs: number): Promise<void>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function utcHourKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 13);
}

export function utcMonthKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

export function utcHourResetAt(nowMs: number): number {
  const d = new Date(nowMs);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 1);
  return d.getTime();
}

export function utcMonthResetAt(nowMs: number): number {
  const d = new Date(Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth() + 1, 1));
  return d.getTime();
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

async function loadLimits(env: Env, tenantId: string): Promise<TenantIngressLimits | null> {
  try {
    const row = await env.CONTROL_PLANE.prepare(
      `SELECT submissions_per_hour, monthly_readings
       FROM tenant_limits WHERE tenant_id = ?`,
    )
      .bind(tenantId)
      .first<{ submissions_per_hour: number; monthly_readings: number }>();
    if (!row) return null;
    const submissionsPerHour = positiveInt(row.submissions_per_hour);
    const monthlyReadings = positiveInt(row.monthly_readings);
    if (submissionsPerHour === null || monthlyReadings === null) return null;
    return { submissionsPerHour, monthlyReadings };
  } catch {
    return null;
  }
}

async function loadConcurrencyLimit(env: Env, tenantId: string): Promise<number | null> {
  try {
    const row = await env.CONTROL_PLANE.prepare(
      `SELECT max_concurrent_work FROM tenant_limits WHERE tenant_id = ?`,
    )
      .bind(tenantId)
      .first<{ max_concurrent_work: number }>();
    if (!row) return null;
    return positiveInt(row.max_concurrent_work);
  } catch {
    return null;
  }
}

function parseGuardBody(value: unknown): GuardBody | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const kind = body.kind;
  if (kind === "peek_lease" || kind === "retire_lease") {
    const parsed = TenantRecoveryRequestSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  }
  if (kind === "tenant_status") {
    const tenantId = parseTenantId(typeof body.tenantId === "string" ? body.tenantId : "");
    return tenantId ? { kind, tenantId } : null;
  }
  if (kind === "purge_tenant") {
    const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
    // Shape check only — it does not, and cannot cheaply, prove the id names
    // *this* object. Routing is what does that: the sole caller derives the
    // stub from `idFromName(tenantId)`, so the request lands on the object the
    // id names. This rejects a malformed body rather than emptying an object
    // on the strength of one.
    return parseTenantId(tenantId) ? { kind, tenantId } : null;
  }
  if (kind === "admit_request") {
    const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
    const nowMs = Number(body.nowMs);
    if (!tenantId || !Number.isFinite(nowMs) || nowMs < 0) return null;
    return { kind, tenantId, nowMs };
  }
  if (kind === "reserve_reading" || kind === "refresh_reading") {
    const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
    const opId = typeof body.opId === "string" ? body.opId : "";
    const nowMs = Number(body.nowMs);
    if (!tenantId || !opId || !Number.isFinite(nowMs) || nowMs < 0) return null;
    return { kind, tenantId, opId, nowMs };
  }
  if (kind === "release_reading" || kind === "commit_reading") {
    const opId = typeof body.opId === "string" ? body.opId : "";
    if (!opId) return null;
    return { kind, opId };
  }
  if (kind === "acquire_lease") {
    const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
    const attemptId = typeof body.attemptId === "string" ? body.attemptId : "";
    const nowMs = Number(body.nowMs);
    if (!tenantId || !attemptId || !Number.isFinite(nowMs) || nowMs < 0) return null;
    return { kind, tenantId, attemptId, nowMs };
  }
  if (kind === "renew_lease" || kind === "pause_lease" || kind === "release_lease") {
    const attemptId = typeof body.attemptId === "string" ? body.attemptId : "";
    const fence = typeof body.fence === "string" ? body.fence : "";
    const nowMs = Number(body.nowMs);
    if (!attemptId || !fence || !Number.isFinite(nowMs) || nowMs < 0) return null;
    return {
      kind,
      attemptId,
      fence,
      nowMs,
      ...(kind === "renew_lease" && body.preserveInFlight === true ? { preserveInFlight: true } : {}),
    };
  }
  return null;
}

async function counterOf(storage: DurableObjectStorage, key: string): Promise<number> {
  const current = (await storage.get(key)) as CounterRecord | undefined;
  return current && typeof current.count === "number" && current.count >= 0 ? current.count : 0;
}

async function putCounter(storage: DurableObjectStorage, key: string, count: number): Promise<void> {
  await storage.put(key, { count });
}

async function decrementCounter(storage: DurableObjectStorage, key: string): Promise<void> {
  const count = await counterOf(storage, key);
  if (count <= 1) {
    await storage.delete(key);
    return;
  }
  await putCounter(storage, key, count - 1);
}

export class TenantUsageGuard implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }
    let parsed: GuardBody | null = null;
    try {
      parsed = parseGuardBody(await request.json());
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (!parsed) return json({ error: "invalid_body" }, 400);
    const body = parsed;
    return this.state.blockConcurrencyWhile(async () => {
      if (body.kind === "peek_lease" || body.kind === "retire_lease") return json(await tenantLeaseRecovery(this.state.storage, body));
      if (body.kind === "tenant_status") {
        const limits = await this.env.CONTROL_PLANE.prepare("SELECT policy_version, submissions_per_hour, monthly_readings, max_concurrent_work FROM tenant_limits WHERE tenant_id = ?").bind(body.tenantId).first();
        return json(await inspectTenant(this.state.storage, Date.now(), limits));
      }
      if (body.kind === "purge_tenant") return this.purgeTenant();
      if (body.kind === "admit_request") return this.admitRequest(body);
      if (body.kind === "reserve_reading") return this.reserveReading(body);
      if (body.kind === "refresh_reading") return this.refreshReading(body);
      if (body.kind === "release_reading") return this.releaseReading(body);
      if (body.kind === "commit_reading") return this.commitReading(body);
      if (body.kind === "acquire_lease") return this.acquireLease(body);
      if (body.kind === "renew_lease") return this.renewHeldLease(body);
      if (body.kind === "pause_lease") return this.pauseHeldLease(body);
      return this.releaseHeldLease(body);
    });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      await this.cleanup(Date.now());
    });
  }

  /**
   * Empty this tenant's guard. Idempotent — an already-empty object purges
   * nothing and still answers ok, which is what lets teardown be retried.
   */
  private async purgeTenant(): Promise<Response> {
    await this.state.storage.deleteAll();
    await this.state.storage.deleteAlarm();
    return json({ ok: true });
  }

  private async admitRequest(body: AdmitRequestBody): Promise<Response> {
    const limits = await this.requireLimits(body.tenantId);
    if (!limits.ok) return json(limits);
    const now = body.nowMs;
    const current = (await this.state.storage.get("req")) as WindowRecord | undefined;
    const next = bumpWindow(current, now, INGRESS_REQUEST_WINDOW_MS);
    await this.state.storage.put("req", { ...next, windowMs: INGRESS_REQUEST_WINDOW_MS });
    await scheduleCleanupAlarm(this.state.storage, Date.now() + INGRESS_REQUEST_WINDOW_MS);
    if (next.count > limits.limits.submissionsPerHour) {
      return json({ ok: false, reason: "request_rate", reset_at: next.start + INGRESS_REQUEST_WINDOW_MS });
    }
    return json({ ok: true });
  }

  private async reserveReading(body: ReserveReadingBody): Promise<Response> {
    const limits = await this.requireLimits(body.tenantId);
    if (!limits.ok) return json(limits);
    const opKey = `op:${body.opId}`;
    const existing = (await this.state.storage.get(opKey)) as Reservation | undefined;
    if (existing && (existing.status === "held" || existing.status === "consumed")) {
      return json({ ok: true });
    }

    const hourKey = utcHourKey(body.nowMs);
    const monthKey = utcMonthKey(body.nowMs);
    const hourCount = await counterOf(this.state.storage, `h:${hourKey}`);
    if (hourCount >= limits.limits.submissionsPerHour) {
      return json({ ok: false, reason: "hourly", reset_at: utcHourResetAt(body.nowMs) });
    }
    const monthCount = await counterOf(this.state.storage, `m:${monthKey}`);
    if (monthCount >= limits.limits.monthlyReadings) {
      return json({ ok: false, reason: "monthly", reset_at: utcMonthResetAt(body.nowMs) });
    }

    await putCounter(this.state.storage, `h:${hourKey}`, hourCount + 1);
    await putCounter(this.state.storage, `m:${monthKey}`, monthCount + 1);
    const expiresAt = Date.now() + READING_RESERVATION_TTL_MS;
    await this.state.storage.put(opKey, {
      status: "held",
      hourKey,
      monthKey,
      expiresAt,
    } satisfies Reservation);
    await scheduleCleanupAlarm(this.state.storage, expiresAt);
    return json({ ok: true });
  }

  private async refreshReading(body: RefreshReadingBody): Promise<Response> {
    const opKey = `op:${body.opId}`;
    const existing = (await this.state.storage.get(opKey)) as Reservation | undefined;
    if (!existing || existing.status !== "held") return json({ ok: true });
    const expiresAt = body.nowMs + READING_RESERVATION_TTL_MS;
    await this.state.storage.put(opKey, { ...existing, expiresAt } satisfies Reservation);
    await scheduleCleanupAlarm(this.state.storage, expiresAt);
    return json({ ok: true });
  }

  private async releaseReading(body: ReleaseReadingBody): Promise<Response> {
    const opKey = `op:${body.opId}`;
    const existing = (await this.state.storage.get(opKey)) as Reservation | undefined;
    if (!existing || existing.status !== "held") return json({ ok: true });
    await decrementCounter(this.state.storage, `h:${existing.hourKey}`);
    await decrementCounter(this.state.storage, `m:${existing.monthKey}`);
    await this.state.storage.put(opKey, { ...existing, status: "released" } satisfies Reservation);
    return json({ ok: true });
  }

  private async commitReading(body: CommitReadingBody): Promise<Response> {
    const opKey = `op:${body.opId}`;
    const existing = (await this.state.storage.get(opKey)) as Reservation | undefined;
    if (!existing || existing.status === "consumed") return json({ ok: true });
    if (existing.status === "released") return json({ ok: true });
    await this.state.storage.put(opKey, { ...existing, status: "consumed" } satisfies Reservation);
    return json({ ok: true });
  }

  private async acquireLease(body: AcquireLeaseBody): Promise<Response> {
    const limit = await this.requireConcurrency(body.tenantId);
    if (!limit.ok) return json(limit);
    return jsonLease(await acquireStoredLease(this.state.storage, { id: body.attemptId, limit: limit.limit, nowMs: body.nowMs }));
  }

  private async renewHeldLease(body: FenceLeaseBody): Promise<Response> {
    return jsonLease(
      await renewStoredLease(this.state.storage, {
        id: body.attemptId,
        fence: body.fence,
        nowMs: body.nowMs,
        preserveInFlight: body.preserveInFlight === true,
      }),
    );
  }

  private async pauseHeldLease(body: FenceLeaseBody): Promise<Response> {
    return jsonLease(await pauseStoredLease(this.state.storage, { id: body.attemptId, fence: body.fence, nowMs: body.nowMs }));
  }

  private async releaseHeldLease(body: FenceLeaseBody): Promise<Response> {
    return jsonLease(await releaseStoredLease(this.state.storage, { id: body.attemptId, fence: body.fence, nowMs: body.nowMs }));
  }

  private async requireConcurrency(
    tenantId: string,
  ): Promise<{ ok: true; limit: number } | { ok: false; reason: "missing_limits" }> {
    if (!parseTenantId(tenantId)) return { ok: false, reason: "missing_limits" };
    const limit = await loadConcurrencyLimit(this.env, tenantId);
    if (limit === null) return { ok: false, reason: "missing_limits" };
    return { ok: true, limit };
  }

  private async requireLimits(
    tenantId: string,
  ): Promise<{ ok: true; limits: TenantIngressLimits } | { ok: false; reason: "missing_limits" }> {
    if (!parseTenantId(tenantId)) return { ok: false, reason: "missing_limits" };
    const limits = await loadLimits(this.env, tenantId);
    if (!limits) return { ok: false, reason: "missing_limits" };
    return { ok: true, limits };
  }

  private async cleanup(now: number): Promise<void> {
    const leaseNext = await sweepExpiredLeases(this.state.storage, now);
    const entries = await this.state.storage.list();
    let nextAlarm: number | null = leaseNext;
    const currentHour = utcHourKey(now);
    const currentMonth = utcMonthKey(now);
    for (const [key, value] of entries) {
      if (isLeaseKey(key)) continue;
      if (key === "req") {
        const record = value as WindowRecord;
        if (!record || typeof record.start !== "number") continue;
        const expiresAt = record.start + (record.windowMs && record.windowMs > 0 ? record.windowMs : INGRESS_REQUEST_WINDOW_MS);
        if (now >= expiresAt) {
          await this.state.storage.delete(key);
          continue;
        }
        if (nextAlarm == null || expiresAt < nextAlarm) nextAlarm = expiresAt;
        continue;
      }
      if (key.startsWith("h:")) {
        if (key.slice(2) < currentHour) await this.state.storage.delete(key);
        continue;
      }
      if (key.startsWith("m:")) {
        if (key.slice(2) < currentMonth) await this.state.storage.delete(key);
        continue;
      }
      if (key.startsWith("op:")) {
        const reservation = value as Reservation;
        if (!reservation || typeof reservation.expiresAt !== "number") continue;
        if (now >= reservation.expiresAt) {
          // Held slots return to the counters. Consumed/released records are
          // dropped with no decrement so a successful attempt cannot leak an
          // op:* row forever, while commit stays idempotent within TTL.
          if (reservation.status === "held") {
            await decrementCounter(this.state.storage, `h:${reservation.hourKey}`);
            await decrementCounter(this.state.storage, `m:${reservation.monthKey}`);
          }
          await this.state.storage.delete(key);
          continue;
        }
        if (nextAlarm == null || reservation.expiresAt < nextAlarm) {
          nextAlarm = reservation.expiresAt;
        }
      }
    }
    if (nextAlarm != null && nextAlarm > now) {
      await this.state.storage.setAlarm(nextAlarm);
    } else {
      await this.state.storage.deleteAlarm();
    }
  }
}

function jsonLease(decision: LeaseDecision): Response {
  if (decision.ok) {
    return json({
      ok: true,
      fence: decision.fence,
      already_running: decision.alreadyRunning,
      expires_at: decision.expiresAt,
    });
  }
  return json({ ok: false, reason: decision.reason });
}

function denyUnavailable(): UsageDecision {
  return { ok: false, reason: "unavailable" };
}

function denyLeaseUnavailable(): ProcessingLeaseDecision {
  return { ok: false, reason: "unavailable" };
}

export function failClosedUsage(): TenantUsage {
  return {
    admitRequest: async () => denyUnavailable(),
    reserveReading: async () => denyUnavailable(),
    refreshReading: async () => undefined,
    releaseReading: async () => undefined,
    commitReading: async () => denyUnavailable(),
    acquireLease: async () => denyLeaseUnavailable(),
    renewLease: async () => denyLeaseUnavailable(),
    pauseLease: async () => denyLeaseUnavailable(),
    releaseLease: async () => undefined,
  };
}

function parseDecision(payload: unknown): UsageDecision {
  if (!payload || typeof payload !== "object") return denyUnavailable();
  const body = payload as { ok?: unknown; reason?: unknown; reset_at?: unknown };
  if (body.ok === true) return { ok: true };
  const reason = body.reason;
  if (
    reason !== "request_rate" &&
    reason !== "hourly" &&
    reason !== "monthly" &&
    reason !== "missing_limits" &&
    reason !== "unavailable"
  ) {
    return denyUnavailable();
  }
  const resetAt = Number(body.reset_at);
  return {
    ok: false,
    reason,
    ...(Number.isFinite(resetAt) && resetAt > 0 ? { resetAtMs: resetAt } : {}),
  };
}

function parseLeaseDecision(payload: unknown): ProcessingLeaseDecision {
  if (!payload || typeof payload !== "object") return denyLeaseUnavailable();
  const body = payload as {
    ok?: unknown;
    reason?: unknown;
    fence?: unknown;
    already_running?: unknown;
    expires_at?: unknown;
  };
  if (body.ok === true) {
    if (typeof body.fence !== "string" || body.fence.length === 0) return denyLeaseUnavailable();
    const expiresAt = Number(body.expires_at);
    return {
      ok: true,
      fence: body.fence,
      alreadyRunning: body.already_running === true,
      expiresAtMs: Number.isFinite(expiresAt) ? expiresAt : 0,
    };
  }
  const reason = body.reason;
  if (
    reason !== "contention" &&
    reason !== "stale_fence" &&
    reason !== "missing_limits" &&
    reason !== "unavailable"
  ) {
    return denyLeaseUnavailable();
  }
  return { ok: false, reason };
}

/** The bindings account teardown needs from this module. */
export interface TenantUsageGuardEnv {
  TENANT_USAGE_GUARD?: DurableObjectNamespace;
}

/**
 * Empty one tenant's usage guard and cancel its alarm, for account teardown.
 *
 * Kept off the `TenantUsage` interface for the same reason as
 * `purgeGlobalUsageLeases`: that interface has a fail-closed implementation
 * whose every method quietly denies, and a teardown verb that "succeeds" by
 * doing nothing is the wrong failure on a deletion path. An **unbound**
 * namespace holds no state for this tenant, so `"unbound"` is an honest
 * success; a **bound** namespace that errors throws, and teardown stops before
 * hard-deleting the `users` row.
 */
export async function purgeTenantUsageGuard(
  env: TenantUsageGuardEnv,
  tenantId: string,
): Promise<"purged" | "unbound"> {
  const ns = env.TENANT_USAGE_GUARD;
  if (!ns) {
    logUnboundGuardPurge("TENANT_USAGE_GUARD", tenantId);
    return "unbound";
  }
  if (!parseTenantId(tenantId)) throw new Error(`tenant_usage_guard purge: malformed tenant id`);
  const stub = ns.get(ns.idFromName(tenantId));
  const res = await stub.fetch("https://tenant-usage-guard/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "purge_tenant", tenantId } satisfies PurgeTenantBody),
  });
  if (!res.ok) {
    throw new Error(`tenant_usage_guard purge_tenant failed with ${res.status}`);
  }
  return "purged";
}

export function tenantUsageFor(env: Env, tenantId: string): TenantUsage {
  const ns = env.TENANT_USAGE_GUARD;
  if (!ns || !parseTenantId(tenantId)) return failClosedUsage();
  const stub = ns.get(ns.idFromName(tenantId));
  const call = async (body: GuardBody): Promise<UsageDecision> => {
    try {
      const res = await stub.fetch("https://tenant-usage-guard/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return denyUnavailable();
      return parseDecision(await res.json());
    } catch {
      return denyUnavailable();
    }
  };
  const callLease = async (body: GuardBody): Promise<ProcessingLeaseDecision> => {
    try {
      const res = await stub.fetch("https://tenant-usage-guard/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return denyLeaseUnavailable();
      return parseLeaseDecision(await res.json());
    } catch {
      return denyLeaseUnavailable();
    }
  };
  return {
    admitRequest: (nowMs) => call({ kind: "admit_request", tenantId, nowMs }),
    reserveReading: (opId, nowMs) => call({ kind: "reserve_reading", tenantId, opId, nowMs }),
    refreshReading: async (opId, nowMs) => {
      await call({ kind: "refresh_reading", tenantId, opId, nowMs });
    },
    releaseReading: async (opId) => {
      await call({ kind: "release_reading", opId });
    },
    commitReading: (opId) => call({ kind: "commit_reading", opId }),
    acquireLease: (attemptId, nowMs) => callLease({ kind: "acquire_lease", tenantId, attemptId, nowMs }),
    renewLease: (attemptId, fence, nowMs, opts) =>
      callLease({
        kind: "renew_lease",
        attemptId,
        fence,
        nowMs,
        ...(opts?.preserveInFlight === true ? { preserveInFlight: true } : {}),
      }),
    pauseLease: (attemptId, fence, nowMs) =>
      callLease({ kind: "pause_lease", attemptId, fence, nowMs }),
    releaseLease: async (attemptId, fence, nowMs) => {
      await callLease({ kind: "release_lease", attemptId, fence, nowMs });
    },
  };
}

export async function releaseReadingSlot(env: Env, tenantId: string, opId: string): Promise<void> {
  try {
    await tenantUsageFor(env, tenantId).releaseReading(opId);
  } catch {
    // Conservative: an uncertain release leaves the held slot counted.
  }
}

export async function refreshReadingSlot(env: Env, tenantId: string, opId: string, nowMs: number): Promise<void> {
  try {
    await tenantUsageFor(env, tenantId).refreshReading(opId, nowMs);
  } catch {
    // Conservative: an uncertain refresh leaves the existing TTL in place.
  }
}

// Confirms RPC success, preserving commit_reading's existing no-op behavior
// for missing/released slots. Reservation admission/expiry is a separate policy.
export async function commitReadingSlot(env: Env, tenantId: string, opId: string): Promise<boolean> {
  try {
    return (await tenantUsageFor(env, tenantId).commitReading(opId)).ok;
  } catch {
    return false;
  }
}
