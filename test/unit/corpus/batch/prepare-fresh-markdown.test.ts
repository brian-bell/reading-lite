import { describe, expect, it, vi } from "vitest";
import {
  prepareFreshMarkdown,
  type FreshMarkdownArticle,
  type PrepareFreshDeps,
} from "../../../../scripts/corpus-lib/batch/prepare-fresh-markdown";
import { ManifestSchema, type Manifest } from "../../../../src/schemas/manifest";

const NOW = "2026-06-22T12:00:00.000Z";

function article(over: Partial<FreshMarkdownArticle> = {}): FreshMarkdownArticle {
  return {
    sourceUrl: "https://example.com/a",
    markdown: "# A\n\n**Source:** https://example.com/a\n\nbody",
    title: "A",
    ...over,
  };
}

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_existing",
    url: "https://example.com/a",
    url_hash: "a".repeat(64),
    source_type: "url",
    status: "failed",
    content_type: "text/html",
    content_status: "failed",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...over,
  } as Manifest;
}

// Deterministic ids + a stable url-hash so assertions are simple.
function makeDeps(over: Partial<PrepareFreshDeps> = {}): PrepareFreshDeps {
  let n = 0;
  return {
    readByUrlPointer: vi.fn(async () => null),
    readManifest: vi.fn(async () => null),
    mintId: vi.fn(() => `rd_new${n++}`),
    now: () => NOW,
    sha256: vi.fn(async (input: string) => {
      // Deterministic but schema-valid (64 lowercase hex chars).
      let h = 0;
      for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0;
      return h.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
    }),
    ...over,
  };
}

describe("prepareFreshMarkdown", () => {
  it("mints a fresh target for an unclaimed URL", async () => {
    const deps = makeDeps();
    const { targets, skipped, dropped } = await prepareFreshMarkdown([article()], deps);

    expect(skipped).toHaveLength(0);
    expect(dropped).toHaveLength(0);
    expect(targets).toHaveLength(1);
    const t = targets[0]!;
    expect(t.target.readingId).toBe("rd_new0");
    expect(t.target.url).toBe("https://example.com/a");
    expect(t.target.createdAt).toBe(NOW);
    expect(t.target.keyPrefix).toMatch(/^readings\/.*-rd_new0$/);
    expect(t.target.manifest.source_type).toBe("markdown");
    expect(t.markdown).toContain("body");
    expect(t.title).toBe("A");
  });

  it("builds a fresh ExtractedContent that carries the markdown as raw + extracted", async () => {
    const deps = makeDeps();
    const { targets } = await prepareFreshMarkdown([article({ markdown: "hello md" })], deps);
    const fresh = targets[0]!.fresh!;
    expect(fresh).toBeDefined();
    expect(fresh.content_type).toBe("text/markdown; charset=utf-8");
    expect(fresh.content_status).toBe("captured");
    expect(fresh.content_bytes).toBe(new TextEncoder().encode("hello md").byteLength);
    expect(new TextDecoder().decode(fresh.raw)).toBe("hello md");
    expect(fresh.markdown).toBe("hello md");
  });

  it("skips a ready owner (no re-summarize, no duplicate)", async () => {
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => ({ id: "rd_existing", key_prefix: "readings/kp-existing" })),
      readManifest: vi.fn(async () => manifest({ status: "ready", content_status: "captured" })),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(targets).toHaveLength(0);
    expect(skipped).toEqual([
      { url: "https://example.com/a", reason: "already-ready" },
    ]);
  });

  it("skips a pending owner with an in-flight warning", async () => {
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => ({ id: "rd_existing", key_prefix: "readings/kp-existing" })),
      readManifest: vi.fn(async () => manifest({ status: "pending" })),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(targets).toHaveLength(0);
    expect(skipped).toEqual([
      { url: "https://example.com/a", reason: "pending-in-flight" },
    ]);
  });

  it("re-ingests a failed owner in place, reusing its id/key_prefix/created_at", async () => {
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => ({ id: "rd_existing", key_prefix: "readings/kp-existing" })),
      readManifest: vi.fn(async () =>
        manifest({ id: "rd_existing", status: "failed", created_at: "2025-12-01T00:00:00.000Z", url_hash: "f".repeat(64) }),
      ),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(skipped).toHaveLength(0);
    expect(targets).toHaveLength(1);
    const t = targets[0]!.target;
    expect(t.readingId).toBe("rd_existing");
    expect(t.keyPrefix).toBe("readings/kp-existing");
    expect(t.createdAt).toBe("2025-12-01T00:00:00.000Z");
    expect(t.urlHash).toBe("f".repeat(64));
    // re-ingest must flip source_type to markdown even over a url failure
    expect(t.manifest.source_type).toBe("markdown");
    expect(t.manifest.status).not.toBe("ready");
  });

  it("produces a target whose synthetic manifest is schema-valid", async () => {
    const deps = makeDeps();
    const { targets } = await prepareFreshMarkdown([article()], deps);
    expect(() => ManifestSchema.parse(targets[0]!.target.manifest)).not.toThrow();
  });

  it("uses sha256(sourceUrl) for the by-url pointer lookup", async () => {
    const readByUrlPointer = vi.fn(async () => null);
    const deps = makeDeps({ readByUrlPointer });
    await prepareFreshMarkdown([article({ sourceUrl: "https://x.test/y" })], deps);
    const expectedHash = await deps.sha256("https://x.test/y");
    expect(readByUrlPointer).toHaveBeenCalledWith(expectedHash);
  });
});
