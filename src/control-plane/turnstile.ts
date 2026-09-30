import { isCloudAuthEnv } from "./auth-rate-guard";

/**
 * Cloudflare Turnstile siteverify for open-mode magic-link challenges.
 *
 * Local (and tests) skip verification when `TURNSTILE_SECRET_KEY` is unset
 * (fail-open). Staging/production fail-closed: missing secret, siteverify
 * errors, or `success !== true` are a rejection. The challenge handler still
 * returns generic `{ok:true}` and skips send — never provision an unknown
 * open-mode user without a successful verify when the secret is present or
 * the env is cloud.
 *
 * invite_only / closed never call this. Extra tokens on those modes are ignored.
 */

export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare dummy keys for tests. Never valid on a production widget. */
export const TURNSTILE_TEST_SITE_KEY_PASS = "1x00000000000000000000AA";
export const TURNSTILE_TEST_SECRET_PASS = "1x0000000000000000000000000000000AA";
export const TURNSTILE_TEST_SECRET_FAIL = "2x0000000000000000000000000000000AA";

const SITEVERIFY_TIMEOUT_MS = 10_000;

export function turnstileSiteKey(env: { TURNSTILE_SITE_KEY?: string }): string | null {
  const key = env.TURNSTILE_SITE_KEY?.trim();
  return key ? key : null;
}

export function turnstileSecretKey(env: { TURNSTILE_SECRET_KEY?: string }): string | null {
  const key = env.TURNSTILE_SECRET_KEY?.trim();
  return key ? key : null;
}

/**
 * Returns true when the challenge may proceed to send.
 * False means skip send (caller still returns `{ok:true}`).
 */
export async function verifyTurnstileToken(args: {
  env: { APP_ENV?: string; TURNSTILE_SECRET_KEY?: string };
  token: string | undefined;
  fetchImpl?: typeof fetch;
  remoteIp?: string | null;
}): Promise<boolean> {
  const secret = turnstileSecretKey(args.env);
  if (!secret) {
    // Local skip/fail-open when unset. Staging/production fail-closed.
    return !isCloudAuthEnv(args.env);
  }

  const token = args.token?.trim();
  if (!token) return false;

  try {
    const fetchImpl = args.fetchImpl ?? fetch;
    const body = new URLSearchParams({ secret, response: token });
    const remoteIp = args.remoteIp?.trim();
    if (remoteIp) body.set("remoteip", remoteIp);

    const res = await fetchImpl(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const json: unknown = await res.json();
    return (
      typeof json === "object" &&
      json !== null &&
      "success" in json &&
      (json as { success: unknown }).success === true
    );
  } catch {
    return false;
  }
}
