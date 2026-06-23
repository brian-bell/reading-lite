import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { prepareFreshMarkdown } from "../../../../scripts/corpus-lib/batch/fresh-markdown";
import { urlHash } from "../../../../scripts/corpus-lib/url-hash";
import type { Manifest } from "../../../../src/schemas/manifest";
import type { MarkdownArticle } from "../../../../scripts/import-markdown-lib/parse";

function article(over: Partial<MarkdownArticle> = {}): MarkdownArticle {
  const markdown = over.markdown ?? "# Title\n\n**Source:** https://example.com/a\n\nbody";
  return {
    filePath: `/tmp/${over.fileName ?? "a.md"}`,
    fileName: over.fileName ?? "a.md",
    markdown,
    bytes: Buffer.byteLength(markdown, "utf8"),
    title: over.title ?? "Title",
    sourceUrl: over.sourceUrl ?? "https://example.com/a",
    ...over,
  };
}

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_old",
    url: "https://example.com/a",
    url_hash: urlHash("https://example.com/a"),
    status: "failed",
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...over,
  } as Manifest;
}

function deps(over: {
  pointers?: Record<string, { id: string; key_prefix: string }>;
  manifests?: Record<string, Manifest>;
} = {}) {
  const pointers = over.pointers ?? {};
  const manifests = over.manifests ?? {};
  return {
    readPointer: vi.fn(async (hash: string) => pointers[hash] ?? null),
    readManifest: vi.fn(async (keyPrefix: string) => manifests[keyPrefix] ?? null),
    now: () => "2026-06-22T00:00:00.000Z",
    newId: () => "rd_new",
  };
}

describe("prepareFreshMarkdown — unclaimed URL", () => {
  it("mints a fresh target with markdown ExtractedContent byte-compatible with the import endpoint", async () => {
    const md = "# Title\n\n**Source:** https://example.com/a\n\nbody";
    const result = await prepareFreshMarkdown([article({ markdown: md })], deps());

    expect(result.skipped).toHaveLength(0);
    expect(result.targets).toHaveLength(1);
    const t = result.targets[0]!;

    // New id + key prefix minted from injected now/newId.
    expect(t.target.readingId).toBe("rd_new");
    expect(t.target.createdAt).toBe("2026-06-22T00:00:00.000Z");
    expect(t.target.keyPrefix).toBe("readings/2026/06/22T000000Z-rd_new");
    expect(t.target.urlHash).toBe(urlHash("https://example.com/a"));

    // Synthetic manifest is a pending markdown source (so submit-phase stamps
    // source_type: "markdown" and keeps no ready snapshot).
    expect(t.target.manifest.source_type).toBe("markdown");
    expect(t.target.manifest.status).toBe("pending");

    // ExtractedContent built from the markdown in hand: raw = markdown bytes,
    // markdown content type, sha/bytes matching the realtime import contract.
    expect(t.markdown).toBe(md);
    expect(t.title).toBe("Title");
    expect(t.fresh).toBeDefined();
    expect(t.fresh!.content_type).toBe("text/markdown; charset=utf-8");
    expect(t.fresh!.content_status).toBe("captured");
    expect(t.fresh!.content_bytes).toBe(Buffer.byteLength(md, "utf8"));
    expect(t.fresh!.content_sha256).toBe(createHash("sha256").update(md, "utf8").digest("hex"));
    expect(new TextDecoder().decode(t.fresh!.raw)).toBe(md);
  });
});

describe("prepareFreshMarkdown — idempotency", () => {
  const hash = urlHash("https://example.com/a");

  it("skips a ready owner without re-summarizing it", async () => {
    const result = await prepareFreshMarkdown(
      [article()],
      deps({
        pointers: { [hash]: { id: "rd_old", key_prefix: "readings/kp-old" } },
        manifests: { "readings/kp-old": manifest({ status: "ready" }) },
      }),
    );
    expect(result.targets).toHaveLength(0);
    expect(result.skipped).toEqual([
      { url: "https://example.com/a", reason: "already-ready", readingId: "rd_old" },
    ]);
  });

  it("skips a pending owner (a realtime submit may be in flight)", async () => {
    const result = await prepareFreshMarkdown(
      [article()],
      deps({
        pointers: { [hash]: { id: "rd_old", key_prefix: "readings/kp-old" } },
        manifests: { "readings/kp-old": manifest({ status: "pending" }) },
      }),
    );
    expect(result.targets).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({ reason: "pending-in-flight", readingId: "rd_old" });
  });

  it("re-ingests a failed owner in place, reusing its id / key_prefix / created_at", async () => {
    const result = await prepareFreshMarkdown(
      [article()],
      deps({
        pointers: { [hash]: { id: "rd_old", key_prefix: "readings/kp-old" } },
        manifests: { "readings/kp-old": manifest({ status: "failed" }) },
      }),
    );
    expect(result.skipped).toHaveLength(0);
    expect(result.targets).toHaveLength(1);
    const t = result.targets[0]!;
    expect(t.target.readingId).toBe("rd_old");
    expect(t.target.keyPrefix).toBe("readings/kp-old");
    expect(t.target.createdAt).toBe("2026-01-01T00:00:00.000Z");
    // Re-ingest still summarizes from the fresh markdown as a markdown source.
    expect(t.target.manifest.source_type).toBe("markdown");
    expect(t.fresh).toBeDefined();
  });

  it("re-ingests a dangling pointer (manifest gone) using now() for created_at", async () => {
    const result = await prepareFreshMarkdown(
      [article()],
      deps({ pointers: { [hash]: { id: "rd_old", key_prefix: "readings/kp-old" } } }),
    );
    expect(result.targets).toHaveLength(1);
    const t = result.targets[0]!;
    expect(t.target.readingId).toBe("rd_old");
    expect(t.target.createdAt).toBe("2026-06-22T00:00:00.000Z");
  });

  it("skips articles without a source url", async () => {
    const result = await prepareFreshMarkdown([article({ sourceUrl: undefined })], deps());
    expect(result.targets).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});
