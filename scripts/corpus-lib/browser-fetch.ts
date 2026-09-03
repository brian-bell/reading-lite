// Wrap a `fetch` with browser-like default request headers so locally-run
// recovery fetches read as a real browser rather than blocked datacenter
// traffic. Each default is applied only when the caller hasn't already set
// that header: the Reddit OAuth path supplies its own `user-agent` (Reddit
// throttles generic browser UAs), `accept: application/json`, and a Bearer
// `authorization`, all of which must survive untouched.
// Also used by the extraction agent's headless tier: Playwright's own headless
// Chromium advertises `HeadlessChrome`, which is precisely what the origins this
// agent exists to recover from filter on. One UA string, no copies.
//
// Do not force redirect: "follow". extractFromUrl wraps this fetch with
// safeFetch, which requires redirect: "manual" on every hop. Clobbering that
// would skip per-hop DNS/IP/scheme revalidation.
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function makeBrowserFetch(baseFetch: typeof fetch): typeof fetch {
  return (input, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has("user-agent")) {
      headers.set("user-agent", BROWSER_USER_AGENT);
    }
    if (!headers.has("accept")) {
      headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    }
    if (!headers.has("accept-language")) {
      headers.set("accept-language", "en-US,en;q=0.9");
    }
    return baseFetch(input as RequestInfo, { ...init, headers });
  };
}
