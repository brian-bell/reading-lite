import type { ProcessReadingArgs } from "../attempt-ownership";
import type { ControlPlaneDb } from "./db";
import { isAuthMailAllowed } from "./mail-allowlist";

export type ImmediateNotificationSkip =
  | "empty_from"
  | "missing_user"
  | "inactive_user"
  | "unverified_email"
  | "missing_settings"
  | "opted_out"
  | "allowlist";

export type ImmediateNotificationDecision =
  | { kind: "send"; to: string; from: string }
  | { kind: "skip"; reason: ImmediateNotificationSkip };

/**
 * Send-time item gate. Import is always silent, even when the body or
 * `--email` asked for mail. Submit defaults to true when `email` is absent
 * (in-flight queue messages); every other trigger defaults to false.
 */
export function itemRequestsImmediateEmail(
  args: Pick<ProcessReadingArgs, "trigger" | "email">,
): boolean {
  if (args.trigger === "import") return false;
  if (args.email !== undefined) return args.email;
  return args.trigger === "submit";
}

interface NotificationUserRow {
  email_canonical: string;
  email_display: string;
  status: string;
  email_verified_at_ms: number | null;
  notify_immediate: number | null;
}

/**
 * Send-time recipient is the current verified `users.email_display`.
 * `EMAIL_TO` is never consulted. Missing settings, inactive/unverified users,
 * opt-out, empty `EMAIL_FROM`, and staging allowlist all skip.
 */
export async function resolveImmediateNotification(
  db: ControlPlaneDb,
  env: {
    APP_ENV?: string;
    AUTH_MAIL_ALLOWLIST?: string;
    FOUNDER_EMAIL?: string;
    EMAIL_FROM: string;
  },
  tenantId: string,
): Promise<ImmediateNotificationDecision> {
  const from = env.EMAIL_FROM?.trim() ?? "";
  if (!from) return { kind: "skip", reason: "empty_from" };

  const row = await db.first<NotificationUserRow>(
    `SELECT u.email_canonical, u.email_display, u.status, u.email_verified_at_ms,
            s.notify_immediate
       FROM users u
       LEFT JOIN user_settings s ON s.user_id = u.id
      WHERE u.id = ?`,
    tenantId,
  );
  if (!row) return { kind: "skip", reason: "missing_user" };
  if (row.status !== "active") return { kind: "skip", reason: "inactive_user" };
  if (row.email_verified_at_ms == null) return { kind: "skip", reason: "unverified_email" };
  if (row.notify_immediate == null) return { kind: "skip", reason: "missing_settings" };
  if (row.notify_immediate !== 1) return { kind: "skip", reason: "opted_out" };
  if (!isAuthMailAllowed(env, row.email_canonical)) {
    return { kind: "skip", reason: "allowlist" };
  }
  return { kind: "send", to: row.email_display, from };
}
