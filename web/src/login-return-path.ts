export const loginNextStorageKey = "reading-lite.loginNext";
export const ACCOUNT_SECURITY_PATH = "/account/security";
export const STEP_UP_LOGIN_HREF = `/login?step_up=1&next=${ACCOUNT_SECURITY_PATH}`;

/** Same-app `/readings/…` paths only — never a scheme, host, or protocol-relative URL. */
export function safeReadingReturnPath(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const candidate = raw.trim();
  if (!candidate.startsWith("/readings/")) return undefined;
  if (candidate.startsWith("//") || candidate.includes("://")) return undefined;
  if (/[?#\\@]/.test(candidate)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return undefined;
  }
  if (
    !decoded.startsWith("/readings/") ||
    decoded.startsWith("//") ||
    decoded.includes("://") ||
    decoded.includes("//") ||
    /[?#\\@]/.test(decoded)
  ) {
    return undefined;
  }
  return candidate;
}

/** Readings paths plus the Security page return used for recent-auth step-up. */
export function safeAppReturnPath(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const candidate = raw.trim();
  if (candidate === ACCOUNT_SECURITY_PATH) return candidate;
  return safeReadingReturnPath(raw);
}

export function rememberLoginReturnPath(raw: string | null | undefined): void {
  const safe = safeAppReturnPath(raw);
  if (safe !== undefined) localStorage.setItem(loginNextStorageKey, safe);
}

export function consumeLoginReturnPath(searchNext?: string | null): string {
  const fromQuery = safeAppReturnPath(searchNext);
  const fromStore = safeAppReturnPath(localStorage.getItem(loginNextStorageKey));
  localStorage.removeItem(loginNextStorageKey);
  return fromQuery ?? fromStore ?? "/";
}
