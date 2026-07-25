// Tier 2: render the page in a real browser, then run the *same* extractor the
// Worker uses over the rendered DOM. This is what recovers JS shells (no article
// in the static HTML) and pages whose content only appears after client-side
// hydration.
//
// The browser is behind an injected `renderPage` seam, so everything here — the
// SSRF decisions, the byte bound, the extraction verdict — is testable without
// Chromium. The real seam lives in render-playwright.ts.
//
// SSRF, in three layers, because the browser makes its own connections and
// cannot be routed through safeFetch:
//   1. the initial URL is checked (hostname rules AND resolved addresses)
//      *before* a browser is ever launched;
//   2. every request the page makes goes through a route filter that applies
//      the same two-part rule the initial URL got — URL shape
//      (`shouldAbortRequest`) *and* resolved addresses — before the browser is
//      allowed to connect. The DNS half is not optional here: page content is
//      the one fully attacker-controlled input in this system, and a script on
//      the page can request `alias.example` whose A record is 192.168.1.1. The
//      URL-shaped check alone would wave that through, and the final-URL check
//      happens far too late to matter for a subresource;
//   3. the final URL (after any redirect the browser followed on its own) is
//      re-checked before extraction, and a render that landed on a private host
//      has its HTML discarded rather than parsed.
// Two residual risks are accepted and documented rather than hidden, both
// bounded the same way — URLs reach this agent only via the authed API,
// self-submitted: rendering-time DNS rebinding (the same TOCTOU safe-fetch
// documents for tier 1), and a *redirect* into the LAN, which costs one
// credential-less GET before layer 3 discards the render — Playwright routes
// only the first URL of a redirect chain. See the route handler in
// render-playwright.ts for why re-issuing hops there would cost more than it
// buys, and what closing the class properly would take.

import { assertSafeUrl, readabilityFromHtml } from "../../src/modules/extractor";
import { mapExtractorError, type ExtractOutcome } from "./outcome";
import { assertSafeDestination, type LookupFn } from "./safe-fetch";

// Thrown by the renderer when *this box* cannot render at all: playwright is not
// installed, or its browser is missing/broken. It is deliberately not an
// ExtractOutcome — it says nothing about the row, and the orchestrator uses it
// to stop rendering for the rest of the run instead of paying a doomed launch
// per row.
export class HeadlessUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HeadlessUnavailableError";
  }
}

// Thrown by the renderer when the page's serialized DOM is over the cap. It is
// raised *inside* the browser boundary, before the document crosses into this
// process, which is the whole point: the byte check below can only protect the
// two DOM parses, never the transfer that feeds them.
export class RenderTooLargeError extends Error {
  constructor(url: string, bytes: number, maxBytes: number) {
    super(`rendered dom is ${bytes} bytes, over the ${maxBytes} byte cap: ${url}`);
    this.name = "RenderTooLargeError";
  }
}

export interface RenderResult {
  html: string;
  finalUrl: string;
}

// true = abort the request. Async because the verdict includes a DNS lookup;
// the renderer awaits it before letting the browser connect.
export type RouteFilter = (requestUrl: string) => Promise<boolean>;

export interface RenderPageOptions {
  routeFilter: RouteFilter;
  timeoutMs: number;
  maxBytes: number;
}

export type RenderPage = (url: string, opts: RenderPageOptions) => Promise<RenderResult>;

export interface HeadlessDeps {
  renderPage: RenderPage;
  lookup: LookupFn;
  maxBytes: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// The URL-shaped half of the route decision: one predicate over
// `assertSafeUrl`'s exported rules, so a subresource cannot reach anything the
// initial-URL check would have refused on shape alone. Reusing the assertion
// (rather than re-deriving its rules) is what guarantees the two can never
// drift; failing closed on anything unparseable is the safe direction.
export function shouldAbortRequest(requestUrl: string): boolean {
  try {
    assertSafeUrl(requestUrl);
    return false;
  } catch {
    return true;
  }
}

// The full route decision: URL shape, then resolved addresses. Verdicts are
// memoized per hostname for the life of one render — a page pulls dozens of
// requests from the same few hosts, and re-resolving each one would add a DNS
// round trip to every image. The memo deliberately does not outlive the render:
// a long unattended run must not act on an hour-old answer.
export function makeRouteFilter(lookup: LookupFn, signal?: AbortSignal): RouteFilter {
  const verdicts = new Map<string, Promise<boolean>>();
  return async (requestUrl) => {
    if (shouldAbortRequest(requestUrl)) return true;
    // shouldAbortRequest already parsed it, so this cannot throw.
    const host = new URL(requestUrl).hostname.toLowerCase();
    let verdict = verdicts.get(host);
    if (!verdict) {
      verdict = blocksDestination(requestUrl, lookup, signal);
      verdicts.set(host, verdict);
    }
    return verdict;
  };
}

// Fail closed: an unresolvable host is a request the browser could not have
// completed anyway, and a lookup that errors — or one the render deadline cut
// short — tells us nothing reassuring.
async function blocksDestination(url: string, lookup: LookupFn, signal?: AbortSignal): Promise<boolean> {
  try {
    await assertSafeDestination(url, lookup, signal);
    return false;
  } catch {
    return true;
  }
}

export async function extractHeadless(url: string, deps: HeadlessDeps): Promise<ExtractOutcome> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Bound the initial lookup and every routed request during rendering.
  // LookupFn takes no signal of its own (node's dns.promises.lookup has none),
  // so a hostname whose authoritative server never answers would otherwise
  // outlive the render timeout and wedge a run that works one row at a time.
  const renderDeadline = AbortSignal.timeout(timeoutMs);
  try {
    await assertSafeDestination(url, deps.lookup, renderDeadline);
  } catch (e) {
    return mapExtractorError(e);
  }

  let rendered: RenderResult;
  try {
    rendered = await deps.renderPage(url, {
      routeFilter: makeRouteFilter(deps.lookup, renderDeadline),
      timeoutMs,
      maxBytes: deps.maxBytes,
    });
  } catch (e) {
    // A box that cannot render is not this row's problem — let it out.
    if (e instanceof HeadlessUnavailableError) throw e;
    if (e instanceof RenderTooLargeError) return { kind: "error", code: "OversizedRenderError", detail: e.message };
    return mapExtractorError(e);
  }

  // Safety before anything else touches the bytes: a render that ended up on a
  // private host is discarded whole, never parsed for "just the text". This
  // lookup gets a fresh deadline because a successful render may consume the
  // original window while settling.
  try {
    await assertSafeDestination(rendered.finalUrl, deps.lookup, AbortSignal.timeout(timeoutMs));
  } catch (e) {
    return mapExtractorError(e);
  }

  // The static tier bounds its bytes as it streams them; a rendered DOM arrives
  // as one string. The renderer already refused an over-cap DOM before it
  // crossed into this process (RenderTooLargeError); this is the exact byte
  // check behind that character-count pre-filter, and it also covers a renderer
  // seam that does no pre-filtering of its own.
  const bytes = Buffer.byteLength(rendered.html, "utf-8");
  if (bytes > deps.maxBytes) {
    return {
      kind: "error",
      code: "OversizedRenderError",
      detail: `rendered html is ${bytes} bytes, over the ${deps.maxBytes} byte cap: ${rendered.finalUrl}`,
    };
  }

  // Extract against the *final* URL so relative links resolve the way the
  // browser saw them, not the way the row's stored URL would have.
  const article = readabilityFromHtml(rendered.html, rendered.finalUrl);
  if (!article || article.markdown.trim().length === 0) {
    return { kind: "no_article", detail: `rendered dom produced no article: ${rendered.finalUrl}` };
  }
  return {
    kind: "extracted",
    markdown: article.markdown,
    title: article.title,
    salvaged: article.salvaged,
    tier: "headless",
  };
}
