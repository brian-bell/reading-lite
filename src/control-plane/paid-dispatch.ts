import type { Env } from "../index";
import { actualPaidCost, quotePaidRequest } from "../modules/paid-pricing";
import { GLOBAL_USAGE_GUARD_NAME } from "./constants";
import { DeferPaidWorkError } from "./processing-leases";

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

type RpcDecision = { ok: boolean; state?: string; fresh?: boolean; reason?: string };
export type SpendRpc = (body: Record<string, unknown>) => Promise<RpcDecision>;

export type PaidAuthorization =
  | { mode: "deployment" }
  | { mode: "tenant"; resolve: () => Promise<string> };

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
    const reserve = { ...identity, kind: "reserve_spend", nowMs };
    const call = async (body: Record<string, unknown>): Promise<RpcDecision> => {
      try { return await deps.rpc(body); }
      catch { return { ok: false, reason: "unavailable" }; }
    };
    const report = (state: string, fields: Record<string, unknown> = {}) => console.info(JSON.stringify({
      event: "paid_spend", tenant_id: deps.tenantId, op_id: opId,
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
    const attachTenantKey = async () => {
      if (deps.authorization?.mode !== "tenant") return;
      try {
        init = withBearer(init, await deps.authorization.resolve());
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
    return response;
  };
}

function withBearer(init: RequestInit | undefined, key: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${key}`);
  return { ...init, headers };
}
