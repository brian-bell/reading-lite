// Reading ids are `rd_` plus ten characters of one Crockford-style alphabet
// (no I, L, O or U). Parsing and minting share that alphabet exactly, so an id
// the service minted always parses, and anything else — including the shapes
// a hostile or corrupted R2 key could carry — is rejected as a whole.

import { describe, expect, it } from "vitest";
import { mintReadingId, parseReadingId } from "../../../src/services";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

describe("reading ids", () => {
  it("parses every character of the alphabet and none of the ambiguous letters", () => {
    for (const character of ALPHABET) {
      expect(parseReadingId(`rd_${character.repeat(10)}`)).toBe(`rd_${character.repeat(10)}`);
    }
    for (const character of ["I", "L", "O", "U"]) {
      expect(parseReadingId(`rd_${character.repeat(10)}`)).toBeNull();
    }
  });

  it("mints ids that parse back to themselves", () => {
    for (let index = 0; index < 100; index += 1) {
      const minted = mintReadingId();
      expect(minted).toMatch(/^rd_[0-9A-HJKMNP-TV-Z]{10}$/);
      expect(parseReadingId(minted)).toBe(minted);
    }
  });

  it.each([
    ["uppercase encoded slash", "rd_PREFIX%2Fbackup"],
    ["lowercase encoded slash", "rd_PREFIX%2fbackup"],
    ["literal slash", "rd_PREFIX/backup"],
    ["backslash", "rd_PREFIX\\backup"],
    ["colon", "rd_PREFIX:backup"],
    ["percent", "rd_PREFIX%backup"],
    ["dot segments", "rd_../backup"],
    ["query-like text", "rd_PREFIX?backup"],
    ["hash-like text", "rd_PREFIX#backup"],
    ["whitespace", "rd_PREFIX backup"],
    ["control character", "rd_PREFIX\u0001X"],
    ["Unicode", "rd_PRÉFIXBACK"],
    ["short suffix", "rd_123456789"],
    ["long suffix", "rd_12345678901"],
    ["lowercase suffix", "rd_abcdefghjk"],
    ["missing prefix", "ABCDEFGHJKMN"],
  ])("rejects a non-mintable id: %s", (_case, raw) => {
    expect(parseReadingId(raw)).toBeNull();
  });
});
