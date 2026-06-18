import { describe, expect, it } from "vitest";
import { shouldPauseAfter } from "../../../scripts/corpus-lib/throttle";

describe("shouldPauseAfter", () => {
  it("pauses on each wave boundary", () => {
    // wave of 3: pause after submitting #3 and #6, not in between.
    expect(shouldPauseAfter(1, 3)).toBe(false);
    expect(shouldPauseAfter(2, 3)).toBe(false);
    expect(shouldPauseAfter(3, 3)).toBe(true);
    expect(shouldPauseAfter(4, 3)).toBe(false);
    expect(shouldPauseAfter(6, 3)).toBe(true);
  });

  it("never pauses when wave size is unbounded or non-positive", () => {
    expect(shouldPauseAfter(3, Infinity)).toBe(false);
    expect(shouldPauseAfter(3, 0)).toBe(false);
    expect(shouldPauseAfter(3, -1)).toBe(false);
  });

  it("does not pause before anything has been submitted", () => {
    expect(shouldPauseAfter(0, 3)).toBe(false);
  });
});
