import type { Env } from "../index";
import { GLOBAL_USAGE_GUARD_NAME } from "./constants";
import { parseTenantId } from "./ids";
import {
  acquireLease as acquireStoredLease,
  pauseLease as pauseStoredLease,
  releaseLease as releaseStoredLease,
  renewLease as renewStoredLease,
  sweepExpiredLeases,
  type LeaseDecision,
} from "./processing-lease-state";
import type { ProcessingLeaseDecision } from "./tenant-usage-guard";

// GlobalUsageGuard is the singleton SQLite Durable Object that serializes
// global processing concurrency. Addressed by idFromName(GLOBAL_USAGE_GUARD_NAME).
// Kill switch and spend stay out of scope (s1k.9.4 / 9.3). D1 system_policy
// max_concurrent_work is the placeholder cap; callers cannot supply limits.

type AcquireLeaseBody = { kind: "acquire_lease"; tenantId: string; attemptId: string; nowMs: number };
type FenceLeaseBody = {
  kind: "renew_lease" | "pause_lease" | "release_lease";
  tenantId: string;
  attemptId: string;
  fence: string;
  nowMs: number;
  preserveInFlight?: boolean;
};
type GuardBody = AcquireLeaseBody | FenceLeaseBody;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
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

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

async function loadGlobalConcurrency(env: Env): Promise<number | null> {
  try {
    const row = await env.CONTROL_PLANE.prepare(
      `SELECT max_concurrent_work FROM system_policy WHERE id = 1`,
    ).first<{ max_concurrent_work: number }>();
    if (!row) return null;
    return positiveInt(row.max_concurrent_work);
  } catch {
    return null;
  }
}

function leaseId(tenantId: string, attemptId: string): string {
  return `${tenantId}:${attemptId}`;
}

function parseGuardBody(value: unknown): GuardBody | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const kind = body.kind;
  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  const attemptId = typeof body.attemptId === "string" ? body.attemptId : "";
  const nowMs = Number(body.nowMs);
  if (!tenantId || !attemptId || !Number.isFinite(nowMs) || nowMs < 0) return null;
  if (kind === "acquire_lease") return { kind, tenantId, attemptId, nowMs };
  if (kind === "renew_lease" || kind === "pause_lease" || kind === "release_lease") {
    const fence = typeof body.fence === "string" ? body.fence : "";
    if (!fence) return null;
    return {
      kind,
      tenantId,
      attemptId,
      fence,
      nowMs,
      ...(kind === "renew_lease" && body.preserveInFlight === true ? { preserveInFlight: true } : {}),
    };
  }
  return null;
}

export class GlobalUsageGuard implements DurableObject {
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
      if (body.kind === "acquire_lease") return this.acquireLease(body);
      if (body.kind === "renew_lease") {
        return jsonLease(
          await renewStoredLease(this.state.storage, {
            id: leaseId(body.tenantId, body.attemptId),
            fence: body.fence,
            nowMs: body.nowMs,
            preserveInFlight: body.preserveInFlight === true,
          }),
        );
      }
      if (body.kind === "pause_lease") {
        return jsonLease(
          await pauseStoredLease(this.state.storage, {
            id: leaseId(body.tenantId, body.attemptId),
            fence: body.fence,
            nowMs: body.nowMs,
          }),
        );
      }
      return jsonLease(
        await releaseStoredLease(this.state.storage, {
          id: leaseId(body.tenantId, body.attemptId),
          fence: body.fence,
          nowMs: body.nowMs,
        }),
      );
    });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const nextAlarm = await sweepExpiredLeases(this.state.storage, now);
      if (nextAlarm != null && nextAlarm > now) {
        await this.state.storage.setAlarm(nextAlarm);
      } else {
        await this.state.storage.deleteAlarm();
      }
    });
  }

  private async acquireLease(body: AcquireLeaseBody): Promise<Response> {
    if (!parseTenantId(body.tenantId)) return json({ ok: false, reason: "missing_limits" });
    const limit = await loadGlobalConcurrency(this.env);
    if (limit === null) return json({ ok: false, reason: "missing_limits" });
    return jsonLease(
      await acquireStoredLease(this.state.storage, {
        id: leaseId(body.tenantId, body.attemptId),
        limit,
        nowMs: body.nowMs,
      }),
    );
  }
}

export interface GlobalUsage {
  acquireLease(tenantId: string, attemptId: string, nowMs: number): Promise<ProcessingLeaseDecision>;
  renewLease(
    tenantId: string,
    attemptId: string,
    fence: string,
    nowMs: number,
    opts?: { preserveInFlight?: boolean },
  ): Promise<ProcessingLeaseDecision>;
  pauseLease(tenantId: string, attemptId: string, fence: string, nowMs: number): Promise<ProcessingLeaseDecision>;
  releaseLease(tenantId: string, attemptId: string, fence: string, nowMs: number): Promise<void>;
}

function denyUnavailable(): ProcessingLeaseDecision {
  return { ok: false, reason: "unavailable" };
}

function parseLeaseDecision(payload: unknown): ProcessingLeaseDecision {
  if (!payload || typeof payload !== "object") return denyUnavailable();
  const body = payload as {
    ok?: unknown;
    reason?: unknown;
    fence?: unknown;
    already_running?: unknown;
    expires_at?: unknown;
  };
  if (body.ok === true) {
    if (typeof body.fence !== "string" || body.fence.length === 0) return denyUnavailable();
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
    return denyUnavailable();
  }
  return { ok: false, reason };
}

export function failClosedGlobalUsage(): GlobalUsage {
  return {
    acquireLease: async () => denyUnavailable(),
    renewLease: async () => denyUnavailable(),
    pauseLease: async () => denyUnavailable(),
    releaseLease: async () => undefined,
  };
}

export function globalUsageFor(env: Env): GlobalUsage {
  const ns = env.GLOBAL_USAGE_GUARD;
  if (!ns) return failClosedGlobalUsage();
  const stub = ns.get(ns.idFromName(GLOBAL_USAGE_GUARD_NAME));
  const call = async (body: GuardBody): Promise<ProcessingLeaseDecision> => {
    try {
      const res = await stub.fetch("https://global-usage-guard/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return denyUnavailable();
      return parseLeaseDecision(await res.json());
    } catch {
      return denyUnavailable();
    }
  };
  return {
    acquireLease: (tenantId, attemptId, nowMs) => call({ kind: "acquire_lease", tenantId, attemptId, nowMs }),
    renewLease: (tenantId, attemptId, fence, nowMs, opts) =>
      call({
        kind: "renew_lease",
        tenantId,
        attemptId,
        fence,
        nowMs,
        ...(opts?.preserveInFlight === true ? { preserveInFlight: true } : {}),
      }),
    pauseLease: (tenantId, attemptId, fence, nowMs) =>
      call({ kind: "pause_lease", tenantId, attemptId, fence, nowMs }),
    releaseLease: async (tenantId, attemptId, fence, nowMs) => {
      await call({ kind: "release_lease", tenantId, attemptId, fence, nowMs });
    },
  };
}
