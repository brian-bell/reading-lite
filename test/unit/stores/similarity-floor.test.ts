import { describe, expect, it } from "vitest";
import { SIMILARITY_FLOOR, aboveFloor, type SimilarityMatch } from "../../../src/modules/stores/similarity";

const m = (id: string, score: number): SimilarityMatch => ({ id, score, url: `https://x/${id}` });

describe("aboveFloor", () => {
  it("keeps neighbours at or above the floor", () => {
    const out = aboveFloor([m("a", 0.9), m("b", SIMILARITY_FLOOR)], SIMILARITY_FLOOR);
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("drops neighbours below the floor", () => {
    const out = aboveFloor([m("a", 0.9), m("far", 0.1)], SIMILARITY_FLOOR);
    expect(out.map((x) => x.id)).toEqual(["a"]);
  });

  it("returns an empty neighbourhood when nothing clears the floor", () => {
    // This is the case that matters: it is what lets a genuinely novel reading
    // reach the "no prior readings" prompt branch instead of being handed five
    // unrelated titles under a heading that presupposes relatedness.
    expect(aboveFloor([m("a", 0.05), m("b", 0.02)], SIMILARITY_FLOOR)).toEqual([]);
  });

  it("handles an empty input", () => {
    expect(aboveFloor([], SIMILARITY_FLOOR)).toEqual([]);
  });
});
