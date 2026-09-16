import { describe, expect, it } from "vitest";
import { libraryReturnDelta, libraryReturnState } from "../src/library-return";
import { currentLoadId } from "../src/reading-trail";

// The way back to the library in history state (#407): the library entry to go
// back to, only from this document load.

/** A reading's state, `at` entries into history, opened from the library entry at index 1. */
function readingAt(at: number, load = currentLoadId()) {
  return { __TSR_index: at, libraryReturn: { load, index: 1 } };
}

describe("libraryReturnState", () => {
  it("records the library entry's history position, stamped with this load", () => {
    expect(libraryReturnState({ __TSR_index: 3 })).toEqual({
      libraryReturn: { load: currentLoadId(), index: 3 },
    });
  });

  it("records nothing without a history position", () => {
    expect(libraryReturnState(undefined)).toEqual({});
  });
});

describe("libraryReturnDelta", () => {
  it.each([
    ["the reading opened from it", 2, -1],
    ["a reading two hops on", 4, -3],
  ])("goes back to the library entry from %s", (_, at, delta) => {
    expect(libraryReturnDelta(readingAt(at))).toBe(delta);
  });

  it.each([
    ["no record, as a direct link has", { __TSR_index: 2 }],
    ["a record another document load wrote, as after a reload", readingAt(2, "an earlier load")],
    ["a record that does not point behind this entry", readingAt(1)],
    ["no state at all", undefined],
  ])("has nowhere to go back to with %s", (_, state) => {
    expect(libraryReturnDelta(state)).toBeUndefined();
  });
});
