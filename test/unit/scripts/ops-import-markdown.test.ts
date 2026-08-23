import { describe, expect, it } from "vitest";
import { importMarkdownCommand, type ImportMarkdownDeps } from "../../../scripts/ops-lib/commands/import-markdown";
import { UsageError } from "../../../scripts/ops-lib/contract";
import type { MarkdownArticle } from "../../../scripts/import-markdown-lib/parse";

const SECRET = "sk-import-secret";

function article(name: string, sourceUrl: string | undefined, bytes = 100): MarkdownArticle {
  return {
    filePath: `/md/${name}`,
    fileName: name,
    markdown: "# body\n".padEnd(bytes, "x"),
    bytes,
    title: name.replace(/\.md$/, ""),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
  };
}

function makeDeps(articles: MarkdownArticle[], overrides: Partial<ImportMarkdownDeps> = {}): {
  deps: ImportMarkdownDeps;
  out: string[];
  err: string[];
  indexSaves: number;
  state: { indexSaves: number; moves: string[][]; submitted: string[] };
} {
  const out: string[] = [];
  const err: string[] = [];
  const state = { indexSaves: 0, moves: [] as string[][], submitted: [] as string[] };
  const deps: ImportMarkdownDeps = {
    io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
    readMarkdownDir: async () => articles,
    loadIndex: async () => ({}),
    saveIndex: async () => {
      state.indexSaves++;
    },
    moveArticlesToProcessed: async (arts) => {
      state.moves.push(arts.map((a) => a.fileName));
      return arts.map((a) => ({ fileName: a.fileName, sourcePath: a.filePath, destinationPath: `/md/processed/${a.fileName}` }));
    },
    submitAll: async (arts, opts) => {
      for (let i = 0; i < arts.length; i++) {
        state.submitted.push(arts[i].sourceUrl);
        await opts.onResult({
          index: i + 1, total: arts.length, sourceUrl: arts[i].sourceUrl,
          filePath: arts[i].filePath, classification: "new", id: `rd_${i}`,
        });
      }
      return { total: arts.length, new: arts.length, existing: 0, errors: 0 };
    },
    makeApi: () =>
      ({
        importMarkdown: async () => {
          throw new Error("network must not be touched directly");
        },
      }) as unknown as import("../../../scripts/lib/reading-api").ReadingApi,
    resolveToken: () => SECRET,
    now: () => Date.parse("2026-08-22T12:00:00Z"),
    ...overrides,
  };
  return { deps, out, err, indexSaves: state.indexSaves, state };
}

describe("ops import markdown", () => {
  it("plan mode prints the selection plan without submitting, recording, or moving", async () => {
    const { deps, out, err, state } = makeDeps([
      article("a.md", "https://example.com/a"),
      article("b.md", undefined),
    ]);
    const code = await importMarkdownCommand.run(["--dir", "/md"], deps);
    expect(code).toBe(0);
    expect(state.submitted).toHaveLength(0);
    expect(state.indexSaves).toBe(0);
    expect(state.moves).toHaveLength(0);
    const text = err.join("\n");
    expect(text).toContain("Would submit:     1");
    expect(text).toContain("--execute");
    expect(JSON.parse(out.join("\n")).submitted).toBe(0);
  });

  it("plan mode works without a token and never prints one", async () => {
    const { deps, out, err } = makeDeps([article("a.md", "https://example.com/a")], {
      resolveToken: () => {
        throw new Error("token must not be resolved in plan mode");
      },
    });
    const code = await importMarkdownCommand.run(["--dir", "/md"], deps);
    expect(code).toBe(0);
    expect(out.join("\n")).not.toContain(SECRET);
    expect(err.join("\n")).not.toContain(SECRET);
  });

  it("--execute submits unseen files, records the index, and moves them to processed/", async () => {
    const { deps, out, state } = makeDeps([article("a.md", "https://example.com/a")]);
    const code = await importMarkdownCommand.run(["--dir", "/md", "--execute"], deps);
    expect(code).toBe(0);
    expect(state.submitted).toEqual(["https://example.com/a"]);
    expect(state.indexSaves).toBe(1);
    expect(state.moves).toEqual([["a.md"]]);
    const summary = JSON.parse(out.join("\n"));
    expect(summary.submitted).toBe(1);
    expect(summary.new).toBe(1);
    expect(summary.moved).toBe(1);
  });

  it("--execute requires a token before any submission", async () => {
    const { deps, state } = makeDeps([article("a.md", "https://example.com/a")], {
      resolveToken: () => "",
    });
    await expect(importMarkdownCommand.run(["--dir", "/md", "--execute"], deps)).rejects.toThrow(UsageError);
    expect(state.submitted).toHaveLength(0);
  });

  it("--execute blocks on oversized files with exit 1 before submitting", async () => {
    const { deps, state, err } = makeDeps([article("big.md", "https://example.com/big", 200_000)]);
    const code = await importMarkdownCommand.run(["--dir", "/md", "--execute"], deps);
    expect(code).toBe(1);
    expect(state.submitted).toHaveLength(0);
    expect(err.join("\n")).toContain("blocked oversized markdown files");
  });

  it("requires --dir", async () => {
    const { deps } = makeDeps([]);
    await expect(importMarkdownCommand.run([], deps)).rejects.toThrow(UsageError);
  });

  it("rejects the retired --dry-run flag", async () => {
    const { deps } = makeDeps([]);
    await expect(importMarkdownCommand.run(["--dir", "/md", "--dry-run"], deps)).rejects.toThrow(UsageError);
  });
});
