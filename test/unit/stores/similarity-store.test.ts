import { describe, expect, it, vi } from "vitest";
import {
  SimilarityStore,
  WrongEmbeddingDimensionError,
} from "../../../src/modules/stores/similarity-store";

function makeBinding(opts: {
  upsertResult?: VectorizeAsyncMutation;
  queryResult?: VectorizeMatches;
} = {}) {
  return {
    upsert: vi.fn(async (_v: VectorizeVector[]): Promise<VectorizeAsyncMutation> =>
      opts.upsertResult ?? ({ mutationId: "m_1" } as VectorizeAsyncMutation),
    ),
    query: vi.fn(async (_v: number[], _o: VectorizeQueryOptions): Promise<VectorizeMatches> =>
      opts.queryResult ?? { count: 0, matches: [] },
    ),
    deleteByIds: vi.fn(async (_ids: string[]): Promise<VectorizeAsyncMutation> =>
      ({ mutationId: "m_1" } as VectorizeAsyncMutation),
    ),
  } as unknown as VectorizeIndex & {
    upsert: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    deleteByIds: ReturnType<typeof vi.fn>;
  };
}

const fullEmbedding = (fill = 0.1) => new Array(1536).fill(fill);

describe("SimilarityStore.upsert", () => {
  it("upserts an id + embedding + metadata to Vectorize", async () => {
    const binding = makeBinding();
    const store = new SimilarityStore(binding);
    await store.upsert("rd_X", fullEmbedding(), {
      url: "https://example.com/a",
      title: "X",
      tags: ["t1"],
      created_at: "2026-04-26T20:00:00.000Z",
    });
    expect(binding.upsert).toHaveBeenCalledOnce();
    const arg = binding.upsert.mock.calls[0]![0] as VectorizeVector[];
    expect(arg).toHaveLength(1);
    expect(arg[0]!.id).toBe("rd_X");
    expect(arg[0]!.values).toEqual(fullEmbedding());
    expect(arg[0]!.metadata).toEqual({
      url: "https://example.com/a",
      title: "X",
      tags: ["t1"],
      created_at: "2026-04-26T20:00:00.000Z",
    });
  });

  it("rejects an embedding with wrong dimension", async () => {
    const binding = makeBinding();
    const store = new SimilarityStore(binding);
    await expect(
      store.upsert("rd_X", new Array(768).fill(0), { url: "https://example.com/a" }),
    ).rejects.toBeInstanceOf(WrongEmbeddingDimensionError);
    expect(binding.upsert).not.toHaveBeenCalled();
  });
});

describe("SimilarityStore.delete", () => {
  it("deletes the vector by reading id", async () => {
    const binding = makeBinding();
    const store = new SimilarityStore(binding);
    await store.delete("rd_X");
    expect(binding.deleteByIds).toHaveBeenCalledWith(["rd_X"]);
  });

  it("submits deleteByIds in 1000-id batches and returns mutationIds", async () => {
    const binding = makeBinding();
    const store = new SimilarityStore(binding);
    const ids = Array.from({ length: 1001 }, (_, i) => `rd_${String(i).padStart(10, "0")}`);
    const mutations = await store.deleteMany(ids);
    expect(binding.deleteByIds).toHaveBeenCalledTimes(2);
    expect((binding.deleteByIds.mock.calls[0]![0] as string[]).length).toBe(1000);
    expect((binding.deleteByIds.mock.calls[1]![0] as string[]).length).toBe(1);
    expect(mutations).toEqual(["m_1", "m_1"]);
  });
});

describe("SimilarityStore.query", () => {
  it("calls Vectorize with topK and returnMetadata, returns mapped items", async () => {
    const binding = makeBinding({
      queryResult: {
        count: 2,
        matches: [
          {
            id: "rd_a",
            score: 0.95,
            metadata: { url: "https://example.com/a", title: "A", tags: ["t"], created_at: "2026-04-25T00:00:00.000Z" },
          },
          {
            id: "rd_b",
            score: 0.81,
            metadata: { url: "https://example.com/b" },
          },
        ],
      },
    });
    const store = new SimilarityStore(binding);
    const out = await store.query(fullEmbedding(0.2), 5);
    expect(binding.query).toHaveBeenCalledOnce();
    const queryArgs = binding.query.mock.calls[0]!;
    expect(queryArgs[0]).toEqual(fullEmbedding(0.2));
    expect(queryArgs[1]).toMatchObject({ topK: 5, returnMetadata: true });
    expect(out).toEqual([
      {
        id: "rd_a",
        score: 0.95,
        url: "https://example.com/a",
        title: "A",
        tags: ["t"],
        created_at: "2026-04-25T00:00:00.000Z",
      },
      {
        id: "rd_b",
        score: 0.81,
        url: "https://example.com/b",
      },
    ]);
  });

  it("returns an empty array when there are no matches", async () => {
    const binding = makeBinding({ queryResult: { count: 0, matches: [] } });
    const store = new SimilarityStore(binding);
    const out = await store.query(fullEmbedding(), 10);
    expect(out).toEqual([]);
  });

  it("rejects a query embedding with wrong dimension", async () => {
    const binding = makeBinding();
    const store = new SimilarityStore(binding);
    await expect(store.query(new Array(768).fill(0), 5)).rejects.toBeInstanceOf(
      WrongEmbeddingDimensionError,
    );
    expect(binding.query).not.toHaveBeenCalled();
  });

  it("clamps topK to the 1..50 range", async () => {
    const binding = makeBinding();
    const store = new SimilarityStore(binding);
    await store.query(fullEmbedding(), 0);
    expect(binding.query.mock.calls[0]![1]).toMatchObject({ topK: 1 });
    await store.query(fullEmbedding(), 999);
    expect(binding.query.mock.calls[1]![1]).toMatchObject({ topK: 50 });
  });
});

describe("SimilarityStore.queryByVectorId", () => {
  it("uses a composed vector id and namespace, returns bare ids and metadata", async () => {
    const binding = {
      getByIds: vi.fn(async () => [{ id: "tenant:rd_a" }]),
      queryById: vi.fn(async () => ({ matches: [
        { id: "tenant:rd_b", score: 0.8, metadata: { url: "https://example.com", title: "B" } },
      ] })),
    };
    const store = new SimilarityStore(binding as unknown as VectorizeIndex, "tenant");
    expect(await store.queryByVectorId("rd_a", 6)).toEqual([
      { id: "rd_b", score: 0.8, url: "https://example.com", title: "B" },
    ]);
    expect(binding.getByIds).toHaveBeenCalledWith(["tenant:rd_a"]);
    expect(binding.queryById).toHaveBeenCalledWith("tenant:rd_a", {
      topK: 6, namespace: "tenant", returnMetadata: "all",
    });
  });

  it("distinguishes absent vectors from binding failures", async () => {
    const binding = { getByIds: vi.fn(async () => []), queryById: vi.fn() };
    const store = new SimilarityStore(binding as unknown as VectorizeIndex);
    expect(await store.queryByVectorId("rd_a", 6)).toBeNull();
    expect(binding.queryById).not.toHaveBeenCalled();
    binding.getByIds.mockRejectedValueOnce(new Error("unavailable"));
    await expect(store.queryByVectorId("rd_a", 6)).rejects.toThrow("unavailable");
  });
});
