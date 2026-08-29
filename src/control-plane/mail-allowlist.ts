import { canonicalizeEmail } from "./email";

function parseList(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        try {
          return canonicalizeEmail(part);
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  );
}

function founderCanonical(raw: string | undefined): string {
  try {
    return canonicalizeEmail(raw ?? "");
  } catch {
    return "";
  }
}

/** Staging: AUTH_MAIL_ALLOWLIST unset and no FOUNDER_EMAIL = no extra list. Empty string = allowlist-only. */
export function isAuthMailAllowed(
  env: { APP_ENV?: string; AUTH_MAIL_ALLOWLIST?: string; FOUNDER_EMAIL?: string },
  canonicalEmail: string,
): boolean {
  if (env.APP_ENV !== "staging") return true;
  const configured = env.AUTH_MAIL_ALLOWLIST;
  const allowed = parseList(configured ?? "");
  const founder = founderCanonical(env.FOUNDER_EMAIL);
  if (founder) allowed.add(founder);
  if (configured === undefined && allowed.size === 0) return true;
  return allowed.has(canonicalEmail);
}
