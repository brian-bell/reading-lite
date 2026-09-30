import type { Env } from "../index";
import { renderMagicLinkMail } from "./magic-link-mail";
import { sendAuthMailViaResend } from "./resend-mail";

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
