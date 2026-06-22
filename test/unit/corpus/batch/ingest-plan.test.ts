import { describe, expect, it, vi } from "vitest";
import { planFreshMarkdownIngest } from "../../../../scripts/corpus-lib/batch/ingest-plan";
import { parseMarkdownArticle } from "../../../../scripts/import-markdown-lib/parse";
import type { MarkdownArticle } from "../../../../scripts/import-markdown-lib/parse";
import type { PrepareFreshDeps } from "../../../../scripts/corpus-lib/batch/prepare-fresh-markdown";
import { ManifestSchema, type Manifest } from "../../../../src/schemas/manifest";

const NOW = "2026-06-22T12:00:00.000Z";

function hex(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

function makeDeps(over: Partial<PrepareFreshDeps> = {}): PrepareFreshDeps {
  let n = 0;
  return {
    readByUrlPointer: vi.fn(async () => null),
    readManifest: vi.fn(async () => null),
    mintId: vi.fn(() => `rd_new${n++}`),
    now: () => NOW,
    sha256: vi.fn(async (s: string) => hex(s)),
    ...over,
  };
}

function article(name: string, sourceUrl: string | undefined, body: string): MarkdownArticle {
  const md =
    `# ${name}\n\n` + (sourceUrl ? `**Source:** ${sourceUrl}\n\n` : "") + body;
  return parseMarkdownArticle(`/x/${name}.md`, md);
}

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_existing",
    url: over.url ?? "https://example.com/a",
    url_hash: hex(over.url ?? "https://example.com/a"),
    source_type: "markdown",
    status: "ready",
    content_type: "text/markdown; charset=utf-8",
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...over,
  } as Manifest;
}

describe("planFreshMarkdownIngest", () => {
  it("dedupes by source (largest wins) and reports counts", async () => {
    const articles = [
      article("a", "https://example.com/a", "short"),
      article("b", "https://example.com/dup", "small body"),
      article("c", "https://example.com/dup", "a much much larger body that should win"),
      article("d", undefined, "no source line here"),
    ];
    const plan = await planFreshMarkdownIngest(articles, Infinity, makeDeps());
    expect(plan.fileCount).toBe(4);
    expect(plan.uniqueSources).toBe(2);
    expect(plan.duplicateGroups).toHaveLength(1);
    expect(plan.missingSource.map((m) => m.fileName)).toEqual(["d.md"]);
    expect(plan.prep.targets).toHaveLength(2);
    // the larger dup file's markdown is the one submitted
    const dupTarget = plan.prep.targets.find((t) => t.target.url === "https://example.com/dup")!;
    expect(dupTarget.markdown).toContain("larger body");
  });

  it("excludes oversized files from submission and reports them", async () => {
    const big = "x".repeat(200_000);
    const articles = [
      article("ok", "https://example.com/ok", "fine"),
      article("huge", "https://example.com/huge", big),
    ];
    const plan = await planFreshMarkdownIngest(articles, Infinity, makeDeps());
    expect(plan.oversized.map((o) => o.article.fileName)).toEqual(["huge.md"]);
    expect(plan.prep.targets.map((t) => t.target.url)).toEqual(["https://example.com/ok"]);
  });

  it("applies --limit AFTER idempotency so ready owners don't consume a slot", async () => {
    // a is already ready; b and c are fresh. With limit=1, the cap must land on a
    // FRESH target (b), not be wasted on the skipped 'a'.
    const articles = [
      article("a", "https://example.com/a", "body a"),
      article("b", "https://example.com/b", "body b"),
      article("c", "https://example.com/c", "body c"),
    ];
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async (urlHash: string) =>
        urlHash === hex("https://example.com/a")
          ? { id: "rd_existing", key_prefix: "readings/kp-a" }
          : null,
      ),
      readManifest: vi.fn(async () => manifest({ status: "ready" })),
    });
    const plan = await planFreshMarkdownIngest(articles, 1, deps);
    expect(plan.prep.skipped).toEqual([{ url: "https://example.com/a", reason: "already-ready" }]);
    expect(plan.prep.targets).toHaveLength(1);
    expect(plan.prep.targets[0]!.target.url).toBe("https://example.com/b");
  });

  it("produces schema-valid carrier manifests for fresh targets", async () => {
    const plan = await planFreshMarkdownIngest(
      [article("a", "https://example.com/a", "body")],
      Infinity,
      makeDeps(),
    );
    expect(() => ManifestSchema.parse(plan.prep.targets[0]!.target.manifest)).not.toThrow();
  });
});
