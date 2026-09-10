import { MAGIC_LINK_VERIFY_PATH } from "./constants";
import { isPublicWebOrigin, originOfUrl } from "./origin";

export interface MagicLinkMail {
  to: string;
  subject: string;
  verifyUrl: string;
}

export type SendMagicLink = (message: MagicLinkMail) => Promise<void>;

export type MagicLinkDelivery =
  | { kind: "injected"; send: SendMagicLink }
  | { kind: "local_sink" }
  | { kind: "resend" }
  | { kind: "unavailable" };

export function resolveMagicLinkDelivery(
  env: { APP_ENV?: string; LOCAL_MAIL_SINK?: string },
  runtime: { sendMagicLink?: SendMagicLink },
): MagicLinkDelivery {
  if (runtime.sendMagicLink) return { kind: "injected", send: runtime.sendMagicLink };
  if (env.APP_ENV === "staging" || env.APP_ENV === "production") return { kind: "resend" };
  if (env.LOCAL_MAIL_SINK === "1") return { kind: "local_sink" };
  return { kind: "unavailable" };
}

export function buildMagicLinkVerifyUrl(
  webBaseUrl: string,
  credential: string,
  query?: { purpose?: string },
): string {
  const base = webBaseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (query?.purpose) params.set("purpose", query.purpose);
  const qs = params.toString() === "" ? "" : `?${params.toString()}`;
  return `${base}${MAGIC_LINK_VERIFY_PATH}${qs}#${credential}`;
}

/**
 * Base URL for the magic-link mail (both call sites are in `auth-handlers`).
 * Notification and digest links are queue-side, have no inbound request to
 * read a host from, and go on using `WEB_BASE_URL` directly.
 *
 * The Worker answers on more than one public host, so a
 * login started on either one has to be answered on that same host: the session
 * cookie is `__Host-`-prefixed and therefore host-only, and a link back to the
 * other host would drop the user on a page they are not signed in on. The
 * request's own origin is preferred when it is a known public host, and
 * `WEB_BASE_URL` is the fallback for every other case.
 *
 * `requestUrl` derives from the inbound `Host` header, so it is not
 * trustworthy on its own — that is exactly what the allowlist is for. An
 * unrecognised or spoofed host cannot steer a link anywhere; it lands on the
 * configured base as before.
 */
export function publicWebBase(webBaseUrl: string | undefined, requestUrl: string): string {
  const requestOrigin = originOfUrl(requestUrl);
  if (requestOrigin && isPublicWebOrigin(requestOrigin)) return requestOrigin;
  if (webBaseUrl && webBaseUrl.trim() !== "") {
    return webBaseUrl.replace(/\/+$/, "");
  }
  return requestOrigin ?? "";
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

export function renderEmailChangeMagicLinkMail(verifyUrl: string): { subject: string; html: string; text: string } {
  const subject = "Confirm your reading-lite email";
  const text = [
    "Use this link to confirm a new login email for reading-lite.",
    "It expires in 15 minutes and can be used once.",
    "",
    verifyUrl,
    "",
    "If you did not request this, you can ignore this message.",
  ].join("\n");
  const html = [
    "<p>Use this link to confirm a new login email for reading-lite.</p>",
    "<p>It expires in 15 minutes and can be used once.</p>",
    `<p><a href="${escapeAttr(verifyUrl)}">Confirm email</a></p>`,
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
