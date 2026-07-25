import { describe, expect, it, vi } from "vitest";
import { extractFromUrl, FetchTimeoutError, OversizedResponseError, BadStatusError, BlockedHostError, RedditManualImportError } from "../../../src/modules/extractor";
import { RateLimitedError } from "../../../src/modules/http-retry";
import { canonicalWatchUrl, oembedUrl, timedtextJson3Url } from "../../../src/modules/extractor/youtube";

function fakeFetch(
  responses: Record<string, { status?: number; headers?: Record<string, string>; body: BodyInit }>,
  onRequest?: (url: string, init?: RequestInit) => void,
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    onRequest?.(url, init);
    const res = responses[url];
    if (!res) throw new Error(`unexpected fetch: ${url}`);
    return new Response(res.body, { status: res.status ?? 200, headers: res.headers ?? {} });
  };
}

const HTML_ARTICLE = `<!doctype html>
<html><head><title>Hello World</title></head>
<body>
  <header><nav>nav</nav></header>
  <main>
    <article>
      <h1>Hello World</h1>
      <p>This is the first paragraph. It contains enough words to be picked up by readability as the main content body.</p>
      <p>This is a second paragraph with more substantial body text so that the article passes the readability threshold for length.</p>
    </article>
  </main>
  <footer>footer</footer>
</body></html>`;

describe("extractFromUrl", () => {
  it("extracts HTML to markdown via readability + turndown", async () => {
    const fetchFn = fakeFetch({
      "https://example.com/a": {
        headers: { "content-type": "text/html; charset=utf-8" },
        body: HTML_ARTICLE,
      },
    });
    const out = await extractFromUrl("https://example.com/a", {
      fetch: fetchFn,
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
    });
    expect(out.content_type).toMatch(/^text\/html/);
    expect(out.content_status).toBe("captured");
    expect(out.title).toBe("Hello World");
    // Readability returns the title separately and may strip a duplicate H1 from
    // the article body; assert on body text we know is preserved.
    expect(out.markdown).toContain("first paragraph");
    expect(out.markdown).toContain("second paragraph");
    expect(out.markdown).not.toContain("nav");
    expect(out.markdown).not.toContain("footer");
    expect(out.content_bytes).toBe(new TextEncoder().encode(HTML_ARTICLE).length);
    expect(out.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    // Which path produced the article. The Worker ignores it; the extraction
    // agent tiers on it (salvage-only static output is what earns a render).
    expect(out.salvaged).toBe(false);
  });

  // Minimal reduction of the docs.spring.io page from issue #18: content
  // followed by a <script>, with no <body> wrapper. linkedom parses this into a
  // document whose content is hoisted as a sibling of an (empty) body under
  // documentElement, which makes Readability._grabArticle walk the ancestor
  // chain past <html> to null and throw `TypeError: Cannot read properties of
  // null (reading 'tagName')`. We catch that and salvage the text by
  // turndown-ing the raw DOM, so the page is `captured` rather than discarded.
  const HTML_NO_BODY_CRASH = `<div id="content"><article><h1>Reference</h1>${"<p>property value property value property value property value</p>".repeat(8)}</article></div><script>var x=1;</script>`;

  it("salvages markdown via raw-DOM fallback when readability throws (issue #18)", async () => {
    const fetchFn = fakeFetch({
      "https://docs.example/no-body": {
        headers: { "content-type": "text/html; charset=utf-8" },
        body: HTML_NO_BODY_CRASH,
      },
    });
    const out = await extractFromUrl("https://docs.example/no-body", {
      fetch: fetchFn,
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
    });
    expect(out.content_status).toBe("captured");
    expect(out.markdown).toContain("Reference");
    expect(out.markdown).toContain("property value");
    // <script> is stripped, not dumped into the markdown as text.
    expect(out.markdown).not.toContain("var x=1");
    expect(out.salvaged).toBe(true);
  });

  it("keeps <head>/<title> text out of the salvaged markdown (title is metadata)", async () => {
    // When the fallback turndowns documentElement (empty-body case), the <head>
    // must be stripped so the page <title> doesn't leak into the content — it
    // belongs in the title field, and a title-only shell must not look captured.
    const fetchFn = fakeFetch({
      "https://docs.example/titled": {
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<head><title>Page Title Should Not Leak</title></head>${HTML_NO_BODY_CRASH}`,
      },
    });
    const out = await extractFromUrl("https://docs.example/titled", {
      fetch: fetchFn,
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
    });
    expect(out.content_status).toBe("captured");
    expect(out.title).toBe("Page Title Should Not Leak");
    expect(out.markdown).toContain("property value");
    expect(out.markdown).not.toContain("Page Title Should Not Leak");
  });

  // A page that crashes Readability but has no salvageable text (script-only)
  // must still degrade to raw_only — the fallback returns null on empty output.
  it("stays raw_only when readability throws and there is nothing to salvage", async () => {
    const fetchFn = fakeFetch({
      "https://docs.example/script-only": {
        headers: { "content-type": "text/html; charset=utf-8" },
        // No <body>; the only node is a script, so the salvage turndown is empty.
        body: `<div id="content"><article></article></div><script>var x=1;</script>`,
      },
    });
    const out = await extractFromUrl("https://docs.example/script-only", {
      fetch: fetchFn,
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
    });
    expect(out.content_status).toBe("raw_only");
    expect(out.markdown).toBeUndefined();
  });

  it("falls back to raw_only when readability finds no article", async () => {
    const fetchFn = fakeFetch({
      "https://example.com/sparse": {
        headers: { "content-type": "text/html" },
        body: "<html><body></body></html>",
      },
    });
    const out = await extractFromUrl("https://example.com/sparse", {
      fetch: fetchFn,
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
    });
    expect(out.content_status).toBe("raw_only");
    expect(out.markdown).toBeUndefined();
  });

  it("passes through PDF as raw_only", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // "%PDF-1.4\n"
    const fetchFn = fakeFetch({
      "https://example.com/p.pdf": {
        headers: { "content-type": "application/pdf" },
        body: pdfBytes,
      },
    });
    const out = await extractFromUrl("https://example.com/p.pdf", {
      fetch: fetchFn,
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
    });
    expect(out.content_type).toBe("application/pdf");
    expect(out.content_status).toBe("raw_only");
    expect(out.markdown).toBeUndefined();
    expect(out.content_bytes).toBe(pdfBytes.length);
  });

  it("treats text/plain as captured (markdown = raw text)", async () => {
    const fetchFn = fakeFetch({
      "https://example.com/r.txt": {
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "Just some plain text content.",
      },
    });
    const out = await extractFromUrl("https://example.com/r.txt", {
      fetch: fetchFn,
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
    });
    expect(out.content_status).toBe("captured");
    expect(out.markdown).toBe("Just some plain text content.");
    // `salvaged` describes the HTML article path only; a non-HTML capture has no
    // Readability verdict to report, so it stays absent rather than claiming false.
    expect(out.salvaged).toBeUndefined();
  });

  it("treats application/json as captured (markdown = pretty json)", async () => {
    const body = JSON.stringify({ a: 1 });
    const fetchFn = fakeFetch({
      "https://example.com/r.json": {
        headers: { "content-type": "application/json" },
        body,
      },
    });
    const out = await extractFromUrl("https://example.com/r.json", {
      fetch: fetchFn,
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
    });
    expect(out.content_status).toBe("captured");
    expect(out.markdown).toContain('"a": 1');
  });

  it("fails Reddit thread URLs with RedditManualImportError instead of fetching", async () => {
    const calls: Array<{ url: string }> = [];
    const fetchFn = fakeFetch({}, (url) => calls.push({ url }));

    await expect(
      extractFromUrl("https://www.reddit.com/r/golang/comments/d0zpsh/learning_idiomatic_go_coming_from_java/", {
        fetch: fetchFn,
        timeoutMs: 5_000,
        maxBytes: 1_000_000,
      }),
    ).rejects.toBeInstanceOf(RedditManualImportError);

    // The worker must not burn a fetch on Reddit — datacenter egress only gets
    // the bot-challenge; the local reddit-import skill handles these.
    expect(calls).toHaveLength(0);
  });

  it("fails redd.it shortlinks with RedditManualImportError", async () => {
    const fetchFn = fakeFetch({});
    await expect(
      extractFromUrl("https://redd.it/d0zpsh", {
        fetch: fetchFn,
        timeoutMs: 5_000,
        maxBytes: 1_000_000,
      }),
    ).rejects.toBeInstanceOf(RedditManualImportError);
  });

  it("fails Reddit /s/ share-redirect links with RedditManualImportError (no fetch)", async () => {
    const calls: Array<{ url: string }> = [];
    const fetchFn = fakeFetch({}, (url) => calls.push({ url }));
    await expect(
      extractFromUrl("https://www.reddit.com/r/golang/s/AbC123xyz", {
        fetch: fetchFn,
        timeoutMs: 5_000,
        maxBytes: 1_000_000,
      }),
    ).rejects.toBeInstanceOf(RedditManualImportError);
    // Must not follow the share redirect and capture the bot-challenge page.
    expect(calls).toHaveLength(0);
  });

  it("throws BadStatusError on non-2xx responses", async () => {
    const fetchFn = fakeFetch({
      "https://example.com/missing": { status: 404, body: "not found" },
    });
    await expect(
      extractFromUrl("https://example.com/missing", {
        fetch: fetchFn,
        timeoutMs: 5_000,
        maxBytes: 1_000_000,
      }),
    ).rejects.toBeInstanceOf(BadStatusError);
  });

  it("throws OversizedResponseError when body exceeds maxBytes", async () => {
    const big = "x".repeat(2_000);
    const fetchFn = fakeFetch({
      "https://example.com/big": {
        headers: { "content-type": "text/plain", "content-length": String(big.length) },
        body: big,
      },
    });
    await expect(
      extractFromUrl("https://example.com/big", {
        fetch: fetchFn,
        timeoutMs: 5_000,
        maxBytes: 1_000,
      }),
    ).rejects.toBeInstanceOf(OversizedResponseError);
  });

  it("throws OversizedResponseError when streamed body exceeds maxBytes (no content-length)", async () => {
    const big = "x".repeat(2_000);
    const fetchFn = fakeFetch({
      "https://example.com/big": {
        headers: { "content-type": "text/plain" }, // no content-length
        body: big,
      },
    });
    await expect(
      extractFromUrl("https://example.com/big", {
        fetch: fetchFn,
        timeoutMs: 5_000,
        maxBytes: 1_000,
      }),
    ).rejects.toBeInstanceOf(OversizedResponseError);
  });

  it("throws FetchTimeoutError when fetch hangs longer than timeoutMs", async () => {
    const slowFetch = (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    await expect(
      extractFromUrl("https://example.com/slow", {
        fetch: slowFetch,
        timeoutMs: 50,
        maxBytes: 1_000_000,
      }),
    ).rejects.toBeInstanceOf(FetchTimeoutError);
  });

  it("respects an existing <base href> on the page (does not override with the source URL)", async () => {
    // Page declares its own canonical base. Our previous implementation injected
    // a second <base href> with the source URL, which would silently win against
    // the page's intent. After the fix we must skip injection when a <base>
    // already exists, so Readability resolves relative links against the page's.
    const html = `<!doctype html>
<html><head><base href="https://canonical.example/path/"><title>T</title></head>
<body><main><article>
<h1>Article</h1>
<p>This is the first paragraph with sufficient length to be picked up by readability without trouble.</p>
<p>Second paragraph for length. <a href="other">relative link</a> appears here, please resolve me.</p>
</article></main></body></html>`;
    const fetchFn = fakeFetch({
      "https://passed.example/article": {
        headers: { "content-type": "text/html; charset=utf-8" },
        body: html,
      },
    });
    const out = await extractFromUrl("https://passed.example/article", {
      fetch: fetchFn,
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
    });
    expect(out.content_status).toBe("captured");
    expect(out.markdown).toContain("canonical.example");
    expect(out.markdown).not.toContain("passed.example");
  });

  describe("SSRF guards", () => {
    const failingFetch = () =>
      vi.fn(async () => {
        throw new Error("fetch should not be called for blocked hosts");
      }) as unknown as typeof fetch;

    const blocked = [
      "http://localhost/",
      "http://localhost./",
      "http://printer.local/",
      "http://printer.local./",
      "http://127.0.0.1/",
      "http://127.255.0.1/",
      "http://10.0.0.1/",
      "http://10.255.255.255/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/",
      "http://169.254.169.254/",
      "http://169.254.0.1/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/",
      "http://[fe80::1]/",
      // IPv4-mapped IPv6 (::ffff:a.b.c.d) decodes to the embedded IPv4; treat
      // the embedded address with the same private/loopback/link-local rules.
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:10.0.0.1]/",
      "http://[::ffff:172.16.0.1]/",
      "http://[::ffff:192.168.1.1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://[::ffff:0.0.0.0]/",
      // IPv4-compatible IPv6 (::a.b.c.d) — same treatment.
      "http://[::127.0.0.1]/",
      "http://[::10.0.0.1]/",
      // Long-form loopback (uncompressed ::1).
      "http://[0:0:0:0:0:0:0:1]/",
    ];

    for (const url of blocked) {
      it(`rejects ${url} with BlockedHostError without calling fetch`, async () => {
        const fetchFn = failingFetch();
        await expect(
          extractFromUrl(url, { fetch: fetchFn, timeoutMs: 5_000, maxBytes: 1_000_000 }),
        ).rejects.toBeInstanceOf(BlockedHostError);
        expect(fetchFn).not.toHaveBeenCalled();
      });
    }

    for (const url of ["file:///etc/passwd", "gopher://example.com/", "ftp://example.com/"]) {
      it(`rejects ${url} (non-http(s) scheme)`, async () => {
        const fetchFn = failingFetch();
        await expect(
          extractFromUrl(url, { fetch: fetchFn, timeoutMs: 5_000, maxBytes: 1_000_000 }),
        ).rejects.toBeInstanceOf(BlockedHostError);
        expect(fetchFn).not.toHaveBeenCalled();
      });
    }

    it("does NOT block a public IPv4 host (1.1.1.1)", async () => {
      const fetchFn = fakeFetch({
        "http://1.1.1.1/": { headers: { "content-type": "text/plain" }, body: "ok" },
      });
      const out = await extractFromUrl("http://1.1.1.1/", {
        fetch: fetchFn,
        timeoutMs: 5_000,
        maxBytes: 1_000_000,
      });
      expect(out.content_status).toBe("captured");
    });

    it("does NOT block 172.32.0.1 (just outside the 172.16.0.0/12 private range)", async () => {
      const fetchFn = fakeFetch({
        "http://172.32.0.1/": { headers: { "content-type": "text/plain" }, body: "ok" },
      });
      const out = await extractFromUrl("http://172.32.0.1/", {
        fetch: fetchFn,
        timeoutMs: 5_000,
        maxBytes: 1_000_000,
      });
      expect(out.content_status).toBe("captured");
    });

    it("does NOT block normal https hosts", async () => {
      const fetchFn = fakeFetch({
        "https://example.com/": { headers: { "content-type": "text/plain" }, body: "ok" },
      });
      const out = await extractFromUrl("https://example.com/", {
        fetch: fetchFn,
        timeoutMs: 5_000,
        maxBytes: 1_000_000,
      });
      expect(out.content_status).toBe("captured");
    });
  });

  it("falls back to application/octet-stream when no content-type header is set", async () => {
    const fetchFn = fakeFetch({
      "https://example.com/binary": {
        headers: {},
        body: new Uint8Array([1, 2, 3]),
      },
    });
    const out = await extractFromUrl("https://example.com/binary", {
      fetch: fetchFn,
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
    });
    expect(out.content_type).toBe("application/octet-stream");
    expect(out.content_status).toBe("raw_only");
  });
});

describe("extractFromUrl — YouTube", () => {
  const ID = "YtTWNzOtkxU";
  const WATCH = canonicalWatchUrl(ID);
  const OEMBED = oembedUrl(ID);
  const CAPTION_BASE = "https://www.youtube.com/api/timedtext?v=YtTWNzOtkxU&lang=en";

  const OEMBED_JSON = JSON.stringify({
    title: "Greeting World",
    author_name: "Some Channel",
    author_url: "https://www.youtube.com/@some",
  });

  const WATCH_HTML = `<!doctype html><html><head><title>x</title></head><body>
    <script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"YtTWNzOtkxU","shortDescription":"A short description of the talk."},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"${CAPTION_BASE}","languageCode":"en"}]}}};</script>
  </body></html>`;

  const TIMEDTEXT_JSON3 = JSON.stringify({
    events: [{ segs: [{ utf8: "hello there" }] }, { segs: [{ utf8: " friends" }] }],
  });

  const deps = { timeoutMs: 5_000, maxBytes: 1_000_000 };

  it("captures title, author, description and transcript from a watch URL", async () => {
    const calls: string[] = [];
    const fetchFn = fakeFetch(
      {
        [OEMBED]: { headers: { "content-type": "application/json" }, body: OEMBED_JSON },
        [WATCH]: { headers: { "content-type": "text/html; charset=utf-8" }, body: WATCH_HTML },
        [timedtextJson3Url(CAPTION_BASE)]: {
          headers: { "content-type": "application/json" },
          body: TIMEDTEXT_JSON3,
        },
      },
      (url) => calls.push(url),
    );

    const out = await extractFromUrl(WATCH, { fetch: fetchFn, ...deps });

    expect(out.content_status).toBe("captured");
    expect(out.title).toBe("Greeting World");
    expect(out.markdown).toContain("# Greeting World");
    expect(out.markdown).toContain("[Some Channel](https://www.youtube.com/@some)");
    expect(out.markdown).toContain("A short description of the talk.");
    expect(out.markdown).toContain("## Transcript");
    expect(out.markdown).toContain("hello there friends");
    // Never routed through the generic Readability path.
    expect(calls).toContain(OEMBED);
  });

  it("degrades to the oEmbed floor when the watch page is rate limited", async () => {
    const fetchFn = fakeFetch({
      [OEMBED]: { headers: { "content-type": "application/json" }, body: OEMBED_JSON },
      [WATCH]: { status: 429, headers: { "retry-after": "30" }, body: "rate limited" },
    });

    const out = await extractFromUrl(WATCH, { fetch: fetchFn, ...deps });

    expect(out.content_status).toBe("captured");
    expect(out.title).toBe("Greeting World");
    expect(out.markdown).toContain("# Greeting World");
    expect(out.markdown).not.toContain("## Transcript");
  });

  it("propagates RateLimitedError when the oEmbed floor is rate limited", async () => {
    const fetchFn = fakeFetch({
      [OEMBED]: { status: 429, headers: { "retry-after": "30" }, body: "rate limited" },
    });
    await expect(extractFromUrl(WATCH, { fetch: fetchFn, ...deps })).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it("propagates RateLimitedError through the production retry wrapper (oEmbed 429)", async () => {
    // Production wires `retry`, so 429 detection happens inside fetchWithRetry,
    // not the inline check in fetchBounded. Pin the as-deployed queue-retry path.
    const fetchFn = fakeFetch({
      [OEMBED]: { status: 429, headers: { "retry-after": "30" }, body: "rate limited" },
    });
    await expect(
      extractFromUrl(WATCH, {
        fetch: fetchFn,
        ...deps,
        retry: { sleep: async () => {}, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("fails the reading when oEmbed errors with a non-429 status (BadStatusError)", async () => {
    // Tier 1 is the required floor: a 5xx there is a real failure, distinct from
    // the best-effort watch-page/transcript fetches which degrade.
    const fetchFn = fakeFetch({
      [OEMBED]: { status: 503, body: "unavailable" },
    });
    await expect(extractFromUrl(WATCH, { fetch: fetchFn, ...deps })).rejects.toBeInstanceOf(
      BadStatusError,
    );
  });

  it("throws BadStatusError when the video is unavailable (oEmbed 404)", async () => {
    const fetchFn = fakeFetch({
      [OEMBED]: { status: 404, body: "not found" },
    });
    await expect(extractFromUrl(WATCH, { fetch: fetchFn, ...deps })).rejects.toBeInstanceOf(
      BadStatusError,
    );
  });

  it("routes youtu.be short links through the YouTube path", async () => {
    const calls: string[] = [];
    const fetchFn = fakeFetch(
      {
        [OEMBED]: { headers: { "content-type": "application/json" }, body: OEMBED_JSON },
        [WATCH]: { status: 429, headers: { "retry-after": "1" }, body: "x" },
      },
      (url) => calls.push(url),
    );

    const out = await extractFromUrl("https://youtu.be/YtTWNzOtkxU?t=30", {
      fetch: fetchFn,
      ...deps,
    });

    expect(out.title).toBe("Greeting World");
    // Resolved to the canonical oEmbed lookup rather than fetching the short link.
    expect(calls).toContain(OEMBED);
    expect(calls).not.toContain("https://youtu.be/YtTWNzOtkxU?t=30");
  });
});
