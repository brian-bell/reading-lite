import { describe, expect, it } from "vitest";
import { LIBRARIAN_INSTRUCTIONS } from "../../../src/modules/summarizer/instructions";

describe("novelty instructions", () => {
  it("anchors the verdict to the listed neighbours rather than the whole library", () => {
    // The neighbour list is now floored by measured similarity, so "nothing
    // listed" is a real signal. The old wording asked about "the user's prior
    // library" in the abstract, which the model cannot observe.
    expect(LIBRARIAN_INSTRUCTIONS).toMatch(/listed/i);
  });

  it("states that an empty list means novel, so the verdict is reachable", () => {
    expect(LIBRARIAN_INSTRUCTIONS).toMatch(/empty[\s\S]{0,120}novel|novel[\s\S]{0,120}empty/i);
  });

  it("no longer biases both alternatives away from familiar", () => {
    // The old line -- 'prefer "familiar" to "novel" when in doubt' -- discouraged
    // both exits at once and made familiar the default sink.
    expect(LIBRARIAN_INSTRUCTIONS).not.toMatch(/prefer\s+"familiar"\s+to\s+"novel"/i);
  });

  it("keeps duplicate strict", () => {
    expect(LIBRARIAN_INSTRUCTIONS).toMatch(/duplicate/i);
    expect(LIBRARIAN_INSTRUCTIONS).toMatch(/same piece/i);
  });

  it("tells the model the similarity figures are evidence", () => {
    expect(LIBRARIAN_INSTRUCTIONS).toMatch(/similarity/i);
  });

  it("warns against calling something familiar merely for sharing a subject area", () => {
    expect(LIBRARIAN_INSTRUCTIONS).toMatch(/subject area|broadly|topic is/i);
  });
});
