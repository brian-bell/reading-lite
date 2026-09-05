const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Public origins production is served on. During the `readinglite.ai` /
 * `readinglite.app` dual-serve window the same Worker answers on the old host
 * and both public hosts, and a login started on any of them must mail its
 * magic link back to that host — see `publicWebBase`. Deliberately a code
 * constant rather than the operator-set `MCP_ALLOWED_ORIGINS`: widening which
 * browsers may call `/mcp` should not also widen where auth mail can point.
 * Matching is whole-origin, so `www.` and look-alike hosts fall back to
 * `WEB_BASE_URL`; apex is canonical and `www` is expected to be redirected to
 * it at the edge.
 *
 * Adding a host here asserts that this project serves it: a login arriving on
 * it will be mailed a single-use credential pointing back at it.
 */
export const PUBLIC_WEB_ORIGINS = [
  "https://reading-lite.bbell.dev",
  "https://readinglite.ai",
  "https://readinglite.app",
];

export function isPublicWebOrigin(origin: string | null | undefined): boolean {
  return !!origin && PUBLIC_WEB_ORIGINS.includes(origin);
}

export function originOfUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function isSameOriginRequest(input: {
  origin: string | undefined;
  url: string;
  webBaseUrl?: string;
}): boolean {
  if (!input.origin) return false;
  const requestOrigin = originOfUrl(input.url);
  if (requestOrigin && input.origin === requestOrigin) return true;

  if (input.webBaseUrl) {
    const webOrigin = originOfUrl(input.webBaseUrl);
    if (webOrigin && input.origin === webOrigin) return true;
  }

  // Vite proxies /api from :5173 to wrangler on :8787. Both ends are loopback,
  // so treat loopback-to-loopback as same-origin for local cookie endpoints.
  try {
    const originUrl = new URL(input.origin);
    const requestUrl = new URL(input.url);
    if (isLoopbackHost(originUrl.hostname) && isLoopbackHost(requestUrl.hostname)) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

const SAFE_COOKIE_METHODS = new Set(["GET", "HEAD"]);

/** Cookie origin gate: Origin required on writes. GET/HEAD may omit Origin when Sec-Fetch-Site is same-origin. CSRF HMAC is a separate check. */
export function cookieAuthAllowed(input: {
  method: string;
  origin: string | undefined;
  secFetchSite?: string | undefined;
  url: string;
  webBaseUrl?: string;
}): boolean {
  if (
    isSameOriginRequest({
      origin: input.origin,
      url: input.url,
      webBaseUrl: input.webBaseUrl,
    })
  ) {
    return true;
  }
  if (!SAFE_COOKIE_METHODS.has(input.method.toUpperCase())) return false;
  if (input.origin) return false;
  return (input.secFetchSite ?? "").trim().toLowerCase() === "same-origin";
}
