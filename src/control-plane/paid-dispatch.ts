import type { Env } from "../index";
import { actualPaidCost, quotePaidRequest } from "../modules/paid-pricing";
import { GLOBAL_USAGE_GUARD_NAME } from "./constants";
import { DeferPaidWorkError } from "./processing-leases";
import type { SpendPayer } from "./spend-ledger";

// The hosted pipeline's only paid fetch seam. Install INSIDE provider retry:
// each invocation is a new possible bill and gets a fresh operation UUID. RPC
// replay uses the same UUID; queue redelivery and HTTP retries must never reuse
// a previously dispatched operation to authorize another provider request.
//
// One authority reserves tenant and global spend atomically before fetch. A
// crash/lost mark response can hold money for a request that never left; it
// cannot release money for one that might have left. Neither cancellation
// nor a provider error proves zero usage. Settlement happens before the caller
// parses the output so refusals and invalid summaries still account for usage.
export class SpendAdmissionError extends DeferPaidWorkError {
  constructor(readonly reason: string) {
    super();
    this.name = "SpendAdmissionError";
    this.message = `paid spend admission: ${reason}`;
  }
}

// A provider verdict about the account rather than the request: retrying the
// same request cannot succeed until the reader replaces the key, grants it
// model access, or adds credit, so neither HTTP nor queue retry applies
// (ADR 0004). A rate-limit 429 stays RateLimitedError and a 5xx stays an
// adapter error.
export type ProviderAccountErrorCode =
  | "provider_key_invalid"
  | "provider_model_access"
  | "provider_insufficient_quota";

const ACCOUNT_ERROR_MESSAGES: Record<ProviderAccountErrorCode, string> = {
  provider_key_invalid: "the provider rejected the key; replace it, then retry",
  provider_model_access: "the key cannot use the model; grant its project access, then retry",
  provider_insufficient_quota: "the provider account is out of quota; check its billing, then retry",
};

export class ProviderAccountError extends Error {
  constructor(readonly code: ProviderAccountErrorCode, readonly status: number) {
    super(ACCOUNT_ERROR_MESSAGES[code]);
    this.name = code;
  }
}

type RpcDecision = { ok: boolean; state?: string; fresh?: boolean; reason?: string };
export type SpendRpc = (body: Record<string, unknown>) => Promise<RpcDecision>;

export type PaidAuthorization =
  | { mode: "deployment" }
  | {
    mode: "tenant";
    resolve: () => Promise<{ key: string; credentialVersion: number }>;
    // Fenced by the version that was sent, so a key replaced while the
    // rejected request was in flight stays active.
    markInvalid: (credentialVersion: number, nowMs: number) => Promise<void>;
  };

export interface PaidFetchDeps {
  tenantId: string;
  attemptId: string;
  // "operator" labels offline operator commands, which have no pipeline stage.
  stage: "embed_source" | "summarize" | "embed_summary" | "operator";
  fetch: typeof fetch;
  rpc: SpendRpc;
  now: () => number;
  newDispatchId?: () => string;
  beforeDispatch?: () => Promise<void>;
  onAuthorizedDispatch?: () => Promise<void>;
  authorization?: PaidAuthorization;
}

export function spendRpcFor(env: Env): SpendRpc {
  return async (body) => {
    const ns = env.GLOBAL_USAGE_GUARD;
    if (!ns) return { ok: false, reason: "unavailable" };
    const stub = ns.get(ns.idFromName(GLOBAL_USAGE_GUARD_NAME));
    // A lost reserve/release/settle response is safely replayable. Mark is
    // intentionally single-use: a replay after a lost response denies dispatch.
    for (let retry = 0; retry < 2; retry++) {
      try {
        const response = await stub.fetch("https://spend-guard/", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        if (!response.ok) continue;
        const value: unknown = await response.json();
        if (value && typeof value === "object" && "ok" in value && typeof value.ok === "boolean") {
          return value as RpcDecision;
        }
      } catch { /* No successful response means no permission. */ }
    }
    return { ok: false, reason: "unavailable" };
  };
}

// WHATWG `redirect: "error"` is not implemented in workerd. `manual` returns
// the 3xx (or an opaque redirect with status 0) without following; refuse it
// so a redirect cannot create an unpriced dispatch.
function isUnfollowedRedirect(response: Response): boolean {
  return response.status === 0 || (response.status >= 300 && response.status < 400);
}

export function createPaidFetch(deps: PaidFetchDeps): typeof fetch {
  return async (input, init) => {
    // Provider adapters supply a URL and an explicit JSON body. Do not inherit
    // hidden Request bodies or permit redirects to create an unpriced dispatch.
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : "";
    // An omitted tier inherits the OpenAI project's setting, which can be
    // premium. Pin the standard tier before quoting and hashing the wire body.
    if (url === "https://api.openai.com/v1/responses" && typeof init?.body === "string") {
      try {
        const body: unknown = JSON.parse(init.body);
        if (body && typeof body === "object" && !Array.isArray(body) && !("service_tier" in body)) {
          init = { ...init, body: JSON.stringify({ ...body, service_tier: "default" }) };
        }
      } catch { /* The quote rejects invalid JSON. */ }
    }
    const quote = await quotePaidRequest(url, init ?? {});
    if (!quote) throw new SpendAdmissionError("unbounded_request");
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    await deps.beforeDispatch?.();
    const opId = `${deps.attemptId}:${deps.stage}:${(deps.newDispatchId ?? (() => crypto.randomUUID()))()}`;
    const nowMs = deps.now();
    const identity = { tenantId: deps.tenantId, opId, quote: {
      dayKey: new Date(nowMs).toISOString().slice(0, 10),
      catalogVersion: quote.catalogVersion, requestFingerprint: quote.fingerprint, maxMicrodollars: quote.maxMicrodollars,
    }};
    // The tenant pays only when its own key is attached; deployment keys and
    // operator tools bill the operator.
    const payer: SpendPayer = deps.authorization?.mode === "tenant" ? "tenant" : "operator";
    const reserve = { ...identity, kind: "reserve_spend", nowMs, payer };
    const call = async (body: Record<string, unknown>): Promise<RpcDecision> => {
      try { return await deps.rpc(body); }
      catch { return { ok: false, reason: "unavailable" }; }
    };
    const report = (state: string, fields: Record<string, unknown> = {}) => console.info(JSON.stringify({
      event: "paid_spend", tenant_id: deps.tenantId, op_id: opId, payer,
      state, max_microdollars: quote.maxMicrodollars, ...fields,
    }));
    const result = await call(reserve);
    if (!result.ok || result.state !== "reserved") {
      // A lost reserve response needs no distributed compensation. The single
      // authority expires any unused hold; no dispatch permission was granted.
      report("blocked", {reason: result.reason ?? "operation_conflict"});
      throw new SpendAdmissionError(result.reason ?? "operation_conflict");
    }
    report("reserved");
    if (init?.signal?.aborted) {
      await call({ ...identity, kind: "release_spend" });
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const permission = await call({ ...identity, kind: "mark_spend_dispatched" });
    if (!permission.ok || permission.fresh !== true) {
      await call({ ...identity, kind: "release_spend" });
      report("blocked", {reason: permission.reason ?? "dispatch_uncertain"});
      throw new SpendAdmissionError(permission.reason ?? "dispatch_uncertain");
    }
    let sentCredentialVersion: number | null = null;
    const attachTenantKey = async () => {
      if (deps.authorization?.mode !== "tenant") return;
      try {
        const resolved = await deps.authorization.resolve();
        init = withBearer(init, resolved.key);
        sentCredentialVersion = resolved.credentialVersion;
      } catch (error) {
        const canceled = await call({ ...identity, kind: "settle_spend", actualMicrodollars: 0 });
        report(canceled.ok ? "settled" : "unresolved", {actual_microdollars: 0, reason: "credential_unavailable"});
        throw error;
      }
    };
    await attachTenantKey();
    try {
      await deps.onAuthorizedDispatch?.();
    } catch (error) {
      // Permission is fresh and fetch has not run. Zero is a known outcome,
      // unlike a transport failure after sending the provider request.
      const canceled = await call({ ...identity, kind: "settle_spend", actualMicrodollars: 0 });
      report(canceled.ok ? "settled" : "unresolved", {actual_microdollars: 0, reason: "quota_commit_failed"});
      throw error;
    }
    await attachTenantKey();
    let response: Response;
    try {
      // workerd rejects `redirect: "error"`; manual + refuse-3xx is the fail-closed equivalent.
      response = await deps.fetch(input, { ...init, redirect: "manual" });
      if (isUnfollowedRedirect(response)) {
        response.body?.cancel().catch(() => {});
        throw new TypeError(`paid dispatch refused redirect (${response.status})`);
      }
    } catch (error) {
      report("unresolved", {reason: "transport_error"});
      throw error;
    }
    let actual: number | null = null;
    try { if (response.ok) actual = actualPaidCost(quote, await response.clone().json()); }
    catch { /* Invalid/missing usage leaves the maximum charged. */ }
    if (actual !== null) {
      const result = await call({ ...identity, kind: "settle_spend", actualMicrodollars: actual });
      if (result.ok) report("settled", {actual_microdollars: actual});
      else report("unresolved", {reason: "settlement_unavailable"});
      if (!result.ok) console.warn(JSON.stringify({ event: "paid_spend_settlement_held", op_id: opId, reason: result.reason }));
    } else report("unresolved", {reason: "missing_valid_usage"});
    await throwIfAccountFailure(response, deps, sentCredentialVersion);
    return response;
  };
}

// Checked before fetchWithRetry sees the status, so insufficient_quota never
// becomes RateLimitedError. A 401 or 403 is about the tenant's key only when
// one was sent; on deployment keys it stays the adapter's error. Only a 401
// invalidates the key: a 403 means a valid key lacks model or project access,
// which replacing the same key would not fix (provider-key-check agrees).
async function throwIfAccountFailure(
  response: Response,
  deps: PaidFetchDeps,
  credentialVersion: number | null,
): Promise<void> {
  const tenantKeySent = deps.authorization?.mode === "tenant" && credentialVersion !== null;
  if (response.status === 403 && tenantKeySent) {
    response.body?.cancel().catch(() => {});
    throw new ProviderAccountError("provider_model_access", 403);
  }
  if (response.status === 401 && deps.authorization?.mode === "tenant" && credentialVersion !== null) {
    response.body?.cancel().catch(() => {});
    try {
      await deps.authorization.markInvalid(credentialVersion, deps.now());
    } catch (error) {
      // The attempt still fails as key-invalid; the next dispatch meets the
      // provider's 401 again and retries the mark.
      console.error(JSON.stringify({
        event: "provider_key_mark_invalid_failed",
        tenant_id: deps.tenantId,
        credential_version: credentialVersion,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    throw new ProviderAccountError("provider_key_invalid", response.status);
  }
  if (response.status === 429 && await isInsufficientQuota(response)) {
    response.body?.cancel().catch(() => {});
    throw new ProviderAccountError("provider_insufficient_quota", 429);
  }
}

async function isInsufficientQuota(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.clone().json();
    const error = body && typeof body === "object" && "error" in body ? body.error : null;
    if (!error || typeof error !== "object") return false;
    const { code, type } = error as { code?: unknown; type?: unknown };
    return code === "insufficient_quota" || type === "insufficient_quota";
  } catch {
    return false;
  }
}

function withBearer(init: RequestInit | undefined, key: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${key}`);
  return { ...init, headers };
}
