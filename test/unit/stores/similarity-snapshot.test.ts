import { describe, expect, it } from "vitest";
import { summarizeSimilarity } from "../../../src/modules/stores/similarity-store";
import type { SimilarityMatch } from "../../../src/modules/stores/similarity-store";

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
