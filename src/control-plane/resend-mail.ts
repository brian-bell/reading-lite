import type { Env } from "../index";
import { RESEND_EMAILS_URL } from "../modules/email";

export interface AuthResendMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Auth and security mail omit a `tracking` field: the Send Email API has none.
 * Click/open tracking is a domain setting (`PATCH /domains/:id`) and is off by
 * default. Do not PATCH domains from the send path.
 */
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
    throw new Error(`Resend rejected auth mail (${res.status}${await resendErrorName(res)})`);
  }
}

/**
 * Resend's error body is `{ statusCode, name, message }`; `name` is a stable
 * code such as `restricted_api_key` or `validation_error`. Carry it, and only
 * it, into the thrown message so the auth log's `reason` says why delivery
 * failed without echoing the free-text message.
 */
async function resendErrorName(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    const name = body && typeof body === "object" ? (body as { name?: unknown }).name : undefined;
    return typeof name === "string" && /^[a-z_]{1,64}$/.test(name) ? ` ${name}` : "";
  } catch {
    return "";
  }
}
