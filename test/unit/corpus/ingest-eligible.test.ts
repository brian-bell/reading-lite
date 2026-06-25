import { describe, expect, it } from "vitest";
import { selectEligibleArticles } from "../../../scripts/corpus-lib/ingest-eligible";
import {
  MARKDOWN_IMPORT_MAX_BYTES,
  type MarkdownArticle,
} from "../../../scripts/import-markdown-lib/parse";

function article(over: Partial<MarkdownArticle>): MarkdownArticle {
  const markdown = over.markdown ?? "# x\n\nbody";
  return {
    filePath: over.filePath ?? `/tmp/${over.fileName ?? "a.md"}`,
    fileName: over.fileName ?? "a.md",
    markdown,
    bytes: over.bytes ?? Buffer.byteLength(markdown, "utf8"),
    ...(over.title === undefined ? {} : { title: over.title }),
    ...(over.sourceUrl === undefined ? {} : { sourceUrl: over.sourceUrl }),
    ...over,
  };
}

describe("selectEligibleArticles", () => {
  it("drops missing-source and oversized files, deduping the rest by source URL", () => {
    const good = article({ fileName: "good.md", sourceUrl: "https://example.com/good", bytes: 100 });
    const dupSmall = article({ fileName: "dup-small.md", sourceUrl: "https://example.com/dup", bytes: 50 });
    const dupLarge = article({ fileName: "dup-large.md", sourceUrl: "https://example.com/dup", bytes: 80 });
    const noSource = article({ fileName: "nosource.md", sourceUrl: undefined });
    const oversized = article({
      fileName: "huge.md",
      sourceUrl: "https://example.com/huge",
      bytes: MARKDOWN_IMPORT_MAX_BYTES + 1,
    });

    const sel = selectEligibleArticles([good, dupSmall, dupLarge, noSource, oversized]);

    // oversized reported, missing-source reported
    expect(sel.oversized.map((o) => o.article.fileName)).toEqual(["huge.md"]);
    expect(sel.plan.missingSource.map((a) => a.fileName)).toEqual(["nosource.md"]);

    // eligible = good + the larger duplicate; no oversized, no missing-source
    expect(sel.eligible.map((a) => a.fileName).sort()).toEqual(["dup-large.md", "good.md"]);
  });
});
