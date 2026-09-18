// The HTML→markdown path on its own, exported so the local extraction agent's
// headless tier can run the identical rules against a *rendered* DOM. The
// `salvaged` flag is what the agent's tiering gate keys off: a salvage-only
// article is the signal that a static fetch saw a JS shell and a render is worth
// trying, and (from Phase 6) that a raw_only reading must not be "upgraded" with
// boilerplate soup.

import { describe, expect, it } from "vitest";
import { readabilityFromHtml } from "../../../src/modules/extractor";

const URL = "https://example.com/a";

function articleHtml(headExtra = ""): string {
  return `<!doctype html>
<html><head><title>Hello World</title>${headExtra}</head>
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
}

const HTML_ARTICLE = articleHtml();

// Minimal reduction of the docs.spring.io page from issue #18: content with no
// <body> wrapper, which makes Readability walk past <html> to null and throw.
const HTML_NO_BODY_CRASH = `<div id="content"><article><h1>Reference</h1>${"<p>property value property value property value property value</p>".repeat(8)}</article></div><script>var x=1;</script>`;

describe("readabilityFromHtml", () => {
  it("reports a Readability-proper article as not salvaged", () => {
    const article = readabilityFromHtml(HTML_ARTICLE, URL);

    expect(article).not.toBeNull();
    expect(article?.salvaged).toBe(false);
    expect(article?.title).toBe("Hello World");
    expect(article?.markdown).toContain("first paragraph");
    expect(article?.markdown).not.toContain("nav");
    expect(article?.publishedTime).toBeUndefined();
  });

  it("surfaces article:published_time as publishedTime", () => {
    const html = articleHtml(
      `<meta property="article:published_time" content="2024-03-15T08:00:00-05:00">`,
    );
    const article = readabilityFromHtml(html, URL);

    expect(article?.salvaged).toBe(false);
    expect(article?.publishedTime).toBe("2024-03-15T08:00:00-05:00");
  });

  it("surfaces JSON-LD datePublished as publishedTime", () => {
    const jsonLd = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      headline: "Hello World",
      datePublished: "2024-06-01T12:00:00.000Z",
    });
    const html = articleHtml(`<script type="application/ld+json">${jsonLd}</script>`);
    const article = readabilityFromHtml(html, URL);

    expect(article?.salvaged).toBe(false);
    expect(article?.publishedTime).toBe("2024-06-01T12:00:00.000Z");
  });

  it("reports the raw-DOM fallback as salvaged", () => {
    const article = readabilityFromHtml(HTML_NO_BODY_CRASH, URL);

    expect(article).not.toBeNull();
    expect(article?.salvaged).toBe(true);
    expect(article?.markdown).toContain("property value");
    expect(article?.markdown).not.toContain("var x=1");
    expect(article?.publishedTime).toBeUndefined();
  });

  it("returns null when Readability crashes and there is nothing to salvage", () => {
    expect(readabilityFromHtml(`<div id="content"><article></article></div><script>var x=1;</script>`, URL)).toBeNull();
  });

  it("returns null on a deliberate no-article verdict (not a salvage case)", () => {
    // Readability rejecting a page cleanly is a verdict, not a crash: the caller
    // must see null and degrade, never boilerplate marked `salvaged`.
    expect(readabilityFromHtml("<html><body></body></html>", URL)).toBeNull();
  });

  it("resolves relative links against the passed url", () => {
    // The <base> injection lives inside this function, so a caller handing it a
    // rendered DOM plus that page's final URL gets the same link resolution the
    // Worker's static path gets.
    const html = `<!doctype html>
<html><head><title>T</title></head>
<body><main><article>
<h1>Article</h1>
<p>This is the first paragraph with sufficient length to be picked up by readability without trouble.</p>
<p>Second paragraph for length. <a href="other">relative link</a> appears here, please resolve me.</p>
</article></main></body></html>`;

    const article = readabilityFromHtml(html, "https://rendered.example/path/page");

    expect(article?.markdown).toContain("https://rendered.example/path/other");
  });
});
