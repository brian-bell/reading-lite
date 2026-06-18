import { describe, expect, it, vi } from "vitest";
import { extractTargets } from "../../../../scripts/corpus-lib/batch/extract-phase";
import type { BatchTarget } from "../../../../scripts/corpus-lib/batch/types";
import type { Manifest } from "../../../../src/schemas/manifest";
import type { ExtractedContent } from "../../../../src/modules/extractor";

function target(over: Partial<Manifest> = {}): BatchTarget {
  const manifest = {
    id: "rd_a",
    url: "https://example.com/a",
    url_hash: "a".repeat(64),
    status: "failed",
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    title: "Existing Title",
    ...over,
  } as Manifest;
  return {
    readingId: manifest.id,
    url: manifest.url,
    urlHash: manifest.url_hash,
    keyPrefix: "readings/2026/01/01T000000Z-rd_a",
    createdAt: manifest.created_at,
    manifest,
  };
}

const freshContent: ExtractedContent = {
  raw: new TextEncoder().encode("# Fresh\n\nbody"),
  content_type: "text/html",
  content_status: "captured",
  content_bytes: 13,
  content_sha256: "c".repeat(64),
  markdown: "# Fresh\n\nbody",
  title: "Fresh Title",
};

describe("extractTargets", () => {
  it("reuses R2 extracted.md for a ready+captured reading, without re-fetching", async () => {
    const loadExtracted = vi.fn(async () => "# Saved\n\nmarkdown body");
    const extract = vi.fn(async () => freshContent);
    const { extracted, dropped } = await extractTargets([target({ status: "ready" })], { loadExtracted, extract });
    expect(dropped).toHaveLength(0);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]!.markdown).toBe("# Saved\n\nmarkdown body");
    expect(extracted[0]!.title).toBe("Existing Title");
    expect(extracted[0]!.fresh).toBeUndefined();
    expect(extract).not.toHaveBeenCalled();
  });

  it("fresh-extracts a non-ready reading even when extracted.md exists (failed manifests have zeroed descriptors)", async () => {
    const loadExtracted = vi.fn(async () => "# Stale saved\n\nbody");
    const extract = vi.fn(async () => freshContent);
    // default target() is status:"failed"
    const { extracted } = await extractTargets([target()], { loadExtracted, extract });
    expect(extract).toHaveBeenCalledWith("https://example.com/a");
    expect(loadExtracted).not.toHaveBeenCalled();
    expect(extracted[0]!.fresh).toBe(freshContent);
  });

  it("falls back to a fresh extract when no R2 markdown exists", async () => {
    const loadExtracted = vi.fn(async () => null);
    const extract = vi.fn(async () => freshContent);
    const { extracted } = await extractTargets([target()], { loadExtracted, extract });
    expect(extract).toHaveBeenCalledWith("https://example.com/a");
    expect(extracted[0]!.markdown).toBe("# Fresh\n\nbody");
    expect(extracted[0]!.title).toBe("Fresh Title");
    expect(extracted[0]!.fresh).toBe(freshContent);
  });

  it("drops a target whose fresh extract yields no captured markdown", async () => {
    const loadExtracted = vi.fn(async () => null);
    const extract = vi.fn(async () => ({ ...freshContent, content_status: "raw_only", markdown: undefined }) as ExtractedContent);
    const { extracted, dropped } = await extractTargets([target()], { loadExtracted, extract });
    expect(extracted).toHaveLength(0);
    expect(dropped[0]).toMatchObject({ readingId: "rd_a" });
  });

  it("drops a target when the extract throws, recording the error", async () => {
    const loadExtracted = vi.fn(async () => null);
    const extract = vi.fn(async () => {
      throw new Error("network down");
    });
    const { dropped } = await extractTargets([target()], { loadExtracted, extract });
    expect(dropped[0]).toMatchObject({ readingId: "rd_a", reason: expect.stringMatching(/network down/) });
  });

  it("treats blank R2 markdown as absent and re-extracts (ready reading)", async () => {
    const loadExtracted = vi.fn(async () => "   \n  ");
    const extract = vi.fn(async () => freshContent);
    const { extracted } = await extractTargets([target({ status: "ready" })], { loadExtracted, extract });
    expect(extract).toHaveBeenCalled();
    expect(extracted[0]!.fresh).toBe(freshContent);
  });
});
