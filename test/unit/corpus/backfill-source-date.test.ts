import { describe, expect, it } from "vitest";
import {
  classifySourceDateCandidate,
  classifyStoredHtml,
  sourceDateFromStoredHtml,
  validateSourceDateBackfillWrite,
  withSourceDate,
} from "../../../scripts/corpus-lib/backfill-source-date";

const NOW = Date.parse("2026-09-18T12:00:00.000Z");
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

const DATED_HTML = articleHtml(
  `<meta property="article:published_time" content="2024-03-15T08:00:00-05:00">`,
);
const UNDATED_HTML = articleHtml();

describe("classifySourceDateCandidate", () => {
  it("treats a stored date as already-dated, including on markdown imports", () => {
    expect(classifySourceDateCandidate({ source_date: "2024-03-15" })).toBe("already-dated");
    expect(
      classifySourceDateCandidate({ source_date: "2024-03-15", source_type: "markdown" }),
    ).toBe("already-dated");
  });

  it("skips markdown imports that have no date", () => {
    expect(classifySourceDateCandidate({ source_type: "markdown" })).toBe("skip-markdown");
  });

  it("inspects URL-backed and legacy (no source_type) readings", () => {
    expect(classifySourceDateCandidate({ source_type: "url" })).toBe("inspect-html");
    expect(classifySourceDateCandidate({})).toBe("inspect-html");
  });

  it("treats a blank source_date as missing", () => {
    expect(classifySourceDateCandidate({ source_date: "  " })).toBe("inspect-html");
  });
});

describe("sourceDateFromStoredHtml", () => {
  it("uses the live HTML extract date rules (YYYY-MM-DD UTC)", () => {
    expect(sourceDateFromStoredHtml(DATED_HTML, URL, NOW)).toBe("2024-03-15");
  });

  it("drops HTML with no publishedTime", () => {
    expect(sourceDateFromStoredHtml(UNDATED_HTML, URL, NOW)).toBeUndefined();
  });

  it("drops an implausible future publishedTime", () => {
    const html = articleHtml(
      `<meta property="article:published_time" content="2026-09-19T00:00:00.000Z">`,
    );
    expect(sourceDateFromStoredHtml(html, URL, NOW)).toBeUndefined();
  });
});

describe("classifyStoredHtml", () => {
  it("reports no-raw when the HTML object is absent", () => {
    expect(classifyStoredHtml({ rawHtml: null, url: URL, nowMs: NOW })).toEqual({ kind: "no-raw" });
  });

  it("reports unparseable when stored HTML yields no usable date", () => {
    expect(classifyStoredHtml({ rawHtml: UNDATED_HTML, url: URL, nowMs: NOW })).toEqual({
      kind: "unparseable",
    });
    expect(classifyStoredHtml({ rawHtml: "<html></html>", url: URL, nowMs: NOW })).toEqual({
      kind: "unparseable",
    });
  });

  it("reports would-gain when stored HTML has a usable date", () => {
    expect(classifyStoredHtml({ rawHtml: DATED_HTML, url: URL, nowMs: NOW })).toEqual({
      kind: "would-gain",
      source_date: "2024-03-15",
    });
  });
});

describe("withSourceDate", () => {
  const manifest = {
    id: "rd_a",
    title: "A title",
    tldr: "A tldr.",
    tags: ["x"],
    summary_markdown: "body",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("sets only source_date and leaves every other field, including updated_at", () => {
    const out = withSourceDate(manifest, "2024-03-15") as Record<string, unknown>;
    const { source_date: _drop, ...rest } = out;
    expect(out.source_date).toBe("2024-03-15");
    expect(rest).toEqual(manifest);
  });
});

describe("validateSourceDateBackfillWrite", () => {
  const valid = {
    id: "rd_a",
    url: "https://a.com/p",
    url_hash: "a".repeat(64),
    status: "ready",
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: "2026-08-22T00:00:00.000Z",
    updated_at: "2026-08-22T00:00:00.000Z",
  };

  it("accepts a missing-date manifest and merges source_date", () => {
    const out = validateSourceDateBackfillWrite(valid, "2024-03-15");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.manifest.source_date).toBe("2024-03-15");
  });

  it("refuses to overwrite an existing source_date", () => {
    const out = validateSourceDateBackfillWrite({ ...valid, source_date: "2020-01-01" }, "2024-03-15");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/already present/);
  });

  it("rejects unrelated schema drift instead of entrenching it", () => {
    const out = validateSourceDateBackfillWrite({ ...valid, status: "not-a-status" }, "2024-03-15");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/status/);
  });

  it("preserves unknown stored fields, which ManifestSchema would strip", () => {
    const withExtra = { ...valid, some_future_field: { keep: "me" } };
    const out = validateSourceDateBackfillWrite(withExtra, "2024-03-15");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.manifest.some_future_field).toEqual({ keep: "me" });
  });

  it("rejects a non-object", () => {
    expect(validateSourceDateBackfillWrite(null, "2024-03-15").ok).toBe(false);
    expect(validateSourceDateBackfillWrite("nope", "2024-03-15").ok).toBe(false);
  });
});
