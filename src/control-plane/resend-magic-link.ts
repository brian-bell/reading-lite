import type { Env } from "../index";
import { RESEND_EMAILS_URL } from "../modules/email";
import { renderMagicLinkMail } from "./magic-link-mail";

export function buildMagicLinkResendPayload(from: string, to: string, verifyUrl: string): Record<string, unknown> {
  const rendered = renderMagicLinkMail(verifyUrl);
  return {
    from,
    to: [to],
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    tracking: { click: false, open: false },
  };
}

export async function sendMagicLinkViaResend(
  env: Env,
  to: string,
  verifyUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured");
  }
  const from = env.EMAIL_FROM?.trim();
  if (!from) {
    throw new Error("EMAIL_FROM is not configured");
  }
  const payload = buildMagicLinkResendPayload(from, to, verifyUrl);
  const res = await fetchImpl(RESEND_EMAILS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Resend rejected magic-link mail (${res.status})`);
  }
}
