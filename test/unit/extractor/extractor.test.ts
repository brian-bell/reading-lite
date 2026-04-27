import { describe, expect, it } from "vitest";
import { extractFromUrl, FetchTimeoutError, OversizedResponseError, BadStatusError } from "../../../src/modules/extractor";

function fakeFetch(responses: Record<string, { status?: number; headers?: Record<string, string>; body: BodyInit }>) {
  return async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
