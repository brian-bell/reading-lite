import { describe, expect, it } from "vitest";
import { EMBED_MAX_CHARS, truncateForEmbed } from "../../../src/process-reading";

describe("truncateForEmbed", () => {
  it("returns input unchanged when shorter than the cap", () => {
    expect(truncateForEmbed("hello")).toBe("hello");
  });

  it("returns input unchanged at exactly the cap", () => {
    const exact = "a".repeat(EMBED_MAX_CHARS);
    expect(truncateForEmbed(exact)).toBe(exact);
  });

  it("truncates inputs longer than the cap", () => {
    const tooBig = "a".repeat(EMBED_MAX_CHARS + 100);
    const out = truncateForEmbed(tooBig);
    expect(out.length).toBeLessThanOrEqual(EMBED_MAX_CHARS);
    expect(out).toBe("a".repeat(EMBED_MAX_CHARS));
  });

  it("does not leave a lone high surrogate when truncation lands inside a surrogate pair", () => {
    // "💩" (U+1F4A9) is encoded as a high+low UTF-16 surrogate pair (length 2).
    // Place exactly one pile-of-poo at index EMBED_MAX_CHARS - 1, so a naive
    // text.slice(0, EMBED_MAX_CHARS) would cut between the high and low halves
    // and leave a lone high surrogate at the end.
    const input = "a".repeat(EMBED_MAX_CHARS - 1) + "💩" + "tail";
    const out = truncateForEmbed(input);
    expect(out.length).toBeLessThanOrEqual(EMBED_MAX_CHARS);
    expect(/[\uD800-\uDBFF]$/.test(out)).toBe(false);
  });
});
