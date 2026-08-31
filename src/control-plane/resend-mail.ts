import type { Env } from "../index";
import { RESEND_EMAILS_URL } from "../modules/email";

/** Explicitly disable Resend click/open tracking on auth and security mail. */
export const RESEND_AUTH_TRACKING = { click: false, open: false } as const;

export interface AuthResendMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export function buildAuthResendPayload(
  from: string,
  message: AuthResendMessage,
): Record<string, unknown> {
  return {
    from,
    to: [message.to],
    subject: message.subject,
    text: message.text,
    html: message.html,
    tracking: { ...RESEND_AUTH_TRACKING },
  };
}

export async function sendAuthMailViaResend(
  env: Env,
  message: AuthResendMessage,
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
  const payload = buildAuthResendPayload(from, message);
  const res = await fetchImpl(RESEND_EMAILS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Resend rejected auth mail (${res.status})`);
  }
}
