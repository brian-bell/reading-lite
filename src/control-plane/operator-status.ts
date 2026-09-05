// Named entrypoint only: reachable through an account-authorized service
// binding, never mounted on the public router. Exposes one read, not guard RPC
// forwarding, so an operator status request cannot authorize or refund spend.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../index";
import { parseTenantId } from "./ids";
import { GLOBAL_USAGE_GUARD_NAME } from "./constants";
export class OperatorStatus extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (url.pathname !== "/status") return new Response(null, { status: 404 });
    const rawTenant = url.searchParams.get("tenant");
    const tenant = rawTenant === null ? undefined : parseTenantId(rawTenant);
    if (
      [...url.searchParams.keys()].some((key) => key !== "tenant") ||
      url.searchParams.getAll("tenant").length > 1 ||
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
            ...(tenant ? { tenantId: tenant } : {}),
          }),
        });
      if (!response.ok) throw new Error("unavailable");
      return new Response(response.body, {
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
