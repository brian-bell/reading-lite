// The real renderer, driven against a fake playwright module. Chromium itself is
// out of scope here (it is the seam, and HV-2 covers it on the home box); what is
// in scope is everything around it: how the context is configured, what the
// route handler decides for each request, the pre-transfer size cap, and that a
// browser is always closed.

import { describe, expect, it, vi } from "vitest";
import {
  HeadlessUnavailableError,
  RenderTooLargeError,
  shouldAbortRequest,
} from "../../../scripts/extract-agent-lib/headless-tier";
import { makePlaywrightRenderPage, type PlaywrightLike } from "../../../scripts/extract-agent-lib/render-playwright";

interface FakeRequest {
  url: string;
  resourceType?: string;
  method?: string;
}

interface FakeState {
  closedBrowsers: number;
  launchArgs: string[];
  initScripts: string[];
  wsRoutePatterns: string[];
  wsClosed: string[];
  wsConnected: string[];
  closedContexts: number;
  contextOptions: Record<string, unknown> | undefined;
  routePatterns: string[];
  gotoCalls: Array<{ url: string; opts: unknown }>;
  aborted: string[];
  continued: string[];
  fulfilled: Array<{ url: string; body: string; contentType?: string; status?: number }>;
}

type Handler = (route: unknown) => unknown;

function fakePlaywright(opts: {
  html?: string;
  finalUrl?: string;
  urlAfterContent?: string;
  requests?: FakeRequest[];
  websockets?: string[];
  domBytes?: number;
  hangOnEvaluate?: boolean;
  hangOnNewContext?: boolean;
  gotoError?: Error;
  navigationStatus?: number;
  settledNavigationStatus?: number;
  settledNavigationUrl?: string;
  redirectNavigationStatus?: number;
  redirectNavigationUrl?: string;
  nonCommittingNavigationStatus?: number;
  nonCommittingNavigationUrl?: string;
  navigationDuringEvaluateStatus?: number;
  navigationDuringEvaluateUrl?: string;
  launchError?: Error;
} = {}): { module: PlaywrightLike; state: FakeState } {
  const state: FakeState = {
    closedBrowsers: 0,
    launchArgs: [],
    initScripts: [],
    wsRoutePatterns: [],
    wsClosed: [],
    wsConnected: [],
    closedContexts: 0,
    contextOptions: undefined,
    routePatterns: [],
    gotoCalls: [],
    aborted: [],
    continued: [],
    fulfilled: [],
  };
  let handler: Handler | undefined;
  let navigatedTo: string | undefined;
  let responseHandler: ((response: unknown) => void) | undefined;
  let frameNavigatedHandler: ((frame: unknown) => void) | undefined;
  const mainFrame = {};

  function navigationResponse(status: number, url: string) {
    return {
      status: () => status,
      url: () => url,
      frame: () => mainFrame,
      request: () => ({ isNavigationRequest: () => true }),
    };
  }

  // One request as the browser would present it: a Route whose fetch() answers
  // from the fixture's response table (200 unless the fixture says otherwise).
  function routeFor(request: FakeRequest) {
    return {
      request: () => ({
        url: () => request.url,
        resourceType: () => request.resourceType ?? "document",
        method: () => request.method ?? "GET",
      }),
      abort: async () => {
        state.aborted.push(request.url);
      },
      continue: async () => {
        state.continued.push(request.url);
      },
      fulfill: async (response: { body: string; contentType?: string; status?: number }) => {
        state.fulfilled.push({ url: request.url, ...response });
      },
    };
  }

  const page = {
    async goto(url: string, gotoOpts: unknown) {
      state.gotoCalls.push({ url, opts: gotoOpts });
      const requests: FakeRequest[] = opts.requests ?? [{ url }];
      for (const request of requests) await handler?.(routeFor(request));
      if (opts.gotoError) throw opts.gotoError;
      const response = navigationResponse(opts.navigationStatus ?? 200, url);
      responseHandler?.(response);
      frameNavigatedHandler?.(mainFrame);
      return response;
    },
    async waitForLoadState() {
      if (opts.redirectNavigationStatus !== undefined) {
        responseHandler?.(
          navigationResponse(
            opts.redirectNavigationStatus,
            opts.redirectNavigationUrl ?? "https://public.example/redirect",
          ),
        );
      }
      if (opts.settledNavigationStatus !== undefined) {
        const url = opts.settledNavigationUrl ?? "https://public.example/settled";
        navigatedTo = url;
        responseHandler?.(navigationResponse(opts.settledNavigationStatus, url));
        frameNavigatedHandler?.(mainFrame);
      }
      if (opts.nonCommittingNavigationStatus !== undefined) {
        responseHandler?.(
          navigationResponse(
            opts.nonCommittingNavigationStatus,
            opts.nonCommittingNavigationUrl ?? "https://public.example/no-content",
          ),
        );
      }
    },
    on(event: "response" | "framenavigated", handler_: (value: unknown) => void) {
      if (event === "response") responseHandler = handler_;
      if (event === "framenavigated") frameNavigatedHandler = handler_;
    },
    mainFrame() {
      return mainFrame;
    },
    async evaluate<T>(): Promise<T> {
      if (opts.hangOnEvaluate) return new Promise<T>(() => {});
      if (opts.navigationDuringEvaluateStatus !== undefined) {
        const url = opts.navigationDuringEvaluateUrl ?? "https://public.example/during-evaluate";
        navigatedTo = url;
        responseHandler?.(navigationResponse(opts.navigationDuringEvaluateStatus, url));
        frameNavigatedHandler?.(mainFrame);
      }
      return (opts.domBytes ?? (opts.html ?? "<html><body><p>hi</p></body></html>").length) as unknown as T;
    },
    async content() {
      if (opts.urlAfterContent) navigatedTo = opts.urlAfterContent;
      return opts.html ?? "<html><body><p>hi</p></body></html>";
    },
    url() {
      return navigatedTo ?? opts.finalUrl ?? "https://public.example/a";
    },
  };

  const context = {
    async addInitScript(script: string) {
      state.initScripts.push(script);
    },
    async route(pattern: string, fn: Handler) {
      state.routePatterns.push(pattern);
      handler = fn;
    },
    async routeWebSocket(pattern: string, fn: (ws: unknown) => unknown) {
      state.wsRoutePatterns.push(pattern);
      for (const url of opts.websockets ?? []) {
        await fn({
          url: () => url,
          close: () => {
            state.wsClosed.push(url);
          },
          connectToServer: () => {
            state.wsConnected.push(url);
          },
        });
      }
    },
    async newPage() {
      return page;
    },
    async close() {
      state.closedContexts += 1;
    },
  };

  const module_ = {
    chromium: {
      async launch(launchOptions: { args?: string[] }) {
        state.launchArgs = launchOptions.args ?? [];
        if (opts.launchError) throw opts.launchError;
        return {
          async newContext(contextOptions: Record<string, unknown>) {
            state.contextOptions = contextOptions;
            if (opts.hangOnNewContext) return new Promise<never>(() => {});
            return context;
          },
          async close() {
            state.closedBrowsers += 1;
          },
        };
      },
    },
  };

  return { module: module_ as unknown as PlaywrightLike, state };
}

// The production filter also resolves hostnames; this suite is about the
// renderer's plumbing, so it drives the sync URL-shape half directly.
const OPTS = {
  routeFilter: async (url: string) => shouldAbortRequest(url),
  timeoutMs: 5_000,
  maxBytes: 20 * 1024 * 1024,
};

const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];
const NAV: FakeRequest = { url: "https://public.example/a" };

describe("makePlaywrightRenderPage", () => {
  it("renders a page and reports its html and final url", async () => {
    const { module, state } = fakePlaywright({
      html: "<html><body><p>rendered</p></body></html>",
      finalUrl: "https://public.example/final",
    });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    const result = await render("https://public.example/a", OPTS);

    expect(result).toEqual({ html: "<html><body><p>rendered</p></body></html>", finalUrl: "https://public.example/final" });
    expect(state.gotoCalls[0]).toMatchObject({
      url: "https://public.example/a",
      opts: { waitUntil: "domcontentloaded", timeout: 5_000 },
    });
  });

  it("starts a validating proxy before Chromium and removes the implicit loopback bypass", async () => {
    const { module, state } = fakePlaywright();
    const close = vi.fn(async () => {});
    const startProxy = vi.fn(async () => ({
      url: "http://127.0.0.1:43123",
      close,
    }));
    const render = makePlaywrightRenderPage({
      load: async () => module,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      startProxy,
    });

    await render("https://public.example/a", OPTS);

    expect(startProxy).toHaveBeenCalledOnce();
    expect(state.launchArgs).toContain("--proxy-server=http://127.0.0.1:43123");
    expect(state.launchArgs).toContain("--proxy-bypass-list=<-loopback>");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the validating proxy when Chromium launch fails", async () => {
    const { module } = fakePlaywright({ launchError: new Error("browser launch failed") });
    const close = vi.fn(async () => {});
    const render = makePlaywrightRenderPage({
      load: async () => module,
      lookup: PUBLIC_LOOKUP,
      startProxy: async () => ({ url: "http://127.0.0.1:43123", close }),
    });

    await expect(render("https://public.example/a", OPTS)).rejects.toBeInstanceOf(HeadlessUnavailableError);
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not launch Chromium when the validating proxy cannot start", async () => {
    const { module, state } = fakePlaywright();
    const render = makePlaywrightRenderPage({
      load: async () => module,
      lookup: PUBLIC_LOOKUP,
      startProxy: async () => {
        throw new Error("listen EADDRNOTAVAIL");
      },
    });

    await expect(render("https://public.example/a", OPTS)).rejects.toThrow("validating proxy could not be started");
    expect(state.launchArgs).toEqual([]);
  });

  it("blocks service workers and routes at the context, not the page", async () => {
    // Playwright does not route service-worker requests and does not route a
    // popup's first request through page.route — both are egress this tier owns.
    const { module, state } = fakePlaywright();
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await render("https://public.example/a", OPTS);

    expect(state.contextOptions).toMatchObject({ serviceWorkers: "block" });
    expect(state.routePatterns).toEqual(["**/*"]);
  });

  it("shuts off transports neither route filter can see", async () => {
    // An RTCPeerConnection reaches LAN hosts over UDP, and WebTransport rides
    // HTTP/3 — neither produces a request context.route or routeWebSocket is
    // given a say in.
    const { module, state } = fakePlaywright();
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await render("https://public.example/a", OPTS);

    expect(state.launchArgs.join(" ")).toContain("webrtc-ip-handling-policy=disable_non_proxied_udp");
    expect(state.launchArgs.join(" ")).toContain("WebTransport");
    expect(state.initScripts.join("\n")).toContain("RTCPeerConnection");
    expect(state.initScripts.join("\n")).toContain("WebTransport");
  });

  it("sends a real browser user-agent rather than playwright's headless one", async () => {
    const { module, state } = fakePlaywright();
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await render("https://public.example/a", OPTS);

    expect(state.contextOptions).toMatchObject({ userAgent: expect.stringContaining("Chrome/") });
    expect(JSON.stringify(state.contextOptions)).not.toContain("Headless");
  });

  it("aborts LAN and non-http(s) requests before they are issued", async () => {
    const { module, state } = fakePlaywright({
      requests: [
        NAV,
        { url: "https://cdn.example/app.js", resourceType: "script" },
        { url: "http://192.168.1.1/probe", resourceType: "xhr" },
        { url: "file:///etc/passwd", resourceType: "xhr" },
      ],
    });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await render("https://public.example/a", OPTS);

    expect(state.aborted).toEqual(["http://192.168.1.1/probe", "file:///etc/passwd"]);
    expect(state.continued).toEqual(["https://public.example/a", "https://cdn.example/app.js"]);
  });

  it("skips images, media, and fonts (a markdown extraction wants text)", async () => {
    const { module, state } = fakePlaywright({
      requests: [
        NAV,
        { url: "https://public.example/hero.jpg", resourceType: "image" },
        { url: "https://public.example/clip.mp4", resourceType: "media" },
        { url: "https://public.example/text.woff2", resourceType: "font" },
        { url: "https://public.example/app.css", resourceType: "stylesheet" },
      ],
    });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await render("https://public.example/a", OPTS);

    expect(state.aborted).toEqual([
      "https://public.example/hero.jpg",
      "https://public.example/clip.mp4",
      "https://public.example/text.woff2",
    ]);
    expect(state.continued).toEqual(["https://public.example/a", "https://public.example/app.css"]);
  });

  it("refuses a websocket into the LAN and allows a public one", async () => {
    // context.route() does not see WebSocket handshakes — Playwright has a
    // separate API — so a page could otherwise open ws://192.168.1.1/ unwatched.
    const { module, state } = fakePlaywright({
      websockets: ["wss://live.example/feed", "ws://192.168.1.1/", "ws://127.0.0.1:9000/"],
    });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await render("https://public.example/a", OPTS);

    expect(state.wsRoutePatterns).toEqual(["**/*"]);
    expect(state.wsConnected).toEqual(["wss://live.example/feed"]);
    expect(state.wsClosed).toEqual(["ws://192.168.1.1/", "ws://127.0.0.1:9000/"]);
  });

  it("aborts non-GET requests and WebSockets in read-only mode", async () => {
    const { module, state } = fakePlaywright({
      requests: [
        NAV,
        { url: "https://public.example/form", resourceType: "fetch", method: "POST" },
        { url: "https://api.example/item", resourceType: "xhr", method: "DELETE" },
      ],
      websockets: ["wss://live.example/mutations"],
    });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await render("https://public.example/a", { ...OPTS, readOnly: true });

    expect(state.continued).toEqual(["https://public.example/a"]);
    expect(state.aborted).toEqual([
      "https://public.example/form",
      "https://api.example/item",
    ]);
    expect(state.wsConnected).toEqual([]);
    expect(state.wsClosed).toEqual(["wss://live.example/mutations"]);
  });

  it("renders an offline fixture as the main document and blocks all egress", async () => {
    const offlineHtml = [
      "<html><body>",
      "<script>document.body.textContent = 'rendered';</script>",
      "</body></html>",
    ].join("");
    const { module, state } = fakePlaywright({
      html: "<html><body>rendered</body></html>",
      requests: [
        NAV,
        { url: "https://cdn.example/app.js", resourceType: "script" },
        { url: "https://api.example/data", resourceType: "fetch", method: "POST" },
      ],
      websockets: ["wss://live.example/socket"],
    });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    const result = await render("https://public.example/a", {
      ...OPTS,
      readOnly: true,
      offlineHtml,
    });

    expect(result).toEqual({
      html: "<html><body>rendered</body></html>",
      finalUrl: "https://public.example/a",
    });
    expect(state.fulfilled).toEqual([{
      url: "https://public.example/a",
      body: offlineHtml,
      contentType: "text/html; charset=utf-8",
      status: 200,
    }]);
    expect(state.continued).toEqual([]);
    expect(state.aborted).toEqual([
      "https://cdn.example/app.js",
      "https://api.example/data",
    ]);
    expect(state.wsConnected).toEqual([]);
    expect(state.wsClosed).toEqual(["wss://live.example/socket"]);
  });

  it("matches an offline main-document request after browser URL canonicalization", async () => {
    const offlineHtml = "<html><body>fixture</body></html>";
    const { module, state } = fakePlaywright({
      html: offlineHtml,
      finalUrl: "https://fixture.invalid/article#section",
      requests: [{
        url: "https://fixture.invalid/article",
        resourceType: "document",
      }],
    });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await render("https://Fixture.Invalid:443/article#section", {
      ...OPTS,
      offlineHtml,
    });

    expect(state.fulfilled).toEqual([expect.objectContaining({
      url: "https://fixture.invalid/article",
      body: offlineHtml,
    })]);
    expect(state.aborted).toEqual([]);
    expect(state.continued).toEqual([]);
  });

  it("refuses an over-cap dom before pulling it into this process", async () => {
    // page.content() materializes the whole document here, so the cap has to be
    // decided inside the page: a pathological dom must never cross the boundary.
    const { module, state } = fakePlaywright({ domBytes: 5_000 });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await expect(render("https://public.example/a", { ...OPTS, maxBytes: 1_000 })).rejects.toBeInstanceOf(
      RenderTooLargeError,
    );
    expect(state.closedBrowsers).toBe(1);
  });

  it("gives up on a page that never answers, and closes the browser under it", async () => {
    // page.evaluate and page.content have no timeout of their own and both run
    // code the document controls, so a hostile page could otherwise hang the
    // whole unattended run: lock held, no report written, dead-man ping silent.
    vi.useFakeTimers();
    try {
      const { module, state } = fakePlaywright({ hangOnEvaluate: true });
      const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

      const pending = render("https://public.example/a", { ...OPTS, timeoutMs: 5_000 });
      const assertion = expect(pending).rejects.toThrow(/budget/);
      await vi.advanceTimersByTimeAsync(5_000 + 3_000 + 10_000 + 1);
      await assertion;

      expect(state.closedContexts).toBe(1);
      expect(state.closedBrowsers).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up when creating a browser context hangs", async () => {
    // newContext is a Chromium round trip too. It must not sit outside the
    // renderer deadline and wedge the unattended run before navigation begins.
    vi.useFakeTimers();
    try {
      const { module, state } = fakePlaywright({ hangOnNewContext: true });
      const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

      const pending = render("https://public.example/a", { ...OPTS, timeoutMs: 5_000 });
      const assertion = expect(pending).rejects.toThrow(/budget/);
      await vi.advanceTimersByTimeAsync(5_000 + 3_000 + 10_000 + 1);
      await assertion;

      expect(state.closedBrowsers).toBe(1);
      expect(state.closedContexts).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [403, "bad response status 403"],
    [404, "bad response status 404"],
    [429, "rate limited by https://public.example/a (status 429"],
    [500, "bad response status 500"],
  ])("rejects a final HTTP %i response before reading its DOM", async (navigationStatus, message) => {
    const { module, state } = fakePlaywright({ navigationStatus });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await expect(render("https://public.example/a", OPTS)).rejects.toThrow(message);
    expect(state.closedContexts).toBe(1);
    expect(state.closedBrowsers).toBe(1);
  });

  it.each([
    {
      change: "fragment",
      navigationStatus: 429,
      finalUrl: "https://public.example/a#retry-later",
      message: "rate limited by https://public.example/a#retry-later (status 429",
    },
    {
      change: "path and query",
      navigationStatus: 403,
      finalUrl: "https://public.example/challenge?retry=1",
      message: "bad response status 403: https://public.example/challenge?retry=1",
    },
  ])("keeps an error response when the page only changes its history $change", async ({ navigationStatus, finalUrl, message }) => {
    // Response.url() is the network URL, while page.url() reflects same-document
    // hash/pushState/replaceState updates that load no new document. The
    // original HTTP response still describes the captured DOM, so a history
    // change must not make an error status look successful.
    const { module, state } = fakePlaywright({ navigationStatus, finalUrl });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await expect(render("https://public.example/a", OPTS)).rejects.toThrow(message);
    expect(state.closedContexts).toBe(1);
    expect(state.closedBrowsers).toBe(1);
  });

  it("rejects an error response reached by a client navigation while settling", async () => {
    const { module, state } = fakePlaywright({
      navigationStatus: 200,
      settledNavigationStatus: 404,
      settledNavigationUrl: "https://public.example/missing",
    });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await expect(render("https://public.example/a", OPTS)).rejects.toThrow(
      "bad response status 404: https://public.example/missing",
    );
    expect(state.closedContexts).toBe(1);
    expect(state.closedBrowsers).toBe(1);
  });

  it("keeps the captured document's error status after a non-committing navigation", async () => {
    // A 204 emits a main-frame response but leaves the current document and URL
    // in place. It must not replace the 403 status of the HTML we capture.
    const { module, state } = fakePlaywright({
      navigationStatus: 403,
      nonCommittingNavigationStatus: 204,
      nonCommittingNavigationUrl: "https://public.example/no-content",
    });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await expect(render("https://public.example/a", OPTS)).rejects.toThrow(
      "bad response status 403: https://public.example/a",
    );
    expect(state.closedContexts).toBe(1);
    expect(state.closedBrowsers).toBe(1);
  });

  it("keeps the captured document after a redirect ends in a non-committing response", async () => {
    // Neither the intermediate redirect nor the terminal 204 commits a new
    // document. The original successful article must remain extractable.
    const { module } = fakePlaywright({
      navigationStatus: 200,
      redirectNavigationStatus: 302,
      redirectNavigationUrl: "https://public.example/no-content",
      nonCommittingNavigationStatus: 204,
      nonCommittingNavigationUrl: "https://public.example/no-content",
    });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await expect(render("https://public.example/a", OPTS)).resolves.toEqual({
      html: "<html><body><p>hi</p></body></html>",
      finalUrl: "https://public.example/a",
    });
  });

  it("rejects an error response reached while measuring the eventual snapshot", async () => {
    const { module, state } = fakePlaywright({
      navigationStatus: 200,
      navigationDuringEvaluateStatus: 403,
      navigationDuringEvaluateUrl: "https://public.example/sign-in",
    });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await expect(render("https://public.example/a", OPTS)).rejects.toThrow(
      "bad response status 403: https://public.example/sign-in",
    );
    expect(state.closedContexts).toBe(1);
    expect(state.closedBrowsers).toBe(1);
  });

  it("discards a snapshot the page navigated out from under", async () => {
    // page.content() is a round trip; a navigation committing inside it would
    // otherwise pair the new document's HTML with the old document's URL, and
    // the caller would validate a public url while parsing a private page.
    const { module } = fakePlaywright({ urlAfterContent: "http://192.168.1.1/router" });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await expect(render("https://public.example/a", OPTS)).rejects.toThrow(/navigated/);
  });

  it("closes the context and browser even when navigation fails", async () => {
    const { module, state } = fakePlaywright({ gotoError: new Error("net::ERR_NAME_NOT_RESOLVED") });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await expect(render("https://public.example/a", OPTS)).rejects.toThrow("ERR_NAME_NOT_RESOLVED");
    expect(state.closedContexts).toBe(1);
    expect(state.closedBrowsers).toBe(1);
  });

  it("reports a missing playwright module as HeadlessUnavailableError", async () => {
    const render = makePlaywrightRenderPage({
      lookup: PUBLIC_LOOKUP,
      load: async () => {
        throw new Error("Cannot find module 'playwright'");
      },
    });

    await expect(render("https://public.example/a", OPTS)).rejects.toBeInstanceOf(HeadlessUnavailableError);
  });

  it("reports a browser that will not launch as HeadlessUnavailableError", async () => {
    // The home box after an OS update, or any machine where `npx playwright
    // install chromium` was never run.
    const { module } = fakePlaywright({ launchError: new Error("Executable doesn't exist at /ms-playwright/chromium") });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await expect(render("https://public.example/a", OPTS)).rejects.toBeInstanceOf(HeadlessUnavailableError);
  });

  it("does not turn a mid-render failure into HeadlessUnavailableError", async () => {
    // Only import/launch failures mean "this box cannot render". A page that
    // times out is a property of that row and must stay per-row.
    const { module } = fakePlaywright({ gotoError: new Error("Timeout 30000ms exceeded") });
    const render = makePlaywrightRenderPage({ load: async () => module, lookup: PUBLIC_LOOKUP });

    await expect(render("https://public.example/a", OPTS)).rejects.not.toBeInstanceOf(HeadlessUnavailableError);
  });
});
