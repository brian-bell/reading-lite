import type { Env } from "../index";
import { logAuthEvent } from "./auth-log";
import { isAuthMailAllowed } from "./mail-allowlist";
import { sendAuthMailViaResend } from "./resend-mail";

export type SecurityMailKind =
  | "sessions_revoked_all"
  | "email_changed"
  | "api_token_created"
  | "account_deletion_started";

export interface SecurityMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  kind: SecurityMailKind;
}

export type SendSecurityMail = (message: SecurityMail) => Promise<void>;

export function renderSecurityMail(kind: SecurityMailKind): { subject: string; html: string; text: string } {
  if (kind === "email_changed") {
    const subject = "reading-lite: login email changed";
    const text = [
      "The login email for your reading-lite account was changed.",
      "If you did this, no action is needed.",
      "If you did not, request a new sign-in link immediately.",
    ].join("\n");
    const html = [
      "<p>The login email for your reading-lite account was changed.</p>",
      "<p>If you did this, no action is needed.</p>",
      "<p>If you did not, request a new sign-in link immediately.</p>",
    ].join("\n");
    return { subject, html, text };
  }
  if (kind === "api_token_created") {
    const subject = "reading-lite: API key created";
    const text = [
      "A new API key was created for your reading-lite account.",
      "If you did this, no action is needed.",
      "If you did not, revoke unused keys, revoke other browser sessions, and request a new sign-in link immediately.",
    ].join("\n");
    const html = [
      "<p>A new API key was created for your reading-lite account.</p>",
      "<p>If you did this, no action is needed.</p>",
      "<p>If you did not, revoke unused keys, revoke other browser sessions, and request a new sign-in link immediately.</p>",
    ].join("\n");
    return { subject, html, text };
  }
  if (kind === "account_deletion_started") {
    const subject = "reading-lite: account deletion started";
    const text = [
      "Deletion of your reading-lite account has started.",
      "If you did this, no action is needed. Access is revoked immediately.",
      "If you did not, open a GitHub issue on https://github.com/brian-bell/reading-lite.",
    ].join("\n");
    const html = [
      "<p>Deletion of your reading-lite account has started.</p>",
      "<p>If you did this, no action is needed. Access is revoked immediately.</p>",
      "<p>If you did not, open a GitHub issue on https://github.com/brian-bell/reading-lite.</p>",
    ].join("\n");
    return { subject, html, text };
  }
  if (kind !== "sessions_revoked_all") {
    throw new Error(`unknown security mail kind: ${kind}`);
  }
  const subject = "reading-lite: all sessions revoked";
  const text = [
    "All browser sessions for your reading-lite account were revoked.",
    "If you did this, no action is needed.",
    "If you did not, request a new sign-in link immediately.",
  ].join("\n");
  const html = [
    "<p>All browser sessions for your reading-lite account were revoked.</p>",
    "<p>If you did this, no action is needed.</p>",
    "<p>If you did not, request a new sign-in link immediately.</p>",
  ].join("\n");
  return { subject, html, text };
}

export function assertNoSecrets(body: string): void {
  if (/(secret|token|cookie|credential|authorization|hmac)/i.test(body)) {
    throw new Error("security mail must not include secrets");
  }
}

export async function deliverSecurityMail(
  env: Env,
  input: {
    emailCanonical: string;
    emailDisplay: string;
    kind: SecurityMailKind;
    nowMs: number;
    sendSecurityMail?: SendSecurityMail;
  },
): Promise<void> {
  if (!isAuthMailAllowed(env, input.emailCanonical)) {
    logAuthEvent("security_mail_skipped", { email: input.emailDisplay, kind: input.kind });
    return;
  }
  const rendered = renderSecurityMail(input.kind);
  assertNoSecrets(`${rendered.subject}\n${rendered.text}\n${rendered.html}`);
  const message: SecurityMail = {
    to: input.emailDisplay,
    kind: input.kind,
    ...rendered,
  };
  try {
    if (input.sendSecurityMail) {
      await input.sendSecurityMail(message);
    } else if (env.APP_ENV === "staging" || env.APP_ENV === "production") {
      await sendAuthMailViaResend(env, message);
    } else if (env.LOCAL_MAIL_SINK === "1") {
      // Do not write into dev_mail_outbox: that table is the magic-link mailbox.
      logAuthEvent("security_mail_local", { email: input.emailDisplay, kind: input.kind });
    } else {
      logAuthEvent("security_mail_skipped", { email: input.emailDisplay, kind: input.kind });
      return;
    }
  } catch {
    logAuthEvent("security_mail_failed", { email: input.emailDisplay, kind: input.kind });
    return;
  }
  logAuthEvent("security_mail_sent", { email: input.emailDisplay, kind: input.kind });
}
