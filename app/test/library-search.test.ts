import { describe, expect, it } from "vitest";
import {
  LIBRARY_PAGE_SIZE,
  MAX_LIBRARY_OFFSET,
  libraryParamsOf,
  offsetParam,
  pageNumber,
  searchForPage,
  snapOffset,
  validateLibrarySearch,
} from "../src/library-search";

describe("snapOffset", () => {
  it.each([
    [undefined, 0],
    ["", 0],
    ["0", 0],
    ["-5", 0],
    ["-40", 0],
    ["abc", 0],
    ["NaN", 0],
    ["Infinity", 0],
  ])("reads %j as the first page", (raw, expected) => {
    expect(snapOffset(raw)).toBe(expected);
  });

  it.each([
    ["20", 20],
    ["40", 40],
    ["15", 0],
    ["25", 20],
    ["59", 40],
  ])("snaps %j down to a 20-row page", (raw, expected) => {
    expect(snapOffset(raw)).toBe(expected);
  });

  // The current SPA reads the offset with parseInt, so these spellings name
  // the same page there.
  it.each([
    ["20abc", 20],
    [" 40", 40],
    ["40.9", 40],
    ["1e3", 0],
  ])("reads %j as parseInt does", (raw, expected) => {
    expect(snapOffset(raw)).toBe(expected);
  });

  it("caps an offset the backend cannot take at the last safe page", () => {
    expect(MAX_LIBRARY_OFFSET % LIBRARY_PAGE_SIZE).toBe(0);
    expect(MAX_LIBRARY_OFFSET).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(MAX_LIBRARY_OFFSET + LIBRARY_PAGE_SIZE).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(snapOffset("99999999999999999999")).toBe(MAX_LIBRARY_OFFSET);
    expect(snapOffset(String(Number.MAX_SAFE_INTEGER))).toBe(MAX_LIBRARY_OFFSET);
  });
});

describe("page arithmetic", () => {
  it("numbers pages from one", () => {
    expect(pageNumber(0)).toBe(1);
    expect(pageNumber(20)).toBe(2);
    expect(pageNumber(400)).toBe(21);
  });

  it("writes the first page as no offset and later pages as plain strings", () => {
    expect(offsetParam(0)).toBeUndefined();
    expect(offsetParam(-20)).toBeUndefined();
    expect(offsetParam(20)).toBe("20");
    expect(offsetParam(MAX_LIBRARY_OFFSET)).toBe(String(MAX_LIBRARY_OFFSET));
  });

  it("writes another page's search, dropping the offset on the first page", () => {
    expect(searchForPage({ offset: "40" }, 20)).toEqual({ offset: "20" });
    expect(searchForPage({ offset: "20" }, 0)).toEqual({});
    expect(searchForPage({}, 20)).toEqual({ offset: "20" });
  });

  it("keeps the filters when changing page", () => {
    expect(searchForPage({ q: "slow", tag: "ai", offset: "25" }, 40)).toEqual({ q: "slow", tag: "ai", offset: "40" });
    expect(searchForPage({ q: "slow", offset: "20" }, 0)).toEqual({ q: "slow" });
  });
});

describe("the route's search", () => {
  // The raw string is kept: rewriting it would redirect a server render to
  // the new spelling, which the current SPA never does.
  it("keeps offset as the string the URL carries", () => {
    expect(validateLibrarySearch({ offset: "25" })).toEqual({ offset: "25" });
    expect(validateLibrarySearch({ offset: "abc" })).toEqual({ offset: "abc" });
    expect(validateLibrarySearch({})).toEqual({});
  });

  // Only the library's own parameters are validated. The router's search is
  // not strict, so a parameter it does not read still reaches the match and
  // the page links (smoke/worker.test.ts proves it survives a page change).
  it("validates a non-string offset away and only the library's own parameters", () => {
    expect(validateLibrarySearch({ offset: 20 })).toEqual({});
    expect(validateLibrarySearch({ offset: "20", utm_source: "feed" })).toEqual({ offset: "20" });
  });

  // Filters are #417's; until then they stay in the URL untouched, so a
  // return path carrying them is not rewritten.
  it("keeps q and tag as strings", () => {
    expect(validateLibrarySearch({ q: "slow", tag: "ai", offset: "20" })).toEqual({ q: "slow", tag: "ai", offset: "20" });
  });

  it("asks the backend for the snapped page", () => {
    expect(libraryParamsOf({})).toEqual({ offset: 0 });
    expect(libraryParamsOf({ offset: "25" })).toEqual({ offset: 20 });
    expect(libraryParamsOf({ offset: "40" })).toEqual({ offset: 40 });
  });
});
