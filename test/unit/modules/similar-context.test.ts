import { describe, expect, it, vi } from "vitest";
import { SimilarityStore } from "../../../src/modules/stores/similarity-store";
import { EMBEDDING_DIM } from "../../../src/schemas/api";

const vec = () => Array.from({ length: EMBEDDING_DIM }, () => 0.1);

function indexReturning(matches: unknown[]) {
  const upsert = vi.fn(async (vs: VectorizeVector[]) => {
    void vs;
    return { mutationId: "m" } as VectorizeAsyncMutation;
  });
  const query = vi.fn(async () => ({ count: matches.length, matches }) as unknown as VectorizeMatches);
  return {
    index: { upsert, query, deleteByIds: vi.fn() } as unknown as VectorizeIndex,
    upsert,
  };
}

describe("SimilarityStore tldr metadata", () => {
  it("stores the tldr on the vector so neighbours can be described, not just named", async () => {
    const { index, upsert } = indexReturning([]);
    await new SimilarityStore(index).upsert("rd_a", vec(), {
      url: "https://a.com",
      title: "A",
      tldr: "A short summary of A.",
    });
    expect(upsert.mock.calls[0]![0][0]!.metadata).toMatchObject({ tldr: "A short summary of A." });
  });

  it("reads the tldr back off a match", async () => {
    const { index } = indexReturning([
      { id: "rd_b", score: 0.8, metadata: { url: "https://b.com", title: "B", tldr: "About B." } },
    ]);
    const out = await new SimilarityStore(index).query(vec(), 5);
    expect(out[0]).toMatchObject({ id: "rd_b", score: 0.8, tldr: "About B." });
  });

  it("defaults omitted url metadata to an empty string", async () => {
    const { index } = indexReturning([{ id: "rd_bare", score: 0.9, metadata: { title: "Bare" } }]);
    const out = await new SimilarityStore(index).query(vec(), 5);
    expect(out[0]).toMatchObject({ id: "rd_bare", url: "" });
  });

  it("tolerates a vector written before tldr was stored", async () => {
    const { index } = indexReturning([
      { id: "rd_old", score: 0.5, metadata: { url: "https://old.com", title: "Old" } },
    ]);
    const out = await new SimilarityStore(index).query(vec(), 5);
    expect(out[0]!.tldr).toBeUndefined();
    expect(out[0]!.title).toBe("Old");
  });

  it("ignores a non-string tldr rather than passing junk to the prompt", async () => {
    const { index } = indexReturning([
      { id: "rd_x", score: 0.5, metadata: { url: "https://x.com", tldr: 42 } },
    ]);
    const out = await new SimilarityStore(index).query(vec(), 5);
    expect(out[0]!.tldr).toBeUndefined();
  });

  it("omits tldr from metadata when the reading has none", async () => {
    const { index, upsert } = indexReturning([]);
    await new SimilarityStore(index).upsert("rd_a", vec(), { url: "https://a.com" });
    expect(upsert.mock.calls[0]![0][0]!.metadata).not.toHaveProperty("tldr");
  });
});
