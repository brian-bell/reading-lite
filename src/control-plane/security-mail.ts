import type { Env } from "../index";
import { logAuthEvent } from "./auth-log";
import type { ControlPlaneDb } from "./db";
import { isAuthMailAllowed } from "./mail-allowlist";
import { storeLocalMagicLink } from "./magic-link-mail";
import { sendAuthMailViaResend } from "./resend-mail";

export type SecurityMailKind = "sessions_revoked_all";

export interface SecurityMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  kind: SecurityMailKind;
}

export type SendSecurityMail = (message: SecurityMail) => Promise<void>;

export function renderSecurityMail(kind: SecurityMailKind): { subject: string; html: string; text: string } {
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
  db: ControlPlaneDb,
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
      await storeLocalMagicLink(db, {
        to: message.to,
        subject: message.subject,
        verifyUrl: "",
        nowMs: input.nowMs,
      });
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
