import type { Context } from "hono";
import { jsonAuth, type AuthRuntime } from "./auth-handlers";
import { logAuthEvent } from "./auth-log";
import { readAuthRoots } from "./auth-root";
import { fromSql } from "./db";
import { parseTokenId } from "./ids";
import { createApiToken, listApiTokensForUser, revokeOwnedApiToken } from "./tokens";
import { deliverSecurityMail } from "./security-mail";
import { sanitizeUserAgent } from "./user-agent";
import { PostAuthTokensBodySchema } from "../schemas/api";
import type { AppBindings } from "../middleware";

export async function handleCreateApiToken(
  c: Context<AppBindings>,
  nowMs: number,
  runtime: AuthRuntime,
): Promise<Response> {
  const principal = c.get("principal");
  const json = await c.req.json().catch(() => null);
  const parsed = PostAuthTokensBodySchema.safeParse(json);
  if (!parsed.success) return jsonAuth({ error: "invalid body" }, 400);

  const roots = readAuthRoots(c.env);
  const created = await createApiToken(fromSql(c.get("sql")), {
    userId: principal.userId,
    name: parsed.data.name,
    scopes: parsed.data.scopes,
    ...(parsed.data.expires_at_ms !== undefined ? { expiresAtMs: parsed.data.expires_at_ms } : {}),
    nowMs,
    authRoot: roots.authRoot,
    userAgentLabel: sanitizeUserAgent(c.req.header("user-agent")),
    randomBytes: runtime.randomBytes,
    newUuid: runtime.newUuid,
  });
  if (created.kind === "invalid_name" || created.kind === "invalid_scopes" || created.kind === "invalid_expiry") {
    return jsonAuth({ error: "invalid body" }, 400);
  }
  if (created.kind === "cap") return jsonAuth({ error: "too many active tokens" }, 409);

  logAuthEvent("api_token_created", { id: created.created.id, user_id: String(principal.userId) });
  const user = await fromSql(c.get("sql")).first<{
    email_canonical: string;
    email_display: string;
  }>("SELECT email_canonical, email_display FROM users WHERE id = ?", String(principal.userId));
  if (user) {
    await deliverSecurityMail(c.env, {
      emailCanonical: user.email_canonical,
      emailDisplay: user.email_display,
      kind: "api_token_created",
      nowMs,
      sendSecurityMail: runtime.sendSecurityMail,
    });
  }
  return jsonAuth(created.created, 201);
}

export async function handleListApiTokens(c: Context<AppBindings>, nowMs: number): Promise<Response> {
  const principal = c.get("principal");
  const listed = await listApiTokensForUser(fromSql(c.get("sql")), {
    userId: principal.userId,
    nowMs,
  });
  return jsonAuth(listed, 200);
}

export async function handleRevokeApiToken(c: Context<AppBindings>, nowMs: number): Promise<Response> {
  const principal = c.get("principal");
  const rawId = c.req.param("id") ?? "";
  const tokenId = parseTokenId(rawId);
  if (!tokenId) return jsonAuth({ error: "invalid token" }, 400);

  const outcome = await revokeOwnedApiToken(fromSql(c.get("sql")), {
    tokenId,
    userId: principal.userId,
    nowMs,
  });
  if (outcome === "not_found") return jsonAuth({ error: "not found" }, 404);

  logAuthEvent("api_token_revoked", { id: tokenId });
  return jsonAuth({ ok: true }, 200);
}
