// Account-authorized service binding only; never mounted on the public router.
// Operators always require overdue leases. Both callers use the same global
// recovery authority; this entrypoint only validates and translates HTTP.
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import type { Env } from "../index";
import { parseTenantId } from "./ids";
import { recoverProcessingLeases } from "./processing-lease-recovery";

const ClearRequestSchema = z.object({
  tenantId: z.string().refine(value => parseTenantId(value) !== null),
  attemptId: z.string().min(1),
  expectedTenantExpiresAt: z.number().finite().nonnegative().optional(),
  expectedGlobalExpiresAt: z.number().finite().nonnegative().optional(),
}).strict();

export class OperatorLeaseClear extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const url = new URL(request.url);
    if (url.pathname !== "/clear") return new Response(null, { status: 404 });
    if (url.search) return new Response(null, { status: 400 });
    const parsed = ClearRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response(null, { status: 400 });
    const body = parsed.data;
    const outcome = await recoverProcessingLeases(this.env, body.tenantId, body.attemptId, {
      expected: { tenant: body.expectedTenantExpiresAt ?? null, global: body.expectedGlobalExpiresAt ?? null },
    });
    if (outcome.kind === "unavailable") {
      return Response.json({ error: "lease_clear_unavailable" }, { status: 503 });
    }
    return Response.json(outcome.result, { headers: { "cache-control": "no-store" } });
  }
}
