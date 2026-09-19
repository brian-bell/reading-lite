// Account-authorized service binding only; never mounted on the public router.
// Operator commands reach the central spend authority through exactly the
// four spend verbs createPaidFetch issues. Leases, purge, recovery, and status
// stay unreachable from here; this entrypoint only validates and forwards.
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import type { Env } from "../index";
import { parseTenantId } from "./ids";
import { spendRpcFor } from "./paid-dispatch";
import { validSpendQuote } from "./spend-ledger";

const identity = {
  tenantId: z.string().refine(value => parseTenantId(value) !== null),
  opId: z.string().min(1).max(512),
  quote: z.unknown().refine(validSpendQuote),
};

const SpendRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reserve_spend"), ...identity, nowMs: z.number().finite().nonnegative() }).strict(),
  z.object({ kind: z.literal("mark_spend_dispatched"), ...identity }).strict(),
  z.object({ kind: z.literal("release_spend"), ...identity }).strict(),
  z.object({ kind: z.literal("settle_spend"), ...identity, actualMicrodollars: z.number().int().nonnegative().safe() }).strict(),
]);

export class OperatorSpend extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const url = new URL(request.url);
    if (url.pathname !== "/spend") return new Response(null, { status: 404 });
    if (url.search) return new Response(null, { status: 400 });
    const parsed = SpendRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response(null, { status: 400 });
    // An unreachable authority is a decision, not an error: {ok:false} is the
    // only answer the caller's paid fetch can act on without guessing.
    return Response.json(await spendRpcFor(this.env)(parsed.data), { headers: { "cache-control": "no-store" } });
  }
}
