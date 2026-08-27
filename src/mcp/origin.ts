import type { MiddlewareHandler } from "hono";
import type { Env } from "../index";

export const DEFAULT_MCP_ALLOWED_ORIGINS = ["https://reading-lite.bbell.dev"];

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
