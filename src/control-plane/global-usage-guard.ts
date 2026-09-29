import { LeaseRecoveryRequestSchema, recoverLeasePair, type LeaseRecoveryRequest } from "./processing-lease-recovery";
import { inspectGlobal } from "./operator-inspection";
import { readSpendStatus } from "./spend-status";
import type { Env } from "../index";
import { withControlPlane } from "./db";
import { GLOBAL_USAGE_GUARD_NAME, SPEND_RESERVATION_TTL_MS } from "./constants";
import { scheduleCleanupAlarm } from "./do-alarm";
import { parseTenantId } from "./ids";
import { effectiveDailySpend } from "./provider-settings";
import { PolicyCache, policyCacheTtlMs } from "./policy-cache";
import {
  acquireLease as acquireStoredLease,
  leaseStorageKey,
  pauseLease as pauseStoredLease,
  releaseLease as releaseStoredLease,
  renewLease as renewStoredLease,
  sweepExpiredLeases,
  type LeaseDecision,
} from "./processing-lease-state";
import type { ProcessingLeaseDecision } from "./tenant-usage-guard";
import {
  markSpendDispatched,
  isSpendPayer,
  releaseSpend,
  reserveSpend,
  settleSpend,
  sweepExpiredSpend,
  purgeGlobalTenantSpend,
  utcSpendDay,
  validSpendQuote,
  type SpendBody,
  type SpendDecision,
} from "./spend-ledger";

// GlobalUsageGuard is the singleton SQLite Durable Object that serializes
// global processing concurrency and daily paid-work spend. Addressed by
// idFromName(GLOBAL_USAGE_GUARD_NAME). The system_policy row is the source of both
// limits; a NULL daily spend budget fails closed rather than inventing one.
// The tenant cap is the operator default on tenant_limits, lowered by the
// reader's own cap on user_settings when they set one.

type AcquireLeaseBody = { kind: "acquire_lease"; tenantId: string; attemptId: string; nowMs: number };
type FenceLeaseBody = {
  kind: "renew_lease" | "pause_lease" | "release_lease";
  tenantId: string;
  attemptId: string;
  fence: string;
  nowMs: number;
  preserveInFlight?: boolean;
};
/**
 * Account teardown (issue 195 S4): drop every lease belonging to one tenant.
 *
 * This DO is a singleton, so unlike `TenantUsageGuard` its storage cannot be
 * emptied wholesale — the other tenants' leases live in it. Lease keys are
 * `lease:${tenantId}:${attemptId}` and tenant ids are `usr_<uuid v4>`, which
 * contain no colon, so `lease:${tenantId}:` is an unambiguous prefix for one
 * tenant's leases and cannot catch a neighbour's.
 *
 * Without this the deleted tenant's in-flight leases would keep occupying
 * global concurrency slots until their TTL swept them, charging live tenants
 * for an account that no longer exists.
 */
type PurgeTenantBody = { kind: "purge_tenant"; tenantId: string };
type GuardBody = LeaseRecoveryRequest | { kind: "spend_status"; tenantId?: string; details?: boolean } | AcquireLeaseBody | FenceLeaseBody | PurgeTenantBody | SpendBody;

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

// Cached per instance for GUARD_POLICY_CACHE_MS (policy-cache.ts): an
// operator-set number. The spend policy below is not, because that read also
// carries the tenant's deletion fence and the paid-work switch.
async function loadGlobalConcurrency(env: Env, cache: PolicyCache): Promise<number | null> {
  try {
    return await cache.get("system_policy:max_concurrent_work", async () => {
      const row = await withControlPlane(env, (db) =>
        db.first<{ max_concurrent_work: number }>("SELECT max_concurrent_work FROM system_policy WHERE id = 1"),
      );
      return row ? positiveInt(row.max_concurrent_work) : null;
    });
  } catch {
    return null;
  }
}

type GlobalSpendPolicy = { dailySpendMicrodollars: number; tenantDailySpendMicrodollars: number; policyVersion: number; catalogVersion: number; paidWorkEnabled: boolean };

async function loadGlobalSpendPolicy(env: Env, tenantId: string): Promise<GlobalSpendPolicy | "deleted" | null> {
  try {
    const row = await withControlPlane(env, (db) =>
      db.first<{ status: string; daily_spend_microdollars: number | null; tenant_daily_spend_microdollars: number; user_daily_spend_cap_microdollars?: number | null; policy_version: number; catalog_version: number; paid_work_enabled: boolean }>(
        `SELECT u.status, sp.daily_spend_microdollars, sp.policy_version, sp.catalog_version, sp.paid_work_enabled,
                tl.daily_spend_microdollars AS tenant_daily_spend_microdollars,
                us.daily_spend_cap_microdollars AS user_daily_spend_cap_microdollars
         FROM users u JOIN system_policy sp ON sp.id = 1 JOIN tenant_limits tl ON tl.tenant_id = u.id
         LEFT JOIN user_settings us ON us.user_id = u.id
         WHERE u.id = ?`,
        tenantId,
      ),
    );
    if (!row) return null;
    if (row.status !== "active") return "deleted";
    const dailySpendMicrodollars = positiveInt(row.daily_spend_microdollars);
    const operatorTenantMicrodollars = positiveInt(row.tenant_daily_spend_microdollars);
    const userCap = row.user_daily_spend_cap_microdollars == null ? null : positiveInt(row.user_daily_spend_cap_microdollars);
    const policyVersion = positiveInt(row.policy_version);
    const catalogVersion = Number(row.catalog_version);
    if (dailySpendMicrodollars === null || operatorTenantMicrodollars === null || (row.user_daily_spend_cap_microdollars != null && userCap === null) || policyVersion === null || !Number.isSafeInteger(catalogVersion) || catalogVersion < 0) return null;
    const tenantDailySpendMicrodollars = effectiveDailySpend(userCap, operatorTenantMicrodollars);
    return { dailySpendMicrodollars, tenantDailySpendMicrodollars, policyVersion, catalogVersion, paidWorkEnabled: row.paid_work_enabled === true };
  } catch {
    return null;
  }
}

/** Account deletion fences mutations; pausing paid work still permits refunds. */
async function tenantCanHoldSpend(env: Env, tenantId: string): Promise<boolean> {
  try {
    const row = await withControlPlane(env, (db) =>
      db.first<{ status: string }>("SELECT status FROM users WHERE id = ?", tenantId),
    );
    return row?.status === "active";
  } catch {
    return false;
  }
}

function leaseId(tenantId: string, attemptId: string): string {
  return `${tenantId}:${attemptId}`;
}

function parseGuardBody(value: unknown): GuardBody | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const kind = body.kind;
  if (kind === "recover_leases") {
    const parsed = LeaseRecoveryRequestSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  }
  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  const attemptId = typeof body.attemptId === "string" ? body.attemptId : "";
  const nowMs = Number(body.nowMs);
  // Purge carries no attempt and no clock: it names a whole tenant. Parsed
  // before the shared field checks, which would reject it for the missing ones.
  if (kind === "spend_status") {
    const canonicalTenant = body.tenantId === undefined ? undefined : parseTenantId(tenantId);
    if (canonicalTenant === null) return null;
    if (body.details !== undefined && typeof body.details !== "boolean") return null;
    return { kind, ...(canonicalTenant ? { tenantId: canonicalTenant } : {}), ...(body.details === true ? { details: true } : {}) };
  }
  if (kind === "purge_tenant") {
    return parseTenantId(tenantId) ? { kind, tenantId } : null;
  }
  if (kind === "reserve_spend") {
    if (!tenantId || !Number.isFinite(nowMs) || nowMs < 0 || !validSpendQuote(body.quote) || !isSpendPayer(body.payer)) return null;
    // Spend operation ids are deliberately independent of processing attempts;
    // use opId rather than the shared lease parser's attemptId.
    const opId = typeof body.opId === "string" ? body.opId : "";
    if (!opId) return null;
    return { kind, tenantId, opId, quote: body.quote, nowMs, payer: body.payer };
  }
  if (kind === "mark_spend_dispatched" || kind === "release_spend") {
    const opId = typeof body.opId === "string" ? body.opId : "";
    if (!tenantId || !opId || !validSpendQuote(body.quote)) return null;
    return { kind, tenantId, opId, quote: body.quote };
  }
  if (kind === "settle_spend") {
    const opId = typeof body.opId === "string" ? body.opId : "";
    const actualMicrodollars = Number(body.actualMicrodollars);
    if (!tenantId || !opId || !validSpendQuote(body.quote) || !Number.isSafeInteger(actualMicrodollars) || actualMicrodollars < 0) return null;
    return { kind, tenantId, opId, quote: body.quote, actualMicrodollars };
  }
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
  private readonly policy: PolicyCache;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.policy = new PolicyCache(policyCacheTtlMs(env));
  }

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
      if (body.kind === "recover_leases") return json(await recoverLeasePair(this.state.storage, this.env, body));
      if (body.kind === "spend_status") {
        const now = Date.now();
        return json({ ...await readSpendStatus(this.state.storage, now, body.tenantId), ...(body.details ? { details: await inspectGlobal(this.state.storage, now) } : {}) });
      }
      if (body.kind === "acquire_lease") return this.acquireLease(body);
      if (body.kind === "purge_tenant") return this.purgeTenant(body);
      if (body.kind === "reserve_spend") return this.reserveSpend(body);
      if (body.kind === "mark_spend_dispatched") return this.markSpendDispatched(body);
      if (body.kind === "release_spend") return this.releaseSpend(body);
      if (body.kind === "settle_spend") return json(await settleSpend(this.state.storage, { opKey: this.spendOpKey(body.tenantId, body.opId), quote: body.quote, actualMicrodollars: body.actualMicrodollars }));
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
      const leaseNext = await sweepExpiredLeases(this.state.storage, now);
      const spendNext = await sweepExpiredSpend(this.state.storage, now);
      const nextAlarm = spendNext === null ? leaseNext : leaseNext === null ? spendNext : Math.min(spendNext, leaseNext);
      if (nextAlarm != null && nextAlarm > now) {
        await this.state.storage.setAlarm(nextAlarm);
      } else {
        await this.state.storage.deleteAlarm();
      }
    });
  }

  /**
   * Delete this tenant's leases and leave every other tenant's alone.
   *
   * Idempotent: a tenant with no leases purges zero and still answers ok, which
   * is what lets teardown be retried after a crash.
   */
  private async purgeTenant(body: PurgeTenantBody): Promise<Response> {
    const prefix = leaseStorageKey(`${body.tenantId}:`);
    const entries = await this.state.storage.list({ prefix });
    for (const key of entries.keys()) {
      await this.state.storage.delete(key);
    }
    // Spend records contain tenant identity. Purge refunds only reservations
    // that never received dispatch authorization; dispatched and settled
    // charges remain in the shared aggregate after account deletion.
    const purgedSpend = await purgeGlobalTenantSpend(this.state.storage, body.tenantId);
    return json({ ok: true, purged: entries.size + purgedSpend });
  }

  private async acquireLease(body: AcquireLeaseBody): Promise<Response> {
    if (!parseTenantId(body.tenantId)) return json({ ok: false, reason: "missing_limits" });
    const limit = await loadGlobalConcurrency(this.env, this.policy);
    if (limit === null) return json({ ok: false, reason: "missing_limits" });
    return jsonLease(
      await acquireStoredLease(this.state.storage, {
        id: leaseId(body.tenantId, body.attemptId),
        limit,
        nowMs: body.nowMs,
      }),
    );
  }

  private spendOpKey(tenantId: string, opId: string): string {
    return `spend:op:${tenantId}:${opId}`;
  }

  private async reserveSpend(body: Extract<SpendBody, { kind: "reserve_spend" }>): Promise<Response> {
    if (!parseTenantId(body.tenantId)) return json({ ok: false, reason: "missing_limits" } satisfies SpendDecision);
    const opKey = this.spendOpKey(body.tenantId, body.opId);
    // An existing operation may be retried across midnight. The ledger still
    // validates its full quote and state, without recharging or renewing it.
    // A new/removed operation must use the authority's day, so old quotes
    // cannot recreate records discarded by retention or account teardown.
    if (body.quote.dayKey !== utcSpendDay(Date.now()) && await this.state.storage.get(opKey) === undefined) {
      return json({ ok: false, reason: "operation_conflict" } satisfies SpendDecision);
    }
    const policy = await loadGlobalSpendPolicy(this.env, body.tenantId);
    if (policy === "deleted") return json({ ok: false, reason: "deleted_tenant" } satisfies SpendDecision);
    if (!policy) return json({ ok: false, reason: "missing_limits" } satisfies SpendDecision);
    if (!policy.paidWorkEnabled) return json({ ok: false, reason: "paid_work_disabled" } satisfies SpendDecision);
    if (body.quote.catalogVersion !== policy.catalogVersion) return json({ ok: false, reason: "catalog_version" } satisfies SpendDecision);
    const expiresAtMs = Date.now() + SPEND_RESERVATION_TTL_MS;
    await scheduleCleanupAlarm(this.state.storage, expiresAtMs);
    return json(await reserveSpend(this.state.storage, {
      opKey,
      quote: body.quote,
      payer: body.payer,
      policyVersion: policy.policyVersion,
      limitMicrodollars: policy.dailySpendMicrodollars,
      tenantId: body.tenantId,
      tenantLimitMicrodollars: policy.tenantDailySpendMicrodollars,
      expiresAtMs,
    }));
  }

  private async releaseSpend(body: Extract<SpendBody, { kind: "release_spend" }>): Promise<Response> {
    if (!(await tenantCanHoldSpend(this.env, body.tenantId))) {
      return json({ ok: false, reason: "deleted_tenant" } satisfies SpendDecision);
    }
    return json(
      await releaseSpend(this.state.storage, {
        opKey: this.spendOpKey(body.tenantId, body.opId),
        quote: body.quote,
      }),
    );
  }

  private async markSpendDispatched(body: Extract<SpendBody, { kind: "mark_spend_dispatched" }>): Promise<Response> {
    const policy = await loadGlobalSpendPolicy(this.env, body.tenantId);
    if (policy === "deleted") return json({ok:false, reason:"deleted_tenant"} satisfies SpendDecision);
    if (!policy) return json({ok:false, reason:"missing_limits"} satisfies SpendDecision);
    if (!policy.paidWorkEnabled) return json({ok:false, reason:"paid_work_disabled"} satisfies SpendDecision);
    if (body.quote.catalogVersion !== policy.catalogVersion) return json({ok:false, reason:"catalog_version"} satisfies SpendDecision);
    return json(await markSpendDispatched(this.state.storage, { opKey: this.spendOpKey(body.tenantId, body.opId), quote: body.quote, nowMs: Date.now(),
      limits: {globalMicrodollars:policy.dailySpendMicrodollars, tenantMicrodollars:policy.tenantDailySpendMicrodollars},
    }));
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

/** The bindings account teardown needs from this module. */
export interface GlobalUsageGuardEnv {
  GLOBAL_USAGE_GUARD?: DurableObjectNamespace;
}

export const GUARD_PURGE_UNBOUND_EVENT = "account_teardown_guard_unbound";

/** Shared by both guards' purge helpers. */
export function logUnboundGuardPurge(binding: string, tenantId: string): void {
  console.warn(
    JSON.stringify({
      event: GUARD_PURGE_UNBOUND_EVENT,
      binding,
      tenant_id: tenantId,
      note: "no Durable Object namespace bound, so nothing was purged for this tenant",
    }),
  );
}

/**
 * Clear one tenant's global concurrency leases, for account teardown.
 *
 * Deliberately NOT part of `GlobalUsage`: that interface is the hot request
 * path, implemented by a fail-closed stub and by test fakes, and a teardown
 * verb that quietly "succeeds" by doing nothing there is precisely the wrong
 * failure. Here the two outcomes are kept apart. An **unbound** namespace has
 * no lease book at all, so there is nothing to clear and `"unbound"` is an
 * honest success. A **bound** namespace that errors is a leftover we could not
 * remove, so it throws — teardown must not hard-delete the `users` row while
 * state keyed to that tenant may still exist.
 */
export async function purgeGlobalUsageLeases(
  env: GlobalUsageGuardEnv,
  tenantId: string,
): Promise<"purged" | "unbound"> {
  const ns = env.GLOBAL_USAGE_GUARD;
  if (!ns) {
    // Said out loud. `Env` makes the binding optional, so a rename or a
    // dropped `wrangler.toml` entry would otherwise turn the fail-closed
    // guarantee into a silent skip while the `users` row is still deleted.
    logUnboundGuardPurge("GLOBAL_USAGE_GUARD", tenantId);
    return "unbound";
  }
  const stub = ns.get(ns.idFromName(GLOBAL_USAGE_GUARD_NAME));
  const res = await stub.fetch("https://global-usage-guard/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "purge_tenant", tenantId } satisfies PurgeTenantBody),
  });
  if (!res.ok) {
    throw new Error(`global_usage_guard purge_tenant failed with ${res.status}`);
  }
  return "purged";
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
