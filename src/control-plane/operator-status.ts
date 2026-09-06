// Named entrypoint only: reachable through an account-authorized service
// binding, never mounted on the public router. Exposes one read, not guard RPC
// forwarding, so an operator status request cannot authorize or refund spend.
import { SpendStatusSchema } from "./spend-status";
import { TenantInspectionSchema } from "./operator-inspection";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../index";
import { parseTenantId } from "./ids";
import { GLOBAL_USAGE_GUARD_NAME } from "./constants";
export class OperatorStatus extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (url.pathname !== "/status") return new Response(null, { status: 404 });
    const details = url.searchParams.get("details");
    const rawTenant = url.searchParams.get("tenant");
    const tenant = rawTenant === null ? undefined : parseTenantId(rawTenant);
    if (
      [...url.searchParams.keys()].some((key) => key !== "tenant" && key !== "details") ||
      url.searchParams.getAll("tenant").length > 1 ||
      url.searchParams.getAll("details").length > 1 ||
      (details !== null && details !== "1") ||
      tenant === null
    )
      return new Response(null, { status: 400 });
    try {
      const ns = this.env.GLOBAL_USAGE_GUARD;
      if (!ns) throw new Error("unbound");
      const response = await ns
        .get(ns.idFromName(GLOBAL_USAGE_GUARD_NAME))
        .fetch("https://guard/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "spend_status",
            ...(details ? { details: true } : {}),
            ...(tenant ? { tenantId: tenant } : {}),
          }),
        });
      if (!response.ok) throw new Error("unavailable");
      const result = SpendStatusSchema.parse(await response.json());
      if (details && !result.details) throw new Error("details unavailable");
      if (details && tenant) {
        const tenantNs = this.env.TENANT_USAGE_GUARD;
        if (!tenantNs) throw new Error("unbound");
        const tenantResponse = await tenantNs.get(tenantNs.idFromName(tenant)).fetch("https://guard/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "tenant_status", tenantId: tenant }) });
        if (!tenantResponse.ok) throw new Error("tenant unavailable");
        result.tenantDetails = TenantInspectionSchema.parse(await tenantResponse.json());
      }
      return new Response(JSON.stringify(result), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    } catch {
      return Response.json(
        { error: "accounting_unavailable" },
        { status: 503 },
      );
    }
  }
}
