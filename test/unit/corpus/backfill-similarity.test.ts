import { describe, expect, it } from "vitest";
import { snapshotFor } from "../../../scripts/corpus-lib/backfill-similarity";

const AT = "2026-08-22T00:00:00.000Z";

describe("snapshotFor", () => {
  it("excludes the reading's own vector, which scores ~1 against itself", () => {
    const s = snapshotFor("rd_a", [{ id: "rd_a", score: 0.999 }, { id: "rd_b", score: 0.6 }], AT);
    expect(s.count).toBe(1);
    expect(s.max).toBeCloseTo(0.6, 10);
  });

  it("records an unscored empty neighbourhood rather than inventing one", () => {
    expect(snapshotFor("rd_a", [{ id: "rd_a", score: 1 }], AT)).toEqual({ count: 0, computed_at: AT });
  });

  it("caps at the shared neighbourhood size even if more were fetched", () => {
    const matches = [{ id: "rd_a", score: 1 }].concat(
      Array.from({ length: 8 }, (_, i) => ({ id: `rd_${i}`, score: 0.9 - i / 100 })),
    );
    expect(snapshotFor("rd_a", matches, AT).count).toBe(5);
  });
});
