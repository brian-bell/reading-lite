import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMarkdownArticle } from "../../../scripts/import-markdown-lib/parse";
import {
  moveArticlesToProcessed,
  processedDirFor,
} from "../../../scripts/import-markdown-lib/processed";

describe("moveArticlesToProcessed", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "import-markdown-processed-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("moves imported Markdown files into a processed subdirectory", async () => {
    const filePath = path.join(tmpDir, "article.md");
    await fs.writeFile(filePath, "# Article\n**Source:** https://example.com/a\n", "utf8");
    const article = parseMarkdownArticle(
      filePath,
      await fs.readFile(filePath, "utf8"),
    );

    const moves = await moveArticlesToProcessed([article], tmpDir);

    expect(moves).toHaveLength(1);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readFile(path.join(processedDirFor(tmpDir), "article.md"), "utf8"),
    ).resolves.toContain("# Article");
  });

  it("keeps existing processed files by choosing a unique destination name", async () => {
    const processedDir = processedDirFor(tmpDir);
    await fs.mkdir(processedDir, { recursive: true });
    await fs.writeFile(path.join(processedDir, "article.md"), "old", "utf8");

    const filePath = path.join(tmpDir, "article.md");
    await fs.writeFile(filePath, "new", "utf8");
    const article = parseMarkdownArticle(filePath, "new");

    const moves = await moveArticlesToProcessed([article], tmpDir);

    expect(path.basename(moves[0]!.destinationPath)).toBe("article-2.md");
    await expect(
      fs.readFile(path.join(processedDir, "article.md"), "utf8"),
    ).resolves.toBe("old");
    await expect(
      fs.readFile(path.join(processedDir, "article-2.md"), "utf8"),
    ).resolves.toBe("new");
  });
});
