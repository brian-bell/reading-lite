import { describe, expect, it, vi } from "vitest";
import {
  extractHeadless,
  HeadlessUnavailableError,
  makeRouteFilter,
  shouldAbortRequest,
  type HeadlessDeps,
  type RenderPage,
} from "../../../scripts/extract-agent-lib/headless-tier";
import type { LookupFn } from "../../../scripts/extract-agent-lib/safe-fetch";

const PUBLIC_ADDRESS = "93.184.216.34";

// The tier resolves hostnames itself (a public name whose A record is 10.0.0.5
// passes every URL-shaped check), so the fake lookup is keyed by hostname.
function lookupOf(byHost: Record<string, string> = {}): LookupFn {
  return async (hostname) => [{ address: byHost[hostname] ?? PUBLIC_ADDRESS }];
}

const ARTICLE_HTML = `<!doctype html><html><head><title>How Queues Drain</title></head><body>
<article><h1>How Queues Drain</h1>
${Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i}: a queue consumer drains messages in waves, and producer pacing keeps the in-flight backlog bounded so retries do not dead-letter under upstream rate limits.</p>`).join("\n")}
</article></body></html>`;

// Content with no <body> wrapper: Readability crashes and the raw-DOM salvage
// recovers it (issue #18). Rendered JS shells hit this shape too.
const CRASH_HTML = `<div id="content"><article><h1>Reference</h1>${"<p>property value property value property value property value</p>".repeat(8)}</article></div><script>var x=1;</script>`;

function renderer(result: { html: string; finalUrl?: string }, url = "https://public.example/a"): RenderPage {
  return vi.fn(async () => ({ html: result.html, finalUrl: result.finalUrl ?? url }));
}

function deps(overrides: Partial<HeadlessDeps> = {}): HeadlessDeps {
  return {
    renderPage: renderer({ html: ARTICLE_HTML }),
    lookup: lookupOf(),
    maxBytes: 20 * 1024 * 1024,
    ...overrides,
  };
}

describe("shouldAbortRequest", () => {
  it("lets public http(s) subresources through", () => {
    for (const url of ["https://cdn.example.com/app.js", "http://example.com/a", "https://1.1.1.1/x"]) {
      expect(shouldAbortRequest(url)).toBe(false);
    }
  });

  it("aborts private, loopback, link-local, CGNAT, and .local subresources", () => {
    for (const url of [
      "http://192.168.1.10/x",
      "http://10.0.0.5/",
      "http://127.0.0.1/x",
      "http://[::1]/x",
      "http://172.16.0.9/x",
      "http://100.64.0.1/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://box.local/x",
      "http://localhost:8787/x",
    ]) {
      expect(shouldAbortRequest(url), url).toBe(true);
    }
  });

  it("aborts non-http(s) schemes", () => {
    for (const url of ["file:///etc/passwd", "data:text/html,<p>x</p>", "blob:https://x.example/y", "ws://x.example/y"]) {
      expect(shouldAbortRequest(url), url).toBe(true);
    }
  });

  it("fails closed on anything it cannot parse", () => {
    expect(shouldAbortRequest("not a url")).toBe(true);
    expect(shouldAbortRequest("")).toBe(true);
  });
});

describe("makeRouteFilter", () => {
  it("aborts a request whose hostname resolves into the LAN", async () => {
    // The one fully attacker-controlled input in this system is page content: a
    // script on the rendered page can request a public hostname that resolves to
    // a router or metadata service. URL shape alone waves that through, and the
    // final-URL check comes far too late for a subresource.
    const filter = makeRouteFilter(lookupOf({ "alias.example": "192.168.1.1" }));

    expect(await filter("https://alias.example/probe")).toBe(true);
    expect(await filter("https://cdn.example/app.js")).toBe(false);
  });

  it("aborts on URL shape without paying for a lookup", async () => {
    const lookup = vi.fn();
    const filter = makeRouteFilter(lookup as unknown as LookupFn);

    expect(await filter("http://127.0.0.1/x")).toBe(true);
    expect(await filter("file:///etc/passwd")).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("fails closed when the lookup errors", async () => {
    const filter = makeRouteFilter(async () => {
      throw new Error("EAI_AGAIN");
    });

    expect(await filter("https://unresolvable.example/x")).toBe(true);
  });

  it("resolves each hostname once per render", async () => {
    // A page pulls dozens of requests from a handful of hosts; a DNS round trip
    // per image would make rendering slower than the fetch it replaces.
    const lookup = vi.fn(async () => [{ address: PUBLIC_ADDRESS }]);
    const filter = makeRouteFilter(lookup);

    await Promise.all([
      filter("https://cdn.example/a.js"),
      filter("https://cdn.example/b.css"),
      filter("https://cdn.example/c.png"),
    ]);

    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe("extractHeadless", () => {
  it("extracts a rendered article through the shared readability path", async () => {
    const outcome = await extractHeadless("https://public.example/a", deps());

    expect(outcome).toMatchObject({ kind: "extracted", tier: "headless", salvaged: false, title: "How Queues Drain" });
    if (outcome.kind !== "extracted") throw new Error("unreachable");
    expect(outcome.markdown).toContain("queue consumer drains messages");
  });

  it("reports a raw-DOM salvage of the rendered page as salvaged", async () => {
    const outcome = await extractHeadless("https://public.example/a", deps({ renderPage: renderer({ html: CRASH_HTML }) }));

    expect(outcome).toMatchObject({ kind: "extracted", tier: "headless", salvaged: true });
  });

  it("reports no_article when the rendered dom still has nothing to extract", async () => {
    const shell = renderer({ html: "<html><body><script>boot()</script></body></html>" });
    const outcome = await extractHeadless("https://public.example/a", deps({ renderPage: shell }));

    expect(outcome.kind).toBe("no_article");
  });

  it("hands the renderer a working route filter, wired to its own lookup", async () => {
    const renderPage = vi.fn(async (_url: string, opts: { routeFilter: (u: string) => Promise<boolean> }) => {
      expect(await opts.routeFilter("http://10.0.0.1/x")).toBe(true);
      expect(await opts.routeFilter("https://alias.example/x")).toBe(true);
      expect(await opts.routeFilter("https://cdn.example/app.js")).toBe(false);
      return { html: ARTICLE_HTML, finalUrl: "https://public.example/a" };
    });

    await extractHeadless("https://public.example/a", deps({
      renderPage: renderPage as unknown as RenderPage,
      lookup: lookupOf({ "alias.example": "10.0.0.5" }),
    }));

    expect(renderPage).toHaveBeenCalledTimes(1);
  });

  it("refuses a private initial URL without rendering", async () => {
    const renderPage = vi.fn();
    const lookup = vi.fn();

    const outcome = await extractHeadless("http://192.168.1.1/admin", deps({
      renderPage: renderPage as unknown as RenderPage,
      lookup: lookup as unknown as LookupFn,
    }));

    expect(outcome).toMatchObject({ kind: "error", code: "BlockedHostError" });
    expect(renderPage).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses an initial URL whose hostname resolves into the LAN", async () => {
    // The URL-shaped checks cannot see this: rebind.example is a perfectly
    // public name whose A record points at the home network the agent runs in.
    const renderPage = vi.fn();
    const outcome = await extractHeadless("https://rebind.example/a", deps({
      renderPage: renderPage as unknown as RenderPage,
      lookup: lookupOf({ "rebind.example": "10.0.0.5" }),
    }));

    expect(outcome).toMatchObject({ kind: "error", code: "BlockedHostError" });
    expect(renderPage).not.toHaveBeenCalled();
  });

  it("discards a render that landed on a private final URL", async () => {
    const outcome = await extractHeadless("https://public.example/a", deps({
      renderPage: renderer({ html: ARTICLE_HTML, finalUrl: "http://192.168.0.5/router" }),
    }));

    expect(outcome).toMatchObject({ kind: "error", code: "BlockedHostError" });
    expect(outcome).not.toHaveProperty("markdown");
  });

  it("discards a render whose final hostname resolves into the LAN", async () => {
    const outcome = await extractHeadless("https://public.example/a", deps({
      renderPage: renderer({ html: ARTICLE_HTML, finalUrl: "https://rebind.example/a" }),
      lookup: lookupOf({ "rebind.example": "192.168.1.1" }),
    }));

    expect(outcome).toMatchObject({ kind: "error", code: "BlockedHostError" });
  });

  it("rejects rendered html over the byte cap without extracting it", async () => {
    const outcome = await extractHeadless("https://public.example/a", deps({
      renderPage: renderer({ html: ARTICLE_HTML }),
      maxBytes: 100,
    }));

    expect(outcome).toMatchObject({ kind: "error", code: "OversizedRenderError" });
  });

  it("resolves relative links against the final URL, not the requested one", async () => {
    const html = `<!doctype html><html><head><title>T</title></head><body><main><article>
<h1>Article</h1>
<p>This is the first paragraph with sufficient length to be picked up by readability without trouble.</p>
<p>Second paragraph for length. <a href="other">relative link</a> appears here, please resolve me.</p>
</article></main></body></html>`;
    const outcome = await extractHeadless("https://public.example/a", deps({
      renderPage: renderer({ html, finalUrl: "https://redirected.example/path/page" }),
    }));

    if (outcome.kind !== "extracted") throw new Error("unreachable");
    expect(outcome.markdown).toContain("https://redirected.example/path/other");
  });

  it("gives up on a stalled resolver instead of wedging the run", async () => {
    // LookupFn carries no signal of its own, and this agent works one row at a
    // time: a hostname whose authoritative server never answers would otherwise
    // hold the whole unattended run open past the render timeout.
    const renderPage = vi.fn();
    const outcome = await extractHeadless("https://slow-dns.example/a", deps({
      renderPage: renderPage as unknown as RenderPage,
      lookup: () => new Promise(() => {}),
      timeoutMs: 20,
    }));

    expect(outcome.kind).toBe("error");
    expect(renderPage).not.toHaveBeenCalled();
  });

  it("validates the final URL with a fresh deadline after rendering uses the original one", async () => {
    const lookup: LookupFn = async (hostname) => {
      if (hostname === "slow.example") return new Promise(() => {});
      return [{ address: PUBLIC_ADDRESS }];
    };
    const renderPage = vi.fn(async (
      _url: string,
      opts: { routeFilter: (url: string) => Promise<boolean> },
    ) => {
      // Consume the render deadline through the public route filter. The
      // completed render is still usable, and final URL validation must get its
      // own bounded lookup window rather than inherit this expired signal.
      expect(await opts.routeFilter("https://slow.example/app.js")).toBe(true);
      return { html: ARTICLE_HTML, finalUrl: "https://public.example/a" };
    });

    const outcome = await extractHeadless("https://public.example/a", deps({
      renderPage: renderPage as unknown as RenderPage,
      lookup,
      timeoutMs: 20,
    }));

    expect(outcome).toMatchObject({ kind: "extracted", tier: "headless" });
  });

  it("maps a render failure to an error outcome instead of throwing", async () => {
    const outcome = await extractHeadless("https://public.example/a", deps({
      renderPage: vi.fn(async () => {
        throw new Error("net::ERR_ABORTED");
      }),
    }));

    expect(outcome).toMatchObject({ kind: "error", detail: expect.stringContaining("ERR_ABORTED") });
  });

  it("rethrows HeadlessUnavailableError so the caller can stop rendering for the run", async () => {
    // A missing browser is not a property of this row: mapping it per row would
    // make every remaining row pay a doomed launch.
    await expect(
      extractHeadless("https://public.example/a", deps({
        renderPage: vi.fn(async () => {
          throw new HeadlessUnavailableError("chromium is not installed");
        }),
      })),
    ).rejects.toBeInstanceOf(HeadlessUnavailableError);
  });
});
