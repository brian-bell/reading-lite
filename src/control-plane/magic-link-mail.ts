import { originOfUrl } from "./origin";

export interface MagicLinkMail {
  to: string;
  subject: string;
  verifyUrl: string;
}

export type SendMagicLink = (message: MagicLinkMail) => Promise<void>;

export function buildMagicLinkVerifyUrl(webBaseUrl: string, credential: string): string {
  const base = webBaseUrl.replace(/\/+$/, "");
  return `${base}/login/verify#${credential}`;
}

export function publicWebBase(webBaseUrl: string | undefined, requestUrl: string): string {
  if (webBaseUrl && webBaseUrl.trim() !== "") {
    return webBaseUrl.replace(/\/+$/, "");
  }
  return originOfUrl(requestUrl) ?? "";
}

export function renderMagicLinkMail(verifyUrl: string): { subject: string; html: string; text: string } {
  const subject = "Sign in to reading-lite";
  const text = [
    "Use this link to sign in to reading-lite.",
    "It expires in 15 minutes and can be used once.",
    "",
    verifyUrl,
    "",
    "If you did not request this, you can ignore this message.",
  ].join("\n");
  const html = [
    "<p>Use this link to sign in to reading-lite.</p>",
    "<p>It expires in 15 minutes and can be used once.</p>",
    `<p><a href="${escapeAttr(verifyUrl)}">Sign in</a></p>`,
    `<p>${escapeText(verifyUrl)}</p>`,
    "<p>If you did not request this, you can ignore this message.</p>",
  ].join("\n");
  return { subject, html, text };
}

export async function storeLocalMagicLink(
  db: import("./db").ControlPlaneDb,
  input: { to: string; subject: string; verifyUrl: string; nowMs: number },
): Promise<void> {
  await db.run(
    "INSERT INTO dev_mail_outbox (to_email, subject, verify_url, sent_at_ms) VALUES (?, ?, ?, ?)",
    input.to,
    input.subject,
    input.verifyUrl,
    input.nowMs,
  );
}

export async function latestLocalMagicLink(
  db: import("./db").ControlPlaneDb,
  toEmail: string,
): Promise<{ to_email: string; subject: string; verify_url: string; sent_at_ms: number } | null> {
  return db.first(
    `SELECT to_email, subject, verify_url, sent_at_ms
     FROM dev_mail_outbox
     WHERE lower(to_email) = ?
     ORDER BY sent_at_ms DESC, id DESC`,
    toEmail,
  );
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
