import type { Env } from "../index";
import { renderMagicLinkMail } from "./magic-link-mail";
import { buildAuthResendPayload, sendAuthMailViaResend } from "./resend-mail";

export function buildMagicLinkResendPayload(from: string, to: string, verifyUrl: string): Record<string, unknown> {
  const rendered = renderMagicLinkMail(verifyUrl);
  return buildAuthResendPayload(from, {
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });
}

export async function sendMagicLinkViaResend(
  env: Env,
  to: string,
  verifyUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const rendered = renderMagicLinkMail(verifyUrl);
  await sendAuthMailViaResend(
    env,
    {
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    },
    fetchImpl,
  );
}
