// Named entrypoint only: reachable through an account-authorized service
// binding, never mounted on the public router. OperatorStatus stays a single
// GET read; dead-lease recovery (#256) is a separate write-shaped entrypoint so
// a status request can never authorize a mutation. It forwards exactly one
// verb — the compare-and-set clear of an overdue in-flight lease row — to
// both guards, where blockConcurrencyWhile makes observe-and-delete atomic.
// The request names the row by tenant + attempt plus the expiresAt observed
// in THIS invocation (absent expectation allowed per side); fences never
// cross the wire in either direction, and the guards' own clock governs the
// overdue gate.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../index";
import { parseTenantId } from "./ids";
import { GLOBAL_USAGE_GUARD_NAME } from "./constants";

type ClearRequest = {
  tenantId: string;
  attemptId: string;
  expectedTenantExpiresAt?: number;
  expectedGlobalExpiresAt?: number;
};

type ClearDecision =
  | { ok: true; cleared: boolean }
  | { ok: false; reason: "changed" | "not_in_flight" | "not_overdue" };

function parseClearDecision(value: unknown): ClearDecision {
  if (!value || typeof value !== "object") throw new Error("malformed decision");
  const body = value as { ok?: unknown; cleared?: unknown; reason?: unknown };
  if (body.ok === true) {
    if (typeof body.cleared !== "boolean") throw new Error("malformed decision");
    return { ok: true, cleared: body.cleared };
  }
  const reason = body.reason;
  if (
    reason !== "changed" &&
    reason !== "not_in_flight" &&
    reason !== "not_overdue"
  ) {
    throw new Error("malformed decision");
  }
  return { ok: false, reason };
}

function parseClearRequest(value: unknown): ClearRequest | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const tenantId = parseTenantId(typeof body.tenantId === "string" ? body.tenantId : "");
  if (tenantId === null) return null;
  const attemptId = typeof body.attemptId === "string" ? body.attemptId : "";
  if (!attemptId) return null;
  const expectation = (raw: unknown): number | undefined => {
    if (raw === undefined) return undefined;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return -1;
    return raw;
  };
  const expectedTenantExpiresAt = expectation(body.expectedTenantExpiresAt);
  const expectedGlobalExpiresAt = expectation(body.expectedGlobalExpiresAt);
  if (expectedTenantExpiresAt === -1 || expectedGlobalExpiresAt === -1) return null;
  return {
    tenantId,
    attemptId,
    ...(expectedTenantExpiresAt === undefined ? {} : { expectedTenantExpiresAt }),
    ...(expectedGlobalExpiresAt === undefined ? {} : { expectedGlobalExpiresAt }),
  };
}

export class OperatorLeaseClear extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const url = new URL(request.url);
    if (url.pathname !== "/clear") return new Response(null, { status: 404 });
    if ([...url.searchParams.keys()].length > 0) return new Response(null, { status: 400 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }
    const parsed = parseClearRequest(body);
    if (!parsed) return new Response(null, { status: 400 });
    // Tenant first, then global — the saga's order. A throw between the two
    // leaves a partial clear that a re-run converges (absent is success).
    try {
      const tenantNs = this.env.TENANT_USAGE_GUARD;
      const globalNs = this.env.GLOBAL_USAGE_GUARD;
      if (!tenantNs || !globalNs) throw new Error("unbound");
      const tenantRes = await tenantNs
        .get(tenantNs.idFromName(parsed.tenantId))
        .fetch("https://tenant-usage-guard/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "clear_dead_lease",
            attemptId: parsed.attemptId,
            ...(parsed.expectedTenantExpiresAt === undefined
              ? {}
              : { expectedExpiresAt: parsed.expectedTenantExpiresAt }),
          }),
        });
      if (!tenantRes.ok) throw new Error("tenant guard unavailable");
      const tenant = parseClearDecision(await tenantRes.json());
      const globalRes = await globalNs
        .get(globalNs.idFromName(GLOBAL_USAGE_GUARD_NAME))
        .fetch("https://global-usage-guard/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "clear_dead_lease",
            tenantId: parsed.tenantId,
            attemptId: parsed.attemptId,
            ...(parsed.expectedGlobalExpiresAt === undefined
              ? {}
              : { expectedExpiresAt: parsed.expectedGlobalExpiresAt }),
          }),
        });
      if (!globalRes.ok) throw new Error("global guard unavailable");
      const global = parseClearDecision(await globalRes.json());
      return new Response(
        JSON.stringify({ ok: tenant.ok && global.ok, tenant, global }),
        {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        },
      );
    } catch {
      // Refusals are honest per-side outcomes above; this is the
      // unavailable path (unbound or errored guard), never a fabricated
      // success.
      return Response.json({ error: "lease_clear_unavailable" }, { status: 503 });
    }
  }
}
