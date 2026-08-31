import type { Context } from "hono";
import { jsonAuth, type AuthRuntime } from "./auth-handlers";
import { logAuthEvent } from "./auth-log";
import { clearSessionCookieHeader } from "./cookies";
import { fromD1 } from "./db";
import { parseSessionId } from "./ids";
import {
  listSessionsForUser,
  revokeAllSessionsForUser,
  revokeOwnedSession,
} from "./sessions";
import { deliverSecurityMail } from "./security-mail";
import type { AppBindings } from "../middleware";

export async function handleListSessions(c: Context<AppBindings>, nowMs: number): Promise<Response> {
  const principal = c.get("principal");
  const listed = await listSessionsForUser(fromD1(c.env.CONTROL_PLANE), {
    userId: principal.userId,
    nowMs,
    ...(principal.kind === "session" ? { currentSessionId: principal.sessionId } : {}),
  });
  return jsonAuth(listed, 200);
}

export async function handleRevokeSession(c: Context<AppBindings>, nowMs: number): Promise<Response> {
  const principal = c.get("principal");
  const rawId = c.req.param("id") ?? "";
  const sessionId = parseSessionId(rawId);
  if (!sessionId) return jsonAuth({ error: "invalid session" }, 400);

  const outcome = await revokeOwnedSession(fromD1(c.env.CONTROL_PLANE), {
    sessionId,
    userId: principal.userId,
    nowMs,
    reason: "user",
  });
  if (outcome === "not_found") return jsonAuth({ error: "not found" }, 404);

  logAuthEvent("session_revoked", { session_id: sessionId });
  const extraHeaders: HeadersInit = {};
  if (principal.kind === "session" && principal.sessionId === sessionId) {
    extraHeaders["set-cookie"] = clearSessionCookieHeader();
  }
  return jsonAuth({ ok: true }, 200, extraHeaders);
}

export async function handleRevokeAllSessions(
  c: Context<AppBindings>,
  nowMs: number,
  runtime: AuthRuntime,
): Promise<Response> {
  const principal = c.get("principal");
  const db = fromD1(c.env.CONTROL_PLANE);
  const revoked = await revokeAllSessionsForUser(db, {
    userId: principal.userId,
    nowMs,
    reason: "revoke_all",
  });
  logAuthEvent("sessions_revoked_all", { user_id: String(principal.userId), revoked });

  if (revoked > 0) {
    const user = await db.first<{ email_canonical: string; email_display: string }>(
      "SELECT email_canonical, email_display FROM users WHERE id = ?",
      String(principal.userId),
    );
    if (user) {
      await deliverSecurityMail(c.env, {
        emailCanonical: user.email_canonical,
        emailDisplay: user.email_display,
        kind: "sessions_revoked_all",
        nowMs,
        sendSecurityMail: runtime.sendSecurityMail,
      });
    }
  }

  const extraHeaders: HeadersInit = {};
  if (principal.kind === "session") {
    extraHeaders["set-cookie"] = clearSessionCookieHeader();
  }
  return jsonAuth({ ok: true }, 200, extraHeaders);
}
