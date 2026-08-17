import type { MiddlewareHandler } from "hono";
import { authenticateBearer } from "./control-plane/authenticate";
import { parseAuthRootSecret, type AuthRoot } from "./control-plane/crypto";
import { fromD1 } from "./control-plane/db";
import { principalHasScope, type ApiScope, type AuthenticatedPrincipal } from "./control-plane/principal";
import type { Env } from "./index";

export type AppBindings = {
  Bindings: Env;
  Variables: { principal: AuthenticatedPrincipal };
};

export const requirePrincipal = (): MiddlewareHandler<AppBindings> => {
  return async (c, next) => {
    if (!c.env.CONTROL_PLANE || !c.env.AUTH_ROOT_SECRET) {
      return jsonNoStore(c, { error: "auth misconfigured" }, 500);
    }

    let authRoot: AuthRoot;
    let previousAuthRoot: AuthRoot | undefined;
    try {
      authRoot = rootFromEnv(c.env.AUTH_ROOT_SECRET, c.env.AUTH_ROOT_KEY_VERSION, 1);
      previousAuthRoot = c.env.AUTH_PREVIOUS_ROOT_SECRET
        ? rootFromEnv(c.env.AUTH_PREVIOUS_ROOT_SECRET, c.env.AUTH_PREVIOUS_ROOT_KEY_VERSION, 0)
        : undefined;
    } catch {
      return jsonNoStore(c, { error: "auth misconfigured" }, 500);
    }

    const verdict = await authenticateBearer(fromD1(c.env.CONTROL_PLANE), {
      authorization: c.req.header("authorization"),
      authRoot,
      ...(previousAuthRoot ? { previousAuthRoot } : {}),
      nowMs: Date.now(),
    });
    if (verdict.kind === "unauthenticated") {
      return jsonNoStore(c, { error: "unauthorized" }, 401);
    }
    if (verdict.kind === "forbidden") {
      return jsonNoStore(c, { error: "forbidden" }, 403);
    }

    c.set("principal", verdict.principal);
    c.header("Cache-Control", "no-store");
    await next();
    return undefined;
  };
};

export const requireScope = (scope: ApiScope): MiddlewareHandler<AppBindings> => {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal || !principalHasScope(principal, scope)) {
      return jsonNoStore(c, { error: "forbidden" }, 403);
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

function rootFromEnv(secret: string, versionRaw: string | undefined, fallback: number): AuthRoot {
  const version = versionRaw === undefined || versionRaw === "" ? fallback : Number(versionRaw);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error("invalid auth root version");
  }
  return { secret: parseAuthRootSecret(secret), version };
}

function jsonNoStore(
  c: { json: (body: unknown, status: 401 | 403 | 500) => Response },
  body: unknown,
  status: 401 | 403 | 500,
): Response {
  const res = c.json(body, status);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

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
