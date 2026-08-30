export const loginNextStorageKey = "reading-lite.loginNext";

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

export function rememberLoginReturnPath(raw: string | null | undefined): void {
  const safe = safeReadingReturnPath(raw);
  if (safe !== undefined) localStorage.setItem(loginNextStorageKey, safe);
}

export function consumeLoginReturnPath(searchNext?: string | null): string {
  const fromQuery = safeReadingReturnPath(searchNext);
  const fromStore = safeReadingReturnPath(localStorage.getItem(loginNextStorageKey));
  localStorage.removeItem(loginNextStorageKey);
  return fromQuery ?? fromStore ?? "/";
}
