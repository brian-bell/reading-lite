import type { Context } from "hono";
import { DeleteAccountBodySchema } from "../schemas/api";
import { jsonAuth, type AuthRuntime } from "./auth-handlers";
import { beginAccountDeletion } from "./account-delete";
import { logAuthEvent } from "./auth-log";
import { clearSessionCookieHeader } from "./cookies";
import { fromD1 } from "./db";
import { deliverSecurityMail } from "./security-mail";
import type { AppBindings } from "../middleware";

export async function handleDeleteAccount(
  c: Context<AppBindings>,
  nowMs: number,
  runtime: AuthRuntime,
): Promise<Response> {
  const principal = c.get("principal");
  const json = await c.req.json().catch(() => null);
  const parsed = DeleteAccountBodySchema.safeParse(json);
  if (!parsed.success) return jsonAuth({ error: "invalid body" }, 400);

  const db = fromD1(c.env.CONTROL_PLANE);
  const userId = String(principal.userId);
  const outcome = await beginAccountDeletion(db, { userId, nowMs });
  if (outcome.kind === "not_found") return jsonAuth({ error: "not found" }, 404);
  if (outcome.kind === "not_active") return jsonAuth({ error: "forbidden" }, 403);

  logAuthEvent("account_deletion_started", {
    user_id: userId,
    already: outcome.kind === "already_deleting",
  });

  if (outcome.kind === "started") {
    const user = await db.first<{ email_canonical: string; email_display: string }>(
      "SELECT email_canonical, email_display FROM users WHERE id = ?",
      userId,
    );
    if (user) {
      await deliverSecurityMail(c.env, {
        emailCanonical: user.email_canonical,
        emailDisplay: user.email_display,
        kind: "account_deletion_started",
        nowMs,
        sendSecurityMail: runtime.sendSecurityMail,
      });
    }
  }

  return jsonAuth({ ok: true }, 200, { "set-cookie": clearSessionCookieHeader() });
}
