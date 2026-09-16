import { describe, expect, it } from "vitest";
import {
  LIBRARY_PAGE_SIZE,
  MAX_LIBRARY_OFFSET,
  libraryEmptyCopy,
  libraryEmptyOf,
  libraryParamsOf,
  offsetParam,
  pageNumber,
  searchForFilters,
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

  // The raw strings again (#417): the backend trims and lowercases them, and
  // a return path carrying them is not rewritten.
  it("keeps q and tag as strings", () => {
    expect(validateLibrarySearch({ q: "slow", tag: "ai", offset: "20" })).toEqual({ q: "slow", tag: "ai", offset: "20" });
    expect(validateLibrarySearch({ q: " Slow ", tag: 7 })).toEqual({ q: " Slow " });
  });

  it("asks the backend for the snapped page", () => {
    expect(libraryParamsOf({})).toEqual({ offset: 0 });
    expect(libraryParamsOf({ offset: "25" })).toEqual({ offset: 20 });
    expect(libraryParamsOf({ offset: "40" })).toEqual({ offset: 40 });
  });

  it("asks the backend for the filters as the URL spells them, an empty one meaning none", () => {
    expect(libraryParamsOf({ q: " Slow ", tag: "AI", offset: "25" })).toEqual({ q: " Slow ", tag: "AI", offset: 20 });
    expect(libraryParamsOf({ q: "", tag: "" })).toEqual({ offset: 0 });
    expect(libraryParamsOf({ q: "", tag: "" })).not.toHaveProperty("q");
  });
});

// Filter changes (#417) as the current SPA writes them: the changed key set
// or removed, `offset` dropped, everything else left alone.
describe("searchForFilters", () => {
  it("sets a search and starts from the first page", () => {
    expect(searchForFilters({ offset: "40" }, { q: "slow" })).toEqual({ q: "slow" });
    expect(searchForFilters({ q: "old", tag: "ai", offset: "40" }, { q: "slow" })).toEqual({ q: "slow", tag: "ai" });
  });

  it("sets a tag, keeping the search", () => {
    expect(searchForFilters({ q: "slow", offset: "20" }, { tag: "ai" })).toEqual({ q: "slow", tag: "ai" });
  });

  it("removes a filter set to nothing or to an empty string", () => {
    expect(searchForFilters({ q: "slow", tag: "ai", offset: "20" }, { tag: undefined })).toEqual({ q: "slow" });
    expect(searchForFilters({ q: "slow", tag: "ai" }, { q: "" })).toEqual({ tag: "ai" });
    expect(searchForFilters({ q: "slow", tag: "ai" }, { q: undefined, tag: undefined })).toEqual({});
  });

  it("leaves a filter it was not asked about as it is", () => {
    expect(searchForFilters({ q: "slow" }, {})).toEqual({ q: "slow" });
    expect(searchForFilters({}, {})).toEqual({});
  });

  it("keeps other parameters in their place and appends a new filter after them", () => {
    expect(Object.entries(searchForFilters({ utm_source: "feed", q: "old", offset: "20" }, { q: "slow", tag: "ai" }))).toEqual([
      ["utm_source", "feed"],
      ["q", "slow"],
      ["tag", "ai"],
    ]);
    expect(Object.entries(searchForFilters({ tag: "ai", q: "old" }, { q: "slow" }))).toEqual([
      ["tag", "ai"],
      ["q", "slow"],
    ]);
  });
});

// Why a page is empty, and what it says (acceptance matrix, Library states).
describe("an empty page", () => {
  it("is an empty library only on the first page with no filter", () => {
    expect(libraryEmptyOf({ offset: 0 })).toEqual({ kind: "no-readings" });
    expect(libraryEmptyCopy({ kind: "no-readings" })).toBe("No readings yet.");
  });

  it("names the search, the tag, or both", () => {
    expect(libraryEmptyOf({ q: "slow", offset: 0 })).toEqual({ kind: "no-results", q: "slow" });
    expect(libraryEmptyOf({ tag: "ai", offset: 0 })).toEqual({ kind: "no-results", tag: "ai" });
    expect(libraryEmptyOf({ q: "slow", tag: "ai", offset: 0 })).toEqual({ kind: "no-results", q: "slow", tag: "ai" });
    expect(libraryEmptyCopy({ kind: "no-results", q: "slow" })).toBe("No readings match “slow”.");
    expect(libraryEmptyCopy({ kind: "no-results", tag: "ai" })).toBe("No readings tagged ai.");
    expect(libraryEmptyCopy({ kind: "no-results", q: "slow", tag: "ai" })).toBe("No readings match “slow” tagged ai.");
  });

  it("names the page past the end, with the filters when there are any", () => {
    expect(libraryEmptyOf({ offset: 100 })).toEqual({ kind: "past-end", page: 6 });
    expect(libraryEmptyOf({ q: "slow", tag: "ai", offset: 20 })).toEqual({ kind: "past-end", page: 2, q: "slow", tag: "ai" });
    expect(libraryEmptyCopy({ kind: "past-end", page: 6 })).toBe("No readings on page 6.");
    expect(libraryEmptyCopy({ kind: "past-end", page: 2, q: "slow" })).toBe("No readings match “slow” on page 2.");
    expect(libraryEmptyCopy({ kind: "past-end", page: 2, tag: "ai" })).toBe("No readings tagged ai on page 2.");
  });
});
