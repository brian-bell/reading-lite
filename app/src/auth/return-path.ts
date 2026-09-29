// Where sign-in returns to (acceptance matrix, Return paths). A return path is
// a same-origin path on an allowlist, with only that path's own parameters;
// anything else is refused, and unknown parameters and fragments are dropped.
//
// The path is remembered in localStorage when a link is requested, because the
// emailed link opens in a new tab and never carries `next`. It is cleared when
// a later request has no safe path and whenever it is consumed. The legacy SPA
// remembered it whenever /login rendered, so a transient signed-out render
// after redemption stored it again (#369).

export const LOGIN_NEXT_STORAGE_KEY = "reading-lite.loginNext";
export const ACCOUNT_SECURITY_PATH = "/account/security";
export const ACCOUNT_PROVIDER_PATH = "/account/provider";

/** The step-up sign-in (email locked) that returns to `path` once the new link is opened. */
export function stepUpLoginHref(path: typeof ACCOUNT_SECURITY_PATH | typeof ACCOUNT_PROVIDER_PATH): string {
  return `/login?step_up=1&next=${encodeURIComponent(path)}`;
}
export const STEP_UP_LOGIN_HREF = stepUpLoginHref(ACCOUNT_SECURITY_PATH);

const READING_PATH = /^\/readings\/[A-Za-z0-9_-]+$/;

// Candidates are parsed against a fixed origin: only a root-relative path
// resolves to it, so any host, scheme, or protocol-relative form is refused
// the same way on the server and in the browser.
const BASE = "https://return-path.invalid";

function allowedParams(pathname: string): readonly string[] | undefined {
  if (pathname === "/") return ["q", "tag", "offset"];
  if (READING_PATH.test(pathname)) return ["view"];
  if (pathname === "/save" || pathname === ACCOUNT_SECURITY_PATH || pathname === ACCOUNT_PROVIDER_PATH) return [];
  return undefined;
}

export function safeReturnPath(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const candidate = raw.trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) return undefined;
  let url: URL;
  try {
    url = new URL(candidate, BASE);
  } catch {
    return undefined;
  }
  if (url.origin !== BASE) return undefined;
  const allowed = allowedParams(url.pathname);
  if (!allowed) return undefined;
  const kept = new URLSearchParams();
  for (const name of allowed) {
    const value = url.searchParams.get(name);
    if (value) kept.set(name, value);
  }
  const search = kept.toString();
  return search === "" ? url.pathname : `${url.pathname}?${search}`;
}

/** Sign-in link that returns to `current` when it is a path sign-in can return to. */
export function loginHref(current: string): string {
  const next = safeReturnPath(current);
  return next === undefined || next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}

// Storage can be unavailable (private modes, blocked site data). Sign-in still
// works; only the new-tab return falls back to the library.
function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** On a link request: remember a safe path, or forget any earlier one. */
export function rememberReturnPath(raw: string | null | undefined): void {
  const safe = safeReturnPath(raw);
  try {
    if (safe === undefined) storage()?.removeItem(LOGIN_NEXT_STORAGE_KEY);
    else storage()?.setItem(LOGIN_NEXT_STORAGE_KEY, safe);
  } catch {
    // See storage().
  }
}

export function clearReturnPath(): void {
  try {
    storage()?.removeItem(LOGIN_NEXT_STORAGE_KEY);
  } catch {
    // See storage().
  }
}

/** After sign-in: the query path, else the stored one, else the library. Always clears storage. */
export function consumeReturnPath(queryNext?: string | null): string {
  let stored: string | null = null;
  try {
    stored = storage()?.getItem(LOGIN_NEXT_STORAGE_KEY) ?? null;
  } catch {
    // See storage().
  }
  clearReturnPath();
  return safeReturnPath(queryNext) ?? safeReturnPath(stored) ?? "/";
}
