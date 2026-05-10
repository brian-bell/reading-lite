import { describe, expect, it } from "vitest";
import {
  buildImportPlan,
  findOversizedMarkdownArticles,
  parseMarkdownArticle,
  selectPreferredArticle,
} from "../../../scripts/import-markdown-lib/parse";

describe("parseMarkdownArticle", () => {
  it("extracts title and source URL from the article header", () => {
    const article = parseMarkdownArticle(
      "/tmp/agent.md",
      [
        "# Designing for Agents",
        "**Author:** Teddy Riker",
        "**Source:** Referenced in: https://x.com/teddy_riker/status/2047312986696454584",
        "",
        "body",
      ].join("\n"),
    );

    expect(article.title).toBe("Designing for Agents");
    expect(article.sourceUrl).toBe("https://x.com/teddy_riker/status/2047312986696454584");
    expect(article.fileName).toBe("agent.md");
    expect(article.bytes).toBeGreaterThan(0);
  });

  it("leaves sourceUrl undefined when the source line is missing", () => {
    const article = parseMarkdownArticle("/tmp/no-source.md", "# Title\n\nbody");
    expect(article.sourceUrl).toBeUndefined();
  });
});

describe("buildImportPlan", () => {
  it("dedupes by source URL and selects the largest Markdown file", () => {
    const short = parseMarkdownArticle(
      "/tmp/short.md",
      "# Short\n**Source:** https://example.com/a\n\nsmall",
    );
    const long = parseMarkdownArticle(
      "/tmp/long.md",
      "# Long\n**Source:** https://example.com/a\n\nlarger body",
    );
    const solo = parseMarkdownArticle(
      "/tmp/solo.md",
      "# Solo\n**Source:** https://example.com/b\n\nbody",
    );
    const missing = parseMarkdownArticle("/tmp/missing.md", "# Missing\n\nbody");

    const plan = buildImportPlan([short, long, solo, missing]);

    expect(plan.files).toHaveLength(4);
    expect(plan.missingSource.map((file) => file.fileName)).toEqual(["missing.md"]);
    expect(plan.selected.map((file) => file.sourceUrl)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(plan.duplicateGroups).toHaveLength(1);
    expect(plan.duplicateGroups[0]!.selected.fileName).toBe("long.md");
  });
});

describe("findOversizedMarkdownArticles", () => {
  it("flags only Markdown bodies larger than the configured limit", () => {
    const atLimit = parseMarkdownArticle(
      "/tmp/at-limit.md",
      "# A\n**Source:** https://example.com/a\n",
    );
    const overLimit = parseMarkdownArticle(
      "/tmp/over-limit.md",
      "# B\n**Source:** https://example.com/b\nbody",
    );

    const oversized = findOversizedMarkdownArticles([atLimit, overLimit], atLimit.bytes);

    expect(oversized).toHaveLength(1);
    expect(oversized[0]!.article.fileName).toBe("over-limit.md");
    expect(oversized[0]!.excessBytes).toBe(overLimit.bytes - atLimit.bytes);
  });
});

describe("selectPreferredArticle", () => {
  it("uses file name as a stable tiebreaker", () => {
    const b = parseMarkdownArticle("/tmp/b.md", "# B\n**Source:** https://example.com/a\n");
    const a = parseMarkdownArticle("/tmp/a.md", "# A\n**Source:** https://example.com/a\n");
    expect(selectPreferredArticle([b, a]).fileName).toBe("a.md");
  });
});
