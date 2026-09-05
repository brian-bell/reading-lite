import type { MiddlewareHandler } from "hono";
import type { Env } from "../index";

/**
 * Origins a browser-based MCP client may present. The old host and both
 * public hosts are listed during the `readinglite.ai` / `readinglite.app`
 * dual-serve window; the match below is a whole-string comparison, so `www.`
 * and look-alike hosts are not covered by any entry and are rejected. Apex is
 * canonical, and `www` is expected to be redirected to it at the edge; if
 * `www` is ever routed to the Worker directly it needs its own entry here
 * rather than any loosening of the match.
 */
export const DEFAULT_MCP_ALLOWED_ORIGINS = [
  "https://reading-lite.bbell.dev",
  "https://readinglite.ai",
  "https://readinglite.app",
];

export function parseMcpAllowedOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return [...DEFAULT_MCP_ALLOWED_ORIGINS];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function mcpOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return true;
  return allowed.includes(origin);
}

export function mcpOriginGuard(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    const allowed = parseMcpAllowedOrigins(c.env.MCP_ALLOWED_ORIGINS);
    if (!mcpOriginAllowed(origin, allowed)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    await next();
    return undefined;
  };
}
