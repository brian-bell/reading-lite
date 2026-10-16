// Read-only entrypoint for the frontend Worker's server renders (ADR 0003,
// Server reads). Exported as a named WorkerEntrypoint from src/index.ts and
// reachable only through a service binding with `entrypoint = "FrontendReads"`;
// it is not on the public router.
//
// Each method rebuilds a same-origin GET from the browser's Cookie header and
// the request host, registers it with trustFrontendRead (so requirePrincipal
// accepts the cookie without forged browser headers), and dispatches it through
// the Worker's own Hono app. Session authentication, tenant resolution, scopes,
// the x-expected-tenant pin, and the handlers are the HTTP API's, so statuses
// and bodies match it. Session auth refreshes the session's last-seen time, as
// any authenticated GET does; nothing else is written.
//
// Results are `{ status, body }` only. No response header crosses the binding,
// so the entrypoint cannot set cookies. Bearer credentials are never forwarded.
//
// Every prototype method is callable over RPC: keep helpers at module level and
// add a method here only for an allowlisted read.

import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { trustFrontendRead } from "./control-plane/frontend-read-trust";
import { createApp } from "./router";
import { EXPECTED_TENANT_HEADER, FACET_PARAM, TERM_KINDS } from "./schemas/api";
import type { Env } from "./index";

export type FrontendReadResult = { status: number; body: unknown };

const HostSchema = z.string().refine(isBareHost);

const WhoamiInputSchema = z
  .object({
    cookie: z.string().max(16_384).nullable(),
    host: HostSchema,
  })
  .strict();

const ReadingInputSchema = z
  .object({
    cookie: z.string().max(16_384).nullable(),
    host: HostSchema,
    id: z.string().min(1).max(200).refine((id) => id !== "." && id !== ".."),
    expectedTenant: z.string().min(1).max(200).optional(),
  })
  .strict();

const FacetInputSchema = z
  .object({
    kind: z.enum(TERM_KINDS),
    term: z.string().min(1).max(2048),
  })
  .strict();

// Only the library's own parameters cross the binding. The page size is not
// one: the list handler's default is the library's 20-row page.
const ListInputSchema = z
  .object({
    cookie: z.string().max(16_384).nullable(),
    host: HostSchema,
    q: z.string().max(2048).optional(),
    tag: z.string().max(2048).optional(),
    facet: FacetInputSchema.optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    expectedTenant: z.string().min(1).max(200).optional(),
  })
  .strict();

const RelationshipsInputSchema = z
  .object({
    cookie: z.string().max(16_384).nullable(),
    host: HostSchema,
    expectedTenant: z.string().min(1).max(200).optional(),
  })
  .strict();

const TermsInputSchema = z
  .object({
    cookie: z.string().max(16_384).nullable(),
    host: HostSchema,
    expectedTenant: z.string().min(1).max(200).optional(),
  })
  .strict();

const DeskInputSchema = z
  .object({
    cookie: z.string().max(16_384).nullable(),
    host: HostSchema,
    since: z.string().datetime().optional(),
    expectedTenant: z.string().min(1).max(200).optional(),
  })
  .strict();

export type FrontendWhoamiInput = z.infer<typeof WhoamiInputSchema>;
export type FrontendReadingInput = z.infer<typeof ReadingInputSchema>;
export type FrontendListInput = z.infer<typeof ListInputSchema>;
export type FrontendRelationshipsInput = z.infer<typeof RelationshipsInputSchema>;
export type FrontendTermsInput = z.infer<typeof TermsInputSchema>;
export type FrontendDeskInput = z.infer<typeof DeskInputSchema>;

const INVALID: FrontendReadResult = { status: 400, body: { error: "invalid request" } };

const app = createApp();

export class FrontendReads extends WorkerEntrypoint<Env> {
  /** GET /api/whoami for the session in `cookie`. */
  async whoami(input: FrontendWhoamiInput): Promise<FrontendReadResult> {
    const parsed = WhoamiInputSchema.safeParse(input);
    if (!parsed.success) return INVALID;
    return dispatch(this.env, this.ctx, parsed.data.host, "/api/whoami", parsed.data.cookie);
  }

  /** GET /api/readings/:id for the session in `cookie`, optionally pinned to `expectedTenant`. */
  async reading(input: FrontendReadingInput): Promise<FrontendReadResult> {
    const parsed = ReadingInputSchema.safeParse(input);
    if (!parsed.success) return INVALID;
    const { host, id, cookie, expectedTenant } = parsed.data;
    return dispatch(
      this.env,
      this.ctx,
      host,
      `/api/readings/${encodeURIComponent(id)}`,
      cookie,
      pinned(expectedTenant),
    );
  }

  /** GET /api/readings for the session in `cookie`, with `q`, `tag`, one facet, and `offset`, optionally pinned. */
  async list(input: FrontendListInput): Promise<FrontendReadResult> {
    const parsed = ListInputSchema.safeParse(input);
    if (!parsed.success) return INVALID;
    const { host, cookie, q, tag, facet, offset, expectedTenant } = parsed.data;
    const query = new URLSearchParams();
    // Empty filters are omitted, as the SPA writes them.
    if (q) query.set("q", q);
    if (tag) query.set("tag", tag);
    if (facet) query.set(FACET_PARAM[facet.kind], facet.term);
    if (offset !== undefined) query.set("offset", String(offset));
    const search = query.toString();
    return dispatch(
      this.env,
      this.ctx,
      host,
      search === "" ? "/api/readings" : `/api/readings?${search}`,
      cookie,
      pinned(expectedTenant),
    );
  }

  /** GET /api/readings/terms for the session in `cookie`, optionally pinned. */
  async terms(input: FrontendTermsInput): Promise<FrontendReadResult> {
    const parsed = TermsInputSchema.safeParse(input);
    if (!parsed.success) return INVALID;
    const { host, cookie, expectedTenant } = parsed.data;
    return dispatch(this.env, this.ctx, host, "/api/readings/terms", cookie, pinned(expectedTenant));
  }

  /** GET /api/readings/relationships for the session in `cookie`, optionally pinned. */
  async relationships(input: FrontendRelationshipsInput): Promise<FrontendReadResult> {
    const parsed = RelationshipsInputSchema.safeParse(input);
    if (!parsed.success) return INVALID;
    const { host, cookie, expectedTenant } = parsed.data;
    return dispatch(this.env, this.ctx, host, "/api/readings/relationships", cookie, pinned(expectedTenant));
  }

  /** GET /api/desk for the session in `cookie`, with `since`, optionally pinned. */
  async desk(input: FrontendDeskInput): Promise<FrontendReadResult> {
    const parsed = DeskInputSchema.safeParse(input);
    if (!parsed.success) return INVALID;
    const { host, cookie, since, expectedTenant } = parsed.data;
    const path = since === undefined ? "/api/desk" : `/api/desk?${new URLSearchParams({ since })}`;
    return dispatch(this.env, this.ctx, host, path, cookie, pinned(expectedTenant));
  }

  /** Not an HTTP surface: calls must use the allowlisted methods. */
  fetch(): Response {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

function pinned(expectedTenant: string | undefined): Record<string, string> {
  return expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant };
}

async function dispatch(
  env: Env,
  ctx: ExecutionContext,
  host: string,
  path: string,
  cookie: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<FrontendReadResult> {
  const headers = new Headers(extraHeaders);
  if (cookie) headers.set("cookie", cookie);
  const request = trustFrontendRead(new Request(`https://${host}${path}`, { method: "GET", headers }));
  const response = await app.fetch(request, env, ctx);
  return { status: response.status, body: await jsonBody(response) };
}

async function jsonBody(response: Response): Promise<unknown> {
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    await response.body?.cancel();
    return null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** A bare `host[:port]`: no scheme, userinfo, path, query, or fragment. */
function isBareHost(host: string): boolean {
  if (host.length === 0 || host.length > 255) return false;
  try {
    const url = new URL(`https://${host}`);
    return url.host === host.toLowerCase() && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}
