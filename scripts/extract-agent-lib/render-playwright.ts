// The real `renderPage` seam: headless Chromium via Playwright.
//
// Playwright is a devDependency whose browsers are installed only on the home
// box, so the import stays lazy (nothing under src/ may reach this) and both
// failure modes of "this box cannot render" — module missing, browser missing or
// broken — surface as HeadlessUnavailableError so the orchestrator can stop
// rendering for the rest of the run. Everything after a successful launch is an
// ordinary per-row failure and stays one.
//
// A browser is launched per render and closed in `finally`. At the run's render
// cap that costs about a second each, and it buys a guarantee worth more than
// the second: no cookie, storage, or service-worker state carries from one
// origin to the next.
//
// Every browser connection is forced through a validating proxy bound to
// 127.0.0.1. The proxy applies the shared URL and resolved-address rules on each
// HTTP request, CONNECT tunnel, and WebSocket Upgrade, then dials the vetted IP
// directly. Redirects therefore receive a new decision at the network boundary,
// and DNS cannot change between validation and connection. Browser routes,
// service-worker blocking, and the direct-transport switches below remain cheap
// defense in depth rather than the security boundary.

import { BROWSER_USER_AGENT } from "../corpus-lib/browser-fetch";
import {
  HeadlessUnavailableError,
  RenderTooLargeError,
  type RenderPage,
  type RenderPageOptions,
  type RouteFilter,
} from "./headless-tier";
import { BadStatusError } from "../../src/modules/extractor";
import { RateLimitedError } from "../../src/modules/http-retry";
import { loadPlaywright } from "./playwright";
import {
  startValidatingProxy,
  type ValidatingProxyDeps,
  type ValidatingProxy,
} from "./validating-proxy";
import type { LookupFn } from "./safe-fetch";

// The slice of Playwright's surface this module uses, declared structurally so
// the fake in the unit test is a plain object, and narrowed to what we actually
// call. The one cast is at the load boundary below.
interface RouteLike {
  request(): { url(): string; resourceType(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}

interface PageLike {
  goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<{ status(): number } | null>;
  on(event: "response", handler: (response: NavigationResponseLike) => void): void;
  on(event: "framenavigated", handler: (frame: unknown) => void): void;
  mainFrame(): unknown;
  waitForLoadState(state: "networkidle", opts: { timeout: number }): Promise<void>;
  // A string expression, not a closure: this repo's tsconfig has no DOM lib
  // (it targets Workers), so `document` cannot be named in a typed callback.
  evaluate<T>(expression: string): Promise<T>;
  content(): Promise<string>;
  url(): string;
}

interface NavigationResponseLike {
  status(): number;
  url(): string;
  frame(): unknown;
  request(): { isNavigationRequest(): boolean };
}

interface WebSocketRouteLike {
  url(): string;
  close(): void;
  connectToServer(): unknown;
}

interface ContextLike {
  addInitScript(script: string): Promise<void>;
  route(pattern: string, handler: (route: RouteLike) => unknown): Promise<unknown>;
  routeWebSocket(pattern: string, handler: (ws: WebSocketRouteLike) => unknown): Promise<void>;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

interface BrowserLike {
  newContext(opts: {
    userAgent: string;
    locale: string;
    viewport: { width: number; height: number };
    serviceWorkers: "block";
  }): Promise<ContextLike>;
  close(): Promise<void>;
}

export interface PlaywrightLike {
  chromium: { launch(opts: { headless: boolean; args: string[] }): Promise<BrowserLike> };
}

// Most pages worth rendering never reach a genuinely idle network (analytics
// beacons, polling, video). Idle is best-effort settling on top of
// domcontentloaded, not a requirement.
const SETTLE_MS = 3_000;

// Headroom over the per-call timeouts, so the watchdog only fires when
// something outside them (page-controlled JS in evaluate/content) has hung.
const WATCHDOG_SLACK_MS = 10_000;

// A close that has not returned by now is not going to.
const CLOSE_TIMEOUT_MS = 5_000;

// Transports that reach the network without producing anything either router
// can see: WebRTC gathers ICE candidates over UDP against whatever hosts it is
// pointed at, and WebTransport rides HTTP/3 rather than a WebSocket handshake.
// Both spellings of the WebRTC policy switch are passed because Chromium
// renamed it; unknown switches and features are ignored.
const CHROMIUM_ARGS = [
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-features=WebTransport,WebTransportHttp3",
];

// Belt to those braces: remove the constructors before any page script runs, in
// every frame and worker the init script reaches. Deleted rather than trapped,
// so ordinary feature detection sees "unsupported" and takes its fallback
// instead of throwing mid-render.
const DISABLE_DIRECT_TRANSPORTS = `for (const key of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "WebTransport"]) {
  try { delete globalThis[key]; } catch { /* non-configurable; the launch switches still apply */ }
}`;

// Images, video, and webfonts contribute nothing to a markdown extraction.
const SKIPPED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

export interface RenderDeps {
  lookup: LookupFn;
  load?: () => Promise<PlaywrightLike>;
  startProxy?: (deps: ValidatingProxyDeps) => Promise<ValidatingProxy>;
}

export function makePlaywrightRenderPage(deps: RenderDeps): RenderPage {
  const load = deps.load ?? (async () => (await loadPlaywright()) as unknown as PlaywrightLike);
  const startProxy = deps.startProxy ?? startValidatingProxy;

  return async (url, { routeFilter, timeoutMs, maxBytes }) => {
    let playwright: PlaywrightLike;
    try {
      playwright = await load();
    } catch (e) {
      throw new HeadlessUnavailableError(
        `playwright could not be loaded (npm install, then npx playwright install chromium): ${message(e)}`,
        { cause: e },
      );
    }

    let proxy: ValidatingProxy;
    try {
      proxy = await startProxy({
        lookup: deps.lookup,
        signal: AbortSignal.timeout(timeoutMs + SETTLE_MS + WATCHDOG_SLACK_MS),
      });
    } catch (e) {
      throw new HeadlessUnavailableError(
        `validating proxy could not be started: ${message(e)}`,
        { cause: e },
      );
    }

    try {
      let browser: BrowserLike;
      try {
        browser = await playwright.chromium.launch({
          headless: true,
          args: [
            ...CHROMIUM_ARGS,
            `--proxy-server=${proxy.url}`,
            "--proxy-bypass-list=<-loopback>",
          ],
        });
      } catch (e) {
        throw new HeadlessUnavailableError(
          `chromium could not be launched (try npx playwright install chromium): ${message(e)}`,
          { cause: e },
        );
      }

      let context: ContextLike | undefined;
      try {
        // Context creation talks to Chromium too. It is therefore inside the
        // same deadline as navigation and DOM serialization.
        try {
          return await withWatchdog(
            (async () => {
              const createdContext = await browser.newContext({
                userAgent: BROWSER_USER_AGENT,
                locale: "en-US",
                viewport: { width: 1280, height: 1024 },
                serviceWorkers: "block",
              });
              context = createdContext;
              return render(createdContext, url, { routeFilter, timeoutMs, maxBytes });
            })(),
            timeoutMs + SETTLE_MS + WATCHDOG_SLACK_MS,
            url,
          );
        } finally {
          const contextToClose = context;
          if (contextToClose) await closeQuietly(() => contextToClose.close());
        }
      } finally {
        await closeQuietly(() => browser.close());
      }
    } finally {
      await closeQuietly(() => proxy.close());
    }
  };
}

async function render(
  context: ContextLike,
  url: string,
  { routeFilter, timeoutMs, maxBytes }: RenderPageOptions,
): Promise<{ html: string; finalUrl: string }> {
  await context.addInitScript(DISABLE_DIRECT_TRANSPORTS);
  // Context-level, not page-level: page.route misses a popup's first request
  // (per Playwright's docs), and a popup is a page whose requests we never
  // inspect but whose egress is still ours.
  await context.route("**/*", (route) => handleRoute(route, routeFilter));
  // WebSocket handshakes are not covered by context.route() — Playwright has a
  // separate API for them — so a page could otherwise open `ws://192.168.1.1/`
  // with nothing watching. Same filter, same verdict: a route that never calls
  // connectToServer never connects.
  await context.routeWebSocket("**/*", async (ws) => {
    if (await routeFilter(wsToHttpUrl(ws.url()))) ws.close();
    else ws.connectToServer();
  });
  const page = await context.newPage();
  // `goto()` only returns its own navigation response. A JS or meta-refresh
  // can replace that 200 document while we are settling, so retain the response
  // that actually commits the main frame. Response receipt alone is not enough:
  // a redirect followed by 204/205 emits responses but leaves the prior DOM.
  let pendingNavigationResponse: NavigationResponseLike | undefined;
  let committedNavigationResponse: NavigationResponseLike | undefined;
  page.on("response", (response) => {
    if (response.frame() === page.mainFrame() && response.request().isNavigationRequest()) {
      pendingNavigationResponse =
        response.status() === 204 || response.status() === 205 ? undefined : response;
    }
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && pendingNavigationResponse) {
      committedNavigationResponse = pendingNavigationResponse;
      pendingNavigationResponse = undefined;
    }
  });
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  // Preserve goto's documented return as a fallback for a minimal Playwright
  // surface, or if its event ordering did not expose the initial commit.
  if (!committedNavigationResponse && response && response.status() !== 204 && response.status() !== 205) {
    committedNavigationResponse = {
      status: () => response.status(),
      url: () => page.url(),
      frame: () => page.mainFrame(),
      request: () => ({ isNavigationRequest: () => true }),
    };
  }
  await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => {});
  // Measure the serialized DOM inside the page before pulling it across:
  // `page.content()` materializes the whole thing in this process, so an
  // enormous DOM would otherwise be transferred in full before any cap could
  // fire. UTF-8 bytes, the same unit as the cap — a character count would let a
  // non-ASCII document through at up to three times the limit.
  //
  // Best-effort by construction, and worth being precise about why: this
  // expression runs in the page's own main world, so a hostile document can
  // shadow TextEncoder and report zero. Every in-page measurement is spoofable
  // that way (a trusted one needs a CDP isolated world), so this is a filter for
  // the ordinary oversized page, not a security boundary. A page that lies costs
  // one oversized transfer, and the watchdog above is what keeps a page that
  // simply never answers from costing the run.
  const bytes = await page.evaluate<number>(
    "new TextEncoder().encode((document.doctype ? new XMLSerializer().serializeToString(document.doctype) : \"\") + (document.documentElement ? document.documentElement.outerHTML : \"\")).length",
  );
  if (bytes > maxBytes) {
    throw new RenderTooLargeError(url, bytes, maxBytes);
  }
  // Bind the URL to the snapshot. `page.content()` is a round trip, and a
  // navigation can commit inside it — a public page redirecting to a private
  // host is exactly the case the caller's final-URL check exists to catch, and
  // a URL read on either side of the serialization alone can describe the wrong
  // document. Observing it before and after and requiring agreement is what
  // makes "this HTML came from this URL" true; a disagreement is a render to
  // discard, not to reconcile.
  const before = page.url();
  const html = await page.content();
  const finalUrl = page.url();
  if (finalUrl !== before) {
    throw new Error(`page navigated while its content was being read (${before} → ${finalUrl})`);
  }
  // Classify only after the snapshot is bound. History API changes can update
  // page.url() without committing a document, while a response chain ending in
  // 204/205 may never commit at all.
  //
  // `null` is Playwright's documented result for non-HTTP navigations; those
  // have no HTTP status to classify and are still covered by the URL safety
  // checks around this renderer.
  if (committedNavigationResponse) {
    const status = committedNavigationResponse.status();
    if (status < 200 || status >= 300) {
      // Keep the static tier's challenge vocabulary: it converts an HTTP 429
      // to RateLimitedError before the generic BadStatusError path.
      if (status === 429) throw new RateLimitedError(status, null, finalUrl);
      throw new BadStatusError(finalUrl, status);
    }
  }
  return { html, finalUrl };
}

// The loser of the race is abandoned, not awaited — that is the point — so its
// eventual rejection (the browser closing under it) is swallowed rather than
// left to surface as an unhandled rejection and kill the process.
async function withWatchdog<T>(work: Promise<T>, budgetMs: number, url: string): Promise<T> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`render exceeded its ${budgetMs}ms budget: ${url}`)), budgetMs);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

// Cleanup must not be able to re-create the hang it is cleaning up after: a
// wedged renderer can make close() itself wait. Node kills the browser process
// when it exits anyway, so a close that misses its window is worth abandoning.
async function closeQuietly(close: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
  });
  try {
    await Promise.race([close().catch(() => {}), gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}

// Cheap first-layer request handling: reject a URL whose shape is already known
// unsafe, then skip resource types that do not contribute to markdown. The
// validating proxy is the complete network boundary: it sees redirect hops and
// resolved addresses even when Playwright does not invoke this handler.
async function handleRoute(route: RouteLike, routeFilter: RouteFilter): Promise<void> {
  try {
    const request = route.request();
    if (await routeFilter(request.url())) return await route.abort();
    if (SKIPPED_RESOURCE_TYPES.has(request.resourceType())) return await route.abort();
    return await route.continue();
  } catch {
    // A route can already be resolved (page closed, request cancelled); an
    // unhandled rejection here would take down an otherwise healthy run.
    try {
      await route.abort();
    } catch {
      /* request is gone; nothing left to answer */
    }
  }
}

// The route filter speaks http(s); a ws:// URL carries the same host rules, so
// map the scheme across rather than teaching the filter a second vocabulary.
function wsToHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
