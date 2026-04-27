import type { MiddlewareHandler } from "hono";
import type { Env } from "./index";

export const requireBearer = (): MiddlewareHandler<{ Bindings: Env }> => {
  return async (c, next) => {
    const expected = c.env.READER_API_TOKEN;
    if (!expected) return c.json({ error: "auth misconfigured" }, 500);

    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m || !timingSafeEqual(m[1]!, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
    return undefined;
  };
};

export const corsMiddleware = (): MiddlewareHandler<{ Bindings: Env }> => {
  return async (c, next) => {
    const allowed = parseAllowedOrigins(c.env.CORS_ALLOWED_ORIGINS);
    const origin = c.req.header("origin");

    if (c.req.method === "OPTIONS") {
      if (origin && allowed.includes(origin)) {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(origin),
        });
      }
      return new Response(null, { status: 403 });
    }

    await next();

    if (origin && allowed.includes(origin)) {
      const headers = corsHeaders(origin);
      for (const [k, v] of Object.entries(headers)) {
        c.res.headers.set(k, v);
      }
    }
    return undefined;
  };
};

function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
