import { deriveHmacKey, hmacHex, timingSafeEqualHex, type AuthRoot } from "./crypto";

const CSRF_HEX = /^[0-9a-f]{64}$/;
const DUMMY_HMAC = "0".repeat(64);
const COOKIE_CSRF_METHODS = new Set(["POST", "DELETE"]);

/** Session-authenticated POST/DELETE require the CSRF HMAC header. Bearer is exempt. */
export function cookieCsrfRequired(method: string): boolean {
  return COOKIE_CSRF_METHODS.has(method.toUpperCase());
}

/** Domain-separated HMAC of the session id. Minted under the active auth root. */
export async function mintCsrfToken(authRoot: AuthRoot, sessionId: string): Promise<string> {
  return hmacHex(await deriveHmacKey(authRoot, "csrf"), sessionId);
}

export async function verifyCsrfToken(input: {
  token: string | undefined;
  sessionId: string;
  authRoot: AuthRoot;
  previousAuthRoot?: AuthRoot;
}): Promise<boolean> {
  const presented = (input.token ?? "").trim().toLowerCase();
  const active = await mintCsrfToken(input.authRoot, input.sessionId);
  const wellFormed = CSRF_HEX.test(presented);
  if (wellFormed && timingSafeEqualHex(presented, active)) return true;
  if (input.previousAuthRoot) {
    const previous = await mintCsrfToken(input.previousAuthRoot, input.sessionId);
    if (wellFormed && timingSafeEqualHex(presented, previous)) return true;
  } else if (!wellFormed) {
    timingSafeEqualHex(active, DUMMY_HMAC);
  }
  return false;
}
