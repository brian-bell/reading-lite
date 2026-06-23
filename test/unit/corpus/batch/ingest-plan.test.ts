import { describe, expect, it, vi } from "vitest";
import { buildIngestPlan } from "../../../../scripts/corpus-lib/batch/ingest-plan";
import { urlHash } from "../../../../scripts/corpus-lib/url-hash";
import { MARKDOWN_IMPORT_MAX_BYTES } from "../../../../scripts/import-markdown-lib/parse";
import type { MarkdownArticle } from "../../../../scripts/import-markdown-lib/parse";
import type { Manifest } from "../../../../src/schemas/manifest";

function article(name: string, sourceUrl: string | undefined, markdown: string): MarkdownArticle {
  return {
    filePath: `/tmp/${name}`,
    fileName: name,
    markdown,
    bytes: Buffer.byteLength(markdown, "utf8"),
    title: "T",
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
  };
}

function body(url: string | undefined, pad = ""): string {
  return `# T\n\n${url ? `**Source:** ${url}\n\n` : ""}body${pad}`;
}

function deps(over: { ready?: string[] } = {}) {
  const ready = new Set((over.ready ?? []).map((u) => urlHash(u)));
  return {
    readPointer: vi.fn(async (hash: string) =>
      ready.has(hash) ? { id: `rd_${hash.slice(0, 4)}`, key_prefix: `readings/kp-${hash.slice(0, 4)}` } : null,
    ),
    readManifest: vi.fn(async () => ({ status: "ready" } as Manifest)),
    now: () => "2026-06-22T00:00:00.000Z",
    newId: (() => {
      let n = 0;
      return () => `rd_new${n++}`;
    })(),
  };
}

describe("buildIngestPlan", () => {
  it("submits eligible articles and reports missing-source + oversized as skipped, not submitted", async () => {
    const big = "x".repeat(MARKDOWN_IMPORT_MAX_BYTES + 1);
    const articles = [
      article("ok.md", "https://example.com/ok", body("https://example.com/ok")),
      article("nosrc.md", undefined, body(undefined)),
      article("huge.md", "https://example.com/huge", body("https://example.com/huge", big)),
    ];
    const plan = await buildIngestPlan(articles, deps());

    expect(plan.targets.map((t) => t.target.url)).toEqual(["https://example.com/ok"]);
    expect(plan.missingSource.map((a) => a.fileName)).toEqual(["nosrc.md"]);
    expect(plan.oversized.map((o) => o.article.fileName)).toEqual(["huge.md"]);
  });

  it("dedupes by source url (largest wins) — one target per source", async () => {
    const url = "https://example.com/dup";
    const articles = [
      article("small.md", url, body(url)),
      article("large.md", url, body(url, "yyyyyyyyyyyyyyy")),
    ];
    const plan = await buildIngestPlan(articles, deps());
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]!.markdown).toContain("yyyyyyyyyyyyyyy");
    expect(plan.duplicateGroups).toHaveLength(1);
  });

  it("does not lose a URL whose largest duplicate is oversized — the valid sibling wins", async () => {
    const url = "https://example.com/mixed";
    const big = "x".repeat(MARKDOWN_IMPORT_MAX_BYTES + 1);
    const articles = [
      article("big.md", url, body(url, big)),
      article("small.md", url, body(url)),
    ];
    const plan = await buildIngestPlan(articles, deps());
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]!.target.url).toBe(url);
    expect(plan.targets[0]!.markdown).not.toContain(big);
    expect(plan.oversized.map((o) => o.article.fileName)).toEqual(["big.md"]);
  });

  it("skips already-ready owners (idempotent re-run)", async () => {
    const url = "https://example.com/ready";
    const plan = await buildIngestPlan([article("r.md", url, body(url))], deps({ ready: [url] }));
    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped).toEqual([
      { url, reason: "already-ready", readingId: `rd_${urlHash(url).slice(0, 4)}` },
    ]);
  });
});
