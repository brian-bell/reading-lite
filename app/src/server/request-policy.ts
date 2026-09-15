// Request rules from ADR 0003 (Routing, Rendering and caching).
//
// The backend Worker owns /api/*, /health, and /mcp* through more specific
// routes. The frontend never renders or proxies those paths: if a misconfigured
// route delivers one here, it answers 404 so the fault is visible.
//
// Every response this Worker renders is private and uncacheable, and carries
// the content-security policy the Source view needs (design spec, Source
// content). Hashed static assets never reach this code; Workers Assets serves
// them with the headers in public/_headers.

export const HTML_CACHE_CONTROL = "private, no-store";

/**
 * Images: the page's own, remote `https:` ones a reader chose to load in the
 * Source view, and the `data:` SVG behind the theme's grain token
 * (styles/tokens.css) — and nothing broader. Only `img-src` is set: a full
 * policy needs script nonces through the router's SSR options and Turnstile's
 * frame and script origins, which is its own change.
 */
export const CONTENT_SECURITY_POLICY = "img-src 'self' https: data:";

export function isBackendPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/health" ||
    // Mirrors the backend's `host/mcp*` route pattern, a plain prefix match.
    pathname.startsWith("/mcp")
  );
}

export function backendPathResponse(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function withResponsePolicy(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", HTML_CACHE_CONTROL);
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
