import type { Env } from "../index";
import { bumpWindow } from "./auth-rate-guard";
import { INGRESS_REQUEST_WINDOW_MS, READING_RESERVATION_TTL_MS } from "./constants";
import { parseTenantId } from "./ids";

// TenantUsageGuard serializes one tenant's ingress request-rate token bucket
// and paid-work reading-slot reservations (hourly + monthly). D1 tenant_limits
// is the policy source of truth; callers cannot supply limits. Missing or
// invalid limits, and an unavailable Durable Object, fail closed.
//
// Request-rate counts every intake write. Reading slots are reserved only for
// an activation attempt (idempotent on attempt id) and released when the
// attempt never reaches summarization dispatch. Spend, concurrency leases, and
// GlobalUsageGuard are out of scope (s1k.9.2–9.4).

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
type ReleaseReadingBody = { kind: "release_reading"; opId: string };
type CommitReadingBody = { kind: "commit_reading"; opId: string };
type GuardBody = AdmitRequestBody | ReserveReadingBody | ReleaseReadingBody | CommitReadingBody;

export type UsageDenyReason =
  | "request_rate"
  | "hourly"
  | "monthly"
  | "missing_limits"
  | "unavailable";

export type UsageDecision =
  | { ok: true }
  | { ok: false; reason: UsageDenyReason; resetAtMs?: number };

export interface TenantUsage {
  admitRequest(nowMs: number): Promise<UsageDecision>;
  reserveReading(opId: string, nowMs: number): Promise<UsageDecision>;
  releaseReading(opId: string): Promise<void>;
  commitReading(opId: string): Promise<void>;
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

function parseGuardBody(value: unknown): GuardBody | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const kind = body.kind;
  if (kind === "admit_request") {
    const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
    const nowMs = Number(body.nowMs);
    if (!tenantId || !Number.isFinite(nowMs) || nowMs < 0) return null;
    return { kind, tenantId, nowMs };
  }
  if (kind === "reserve_reading") {
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
  return null;
}

async function scheduleCleanupAlarm(storage: DurableObjectStorage, expiresAt: number): Promise<void> {
  const when = Math.max(expiresAt, Date.now() + 1);
  const existing = await storage.getAlarm();
  if (existing == null || when < existing) {
    await storage.setAlarm(when);
  }
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
      if (body.kind === "admit_request") return this.admitRequest(body);
      if (body.kind === "reserve_reading") return this.reserveReading(body);
      if (body.kind === "release_reading") return this.releaseReading(body);
      return this.commitReading(body);
    });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      await this.cleanup(Date.now());
    });
  }

  private async admitRequest(body: AdmitRequestBody): Promise<Response> {
    const limits = await this.requireLimits(body.tenantId);
    if (!limits.ok) return json(limits);
    const now = body.nowMs;
    const current = (await this.state.storage.get("req")) as WindowRecord | undefined;
    const next = bumpWindow(current, now, INGRESS_REQUEST_WINDOW_MS);
    await this.state.storage.put("req", { ...next, windowMs: INGRESS_REQUEST_WINDOW_MS });
    await scheduleCleanupAlarm(this.state.storage, next.start + INGRESS_REQUEST_WINDOW_MS);
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
    const expiresAt = body.nowMs + READING_RESERVATION_TTL_MS;
    await this.state.storage.put(opKey, {
      status: "held",
      hourKey,
      monthKey,
      expiresAt,
    } satisfies Reservation);
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

  private async requireLimits(
    tenantId: string,
  ): Promise<{ ok: true; limits: TenantIngressLimits } | { ok: false; reason: "missing_limits" }> {
    if (!parseTenantId(tenantId)) return { ok: false, reason: "missing_limits" };
    const limits = await loadLimits(this.env, tenantId);
    if (!limits) return { ok: false, reason: "missing_limits" };
    return { ok: true, limits };
  }

  private async cleanup(now: number): Promise<void> {
    const entries = await this.state.storage.list();
    let nextAlarm: number | null = null;
    const currentHour = utcHourKey(now);
    const currentMonth = utcMonthKey(now);
    for (const [key, value] of entries) {
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
        if (reservation.status === "held" && now >= reservation.expiresAt) {
          await decrementCounter(this.state.storage, `h:${reservation.hourKey}`);
          await decrementCounter(this.state.storage, `m:${reservation.monthKey}`);
          await this.state.storage.delete(key);
          continue;
        }
        if (reservation.status === "released" && now >= reservation.expiresAt) {
          await this.state.storage.delete(key);
          continue;
        }
        if (reservation.status === "held" && (nextAlarm == null || reservation.expiresAt < nextAlarm)) {
          nextAlarm = reservation.expiresAt;
        }
      }
    }
    if (nextAlarm != null) {
      await this.state.storage.setAlarm(Math.max(nextAlarm, now + 1));
    } else {
      await this.state.storage.deleteAlarm();
    }
  }
}

function denyUnavailable(): UsageDecision {
  return { ok: false, reason: "unavailable" };
}

export function failClosedUsage(): TenantUsage {
  return {
    admitRequest: async () => denyUnavailable(),
    reserveReading: async () => denyUnavailable(),
    releaseReading: async () => undefined,
    commitReading: async () => undefined,
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
  return {
    admitRequest: (nowMs) => call({ kind: "admit_request", tenantId, nowMs }),
    reserveReading: (opId, nowMs) => call({ kind: "reserve_reading", tenantId, opId, nowMs }),
    releaseReading: async (opId) => {
      await call({ kind: "release_reading", opId });
    },
    commitReading: async (opId) => {
      await call({ kind: "commit_reading", opId });
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

export async function commitReadingSlot(env: Env, tenantId: string, opId: string): Promise<void> {
  try {
    await tenantUsageFor(env, tenantId).commitReading(opId);
  } catch {
    // Conservative: an uncertain commit leaves the slot held (still counted).
  }
}
