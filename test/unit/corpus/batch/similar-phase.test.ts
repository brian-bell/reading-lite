import { describe, expect, it, vi } from "vitest";
import { resolveSimilar } from "../../../../scripts/corpus-lib/batch/similar-phase";
import type { ExtractedTarget } from "../../../../scripts/corpus-lib/batch/types";
import type { Manifest } from "../../../../src/schemas/manifest";

function extractedTarget(id: string, markdown: string): ExtractedTarget {
  const manifest = {
    id,
    url: `https://example.com/${id}`,
    url_hash: "a".repeat(64),
    status: "failed",
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 1,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  } as Manifest;
  return {
    target: {
      readingId: id,
      url: manifest.url,
      urlHash: manifest.url_hash,
      keyPrefix: `readings/x-${id}`,
      createdAt: manifest.created_at,
      manifest,
    },
    markdown,
  };
}

describe("resolveSimilar", () => {
  it("embeds each target's text and attaches top-K similar context", async () => {
    const embedMany = vi.fn(async (inputs: string[]) => ({
      embeddings: inputs.map((_, i) => [i]),
      tokensByInput: inputs.map(() => 7),
    }));
    const query = vi.fn(async () => [
      { id: "rd_other", score: 0.9, metadata: { url: "https://example.com/other", title: "Other" } },
    ]);
    const out = await resolveSimilar([extractedTarget("rd_a", "body a")], { embedMany, query });
    expect(embedMany).toHaveBeenCalledWith(["body a"]);
    expect(out).toHaveLength(1);
    expect(out[0]!.similar).toEqual([
      { id: "rd_other", url: "https://example.com/other", title: "Other" },
    ]);
    // The query-embedding token count rides along for the write phase.
    expect(out[0]!.queryEmbedTokens).toBe(7);
  });

  it("filters the target itself out of its own similar set", async () => {
    const embedMany = vi.fn(async (inputs: string[]) => ({
      embeddings: inputs.map(() => [0]),
      tokensByInput: inputs.map(() => 1),
    }));
    const query = vi.fn(async () => [
      { id: "rd_a", score: 1, metadata: { url: "https://example.com/rd_a" } },
      { id: "rd_b", score: 0.8, metadata: { url: "https://example.com/rd_b", title: "B" } },
    ]);
    const out = await resolveSimilar([extractedTarget("rd_a", "x")], { embedMany, query });
    expect(out[0]!.similar.map((s) => s.id)).toEqual(["rd_b"]);
  });

  it("truncates long markdown before embedding", async () => {
    const embedMany = vi.fn(async (inputs: string[]) => ({
      embeddings: inputs.map(() => [0]),
      tokensByInput: inputs.map(() => 1),
    }));
    const query = vi.fn(async () => []);
    const long = "z".repeat(20000);
    await resolveSimilar([extractedTarget("rd_a", long)], { embedMany, query });
    const sent = embedMany.mock.calls[0]![0]![0]!;
    expect(sent.length).toBeLessThan(long.length);
  });

  it("returns empty similar when the index has no matches", async () => {
    const embedMany = vi.fn(async (inputs: string[]) => ({
      embeddings: inputs.map(() => [0]),
      tokensByInput: inputs.map(() => 1),
    }));
    const query = vi.fn(async () => []);
    const out = await resolveSimilar([extractedTarget("rd_a", "x")], { embedMany, query });
    expect(out[0]!.similar).toEqual([]);
  });
});
