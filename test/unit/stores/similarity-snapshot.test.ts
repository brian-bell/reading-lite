import { describe, expect, it } from "vitest";
import { excludeSelf, summarizeSimilarity } from "../../../src/modules/stores/similarity";
import type { SimilarityMatch } from "../../../src/modules/stores/similarity";

const AT = "2026-08-22T00:00:00.000Z";
const m = (id: string, score: number): SimilarityMatch => ({ id, score, url: `https://x/${id}` });

describe("summarizeSimilarity", () => {
  it("records the max, mean and count of the neighbours considered", () => {
    const s = summarizeSimilarity([m("a", 0.9), m("b", 0.7), m("c", 0.5)], AT);
    expect(s.count).toBe(3);
    expect(s.max).toBeCloseTo(0.9, 10);
    expect(s.mean).toBeCloseTo(0.7, 10);
    expect(s.computed_at).toBe(AT);
  });

  it("stamps when it was computed, so a stale score is detectable", () => {
    expect(summarizeSimilarity([m("a", 0.4)], AT).computed_at).toBe(AT);
  });

  it("reports an empty neighbourhood as count 0 without inventing a score", () => {
    const s = summarizeSimilarity([], AT);
    expect(s.count).toBe(0);
    expect(s.max).toBeUndefined();
    expect(s.mean).toBeUndefined();
  });

  it("handles a single neighbour", () => {
    const s = summarizeSimilarity([m("a", 0.42)], AT);
    expect(s.count).toBe(1);
    expect(s.max).toBeCloseTo(0.42, 10);
    expect(s.mean).toBeCloseTo(0.42, 10);
  });

  it("does not assume the matches arrive sorted", () => {
    expect(summarizeSimilarity([m("a", 0.3), m("b", 0.95), m("c", 0.6)], AT).max).toBeCloseTo(0.95, 10);
  });

  it("tolerates negative cosine scores", () => {
    const s = summarizeSimilarity([m("a", -0.2), m("b", 0.4)], AT);
    expect(s.max).toBeCloseTo(0.4, 10);
    expect(s.mean).toBeCloseTo(0.1, 10);
  });
});

describe("excludeSelf", () => {
  it("drops the reading's own vector from its neighbourhood", () => {
    const out = excludeSelf([m("self", 1), m("a", 0.8)], "self", 5);
    expect(out.map((x) => x.id)).toEqual(["a"]);
  });

  it("still returns a full neighbourhood when self was among the results", () => {
    // The reprocess case: the reading's own vector is already indexed and
    // scores 1.0, so a bare topK query spends a slot on it. Over-fetching by
    // one keeps a reprocessed reading comparable to a freshly-submitted one.
    const raw = [m("self", 1), m("a", 0.9), m("b", 0.8), m("c", 0.7), m("d", 0.6), m("e", 0.5)];
    const out = excludeSelf(raw, "self", 5);
    expect(out).toHaveLength(5);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("caps at the limit when self is absent, discarding the over-fetched extra", () => {
    const raw = [m("a", 0.9), m("b", 0.8), m("c", 0.7), m("d", 0.6), m("e", 0.5), m("f", 0.4)];
    const out = excludeSelf(raw, "self", 5);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("handles an empty result set", () => {
    expect(excludeSelf([], "self", 5)).toEqual([]);
  });
});
