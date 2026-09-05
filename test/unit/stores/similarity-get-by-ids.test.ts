// `SimilarityStore.getByIds` — the read the vector ledger clears rows on.
//
// Two properties are load-bearing and neither is a nicety, because the
// confirmation rule reads absence as permission to forget an id: once a ledger
// row is cleared and the reading's R2 objects are gone, a vector that was
// actually still live can never be addressed again.

import { describe, expect, it, vi } from "vitest";
import {
  SimilarityStore,
  VECTORIZE_GET_BY_IDS_MAX_IDS,
} from "../../../src/modules/stores/similarity-store";

const TENANT = "usr_11111111-1111-4111-8111-111111111111";

function fakeIndex(impl: (ids: string[]) => Promise<Array<{ id: string }>>) {
  const getByIds = vi.fn(impl);
  return { index: { getByIds } as unknown as VectorizeIndex, getByIds };
}

describe("SimilarityStore.getByIds", () => {
  it("chunks at the measured REST cap rather than deleteByIds' 1000", async () => {
    // S6 §3.6 measured the v2 REST cap at 20: 25 ids answer 400 with an empty
    // body, which reads exactly like "none of these exists". The Workers
    // binding's own cap is unverified, so it uses the same conservative number.
    const { index, getByIds } = fakeIndex(async (ids) => {
      expect(ids.length).toBeLessThanOrEqual(VECTORIZE_GET_BY_IDS_MAX_IDS);
      return [];
    });
    const ids = Array.from({ length: 45 }, (_, i) => `rd_${i}`);
    await new SimilarityStore(index, TENANT).getByIds(ids);
    expect(getByIds.mock.calls.map((c) => (c[0] as string[]).length)).toEqual([20, 20, 5]);
  });

  it("sends tenant-composed ids and returns bare reading ids", async () => {
    // The `{tenantId}:{readingId}` composition never escapes this class, so the
    // ledger stores and compares bare ids and there is only one spelling of the
    // rule (`tenantVectorId`) that could drift.
    const { index, getByIds } = fakeIndex(async (ids) => ids.map((id) => ({ id })));
    const out = await new SimilarityStore(index, TENANT).getByIds(["rd_a", "rd_b"]);
    expect(getByIds).toHaveBeenCalledWith([`${TENANT}:rd_a`, `${TENANT}:rd_b`]);
    expect(out).toEqual(["rd_a", "rd_b"]);
  });

  it("uses bare ids with no namespace, matching the pre-tenant layout", async () => {
    const { index, getByIds } = fakeIndex(async (ids) => ids.map((id) => ({ id })));
    const out = await new SimilarityStore(index).getByIds(["rd_a"]);
    expect(getByIds).toHaveBeenCalledWith(["rd_a"]);
    expect(out).toEqual(["rd_a"]);
  });

  it("returns only the ids the index actually holds", async () => {
    const { index } = fakeIndex(async (ids) =>
      ids.filter((id) => id.endsWith("rd_live")).map((id) => ({ id })),
    );
    expect(await new SimilarityStore(index, TENANT).getByIds(["rd_live", "rd_gone"])).toEqual([
      "rd_live",
    ]);
  });

  it("propagates a failure instead of answering 'nothing found'", async () => {
    // The one thing this method must never do. A swallowed error returning `[]`
    // reads as "every id is gone" and clears ledger rows for vectors that are
    // still live — unrecoverable, because the ledger is the only id source left
    // once R2 is empty. The caller's rule treats a failed call as no
    // information, and it can only do that if the failure reaches it.
    const { index } = fakeIndex(async () => {
      throw new Error("429 rate limited");
    });
    await expect(new SimilarityStore(index, TENANT).getByIds(["rd_a"])).rejects.toThrow(
      /429 rate limited/,
    );
  });

  it("throws rather than reporting an empty result on a binding that cannot answer", async () => {
    const index = {} as unknown as VectorizeIndex;
    await expect(new SimilarityStore(index, TENANT).getByIds(["rd_a"])).rejects.toThrow(
      /no getByIds/,
    );
  });

  it("makes no request at all for an empty id list", async () => {
    const { index, getByIds } = fakeIndex(async () => []);
    expect(await new SimilarityStore(index, TENANT).getByIds([])).toEqual([]);
    expect(getByIds).not.toHaveBeenCalled();
  });
});
