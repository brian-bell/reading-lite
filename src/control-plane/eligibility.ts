import type { SignupMode } from "./bootstrap";
import type { ControlPlaneDb } from "./db";

export interface ExistingUser {
  id: string;
  email_display: string;
  status: string;
}

export type LoginEligibility =
  | { kind: "existing_user"; user: ExistingUser }
  | { kind: "provisionable"; emailDisplay: string; source: "invite" | "open" }
  | { kind: "ineligible" };

export async function loadSignupMode(db: ControlPlaneDb): Promise<SignupMode> {
  const row = await db.first<{ signup_mode: string }>("SELECT signup_mode FROM system_policy WHERE id = 1");
  if (row?.signup_mode === "open" || row?.signup_mode === "invite_only" || row?.signup_mode === "closed") {
    return row.signup_mode;
  }
  return "closed";
}

export async function resolveLoginEligibility(
  db: ControlPlaneDb,
  emailCanonical: string,
  nowMs: number,
): Promise<LoginEligibility> {
  const user = await db.first<ExistingUser>(
    "SELECT id, email_display, status FROM users WHERE email_canonical = ?",
    emailCanonical,
  );
  if (user) {
    return user.status === "active" ? { kind: "existing_user", user } : { kind: "ineligible" };
  }

  const mode = await loadSignupMode(db);
  if (mode === "closed") return { kind: "ineligible" };
  if (mode === "open") return { kind: "provisionable", emailDisplay: emailCanonical, source: "open" };

  const invite = await db.first<{ email_display: string; expires_at_ms: number | null; consumed_at_ms: number | null }>(
    "SELECT email_display, expires_at_ms, consumed_at_ms FROM signup_invites WHERE email_canonical = ?",
    emailCanonical,
  );
  if (!invite) return { kind: "ineligible" };
  if (invite.consumed_at_ms != null) return { kind: "ineligible" };
  if (invite.expires_at_ms != null && invite.expires_at_ms <= nowMs) return { kind: "ineligible" };
  return { kind: "provisionable", emailDisplay: invite.email_display, source: "invite" };
}
