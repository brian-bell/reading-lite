import type { LibraryParams } from "./library";

// The library's URL state, `/?q=&tag=&offset=` (acceptance matrix, Routes),
// its pages (#414), and its filters (#417). Parameters stay the plain strings
// the current SPA writes: `q` and `tag` are passed through as they are (the
// backend trims and lowercases them), and `offset` is read with parseInt and
// snapped down to a 20-row page, so "Page N" always names the slice served.
// The first page is the URL without `offset`; no filter is the URL without
// that key.
//
// The route keeps the string it was given rather than the snapped one: a
// validateSearch that rewrites the value redirects a server render to the new
// spelling, which the current SPA never does. Links the page writes are
// snapped already.
//
// validateSearch picks only the library's own parameters, but the router's
// search is not strict (src/router.tsx sets no `search.strict`), so the match
// carries every other parameter the URL had as well. searchForPage and
// searchForFilters spread them into the links they write, which is how an
// unknown parameter survives a page or filter change (smoke/worker.test.ts).
// The index signature says so to the type.

/** Rows per page. The backend's default; the frontend never sends a limit. */
export const LIBRARY_PAGE_SIZE = 20;

/**
 * The last page whose offset the backend entrypoint accepts (at most
 * Number.MAX_SAFE_INTEGER). Past it the number would also stop printing as
 * plain digits.
 */
export const MAX_LIBRARY_OFFSET = Math.floor(Number.MAX_SAFE_INTEGER / LIBRARY_PAGE_SIZE) * LIBRARY_PAGE_SIZE;

export interface LibrarySearch {
  q?: string;
  tag?: string;
  offset?: string;
  /** Anything else the URL carried, kept by the router's non-strict search. */
  [other: string]: string | undefined;
}

/** The route's validateSearch: the library's own parameters, as strings. */
export function validateLibrarySearch(search: Record<string, unknown>): LibrarySearch {
  const out: LibrarySearch = {};
  for (const name of ["q", "tag", "offset"] as const) {
    const value = search[name];
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/** The URL's offset as the SPA reads it: anything but a positive integer is the first page. */
export function snapOffset(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n / LIBRARY_PAGE_SIZE) * LIBRARY_PAGE_SIZE, MAX_LIBRARY_OFFSET);
}

/**
 * What the backend is asked for: the filters as the URL carries them, an
 * empty one meaning none, and the snapped offset.
 */
export function libraryParamsOf(search: LibrarySearch): LibraryParams {
  return {
    ...(search.q ? { q: search.q } : {}),
    ...(search.tag ? { tag: search.tag } : {}),
    offset: snapOffset(search.offset),
  };
}

export function pageNumber(offset: number): number {
  return Math.floor(offset / LIBRARY_PAGE_SIZE) + 1;
}

/** An offset as the URL carries it: none for the first page. */
export function offsetParam(offset: number): string | undefined {
  return offset <= 0 ? undefined : String(offset);
}

/** The search for another page of the same library: filters kept, the offset written as offsetParam does. */
export function searchForPage(search: LibrarySearch, offset: number): LibrarySearch {
  const { offset: _current, ...filters } = search;
  const param = offsetParam(offset);
  return param === undefined ? filters : { ...filters, offset: param };
}

/** A change to the filters: a key present is set, and set to nothing or empty is removed. */
export interface LibraryFilterPatch {
  q?: string | undefined;
  tag?: string | undefined;
}

/**
 * The search for the same library with these filters. Changing a filter
 * starts again from the first page, so `offset` is dropped, as the current
 * SPA does; an empty filter leaves the URL rather than writing `q=`; and any
 * other parameter keeps its place, as URLSearchParams.set would leave it.
 */
export function searchForFilters(search: LibrarySearch, patch: LibraryFilterPatch): LibrarySearch {
  const wanted = {
    q: "q" in patch ? patch.q : search.q,
    tag: "tag" in patch ? patch.tag : search.tag,
  };
  const next: LibrarySearch = {};
  for (const [name, value] of Object.entries(search)) {
    if (name === "offset") continue;
    if (name === "q" || name === "tag") {
      if (wanted[name]) next[name] = wanted[name];
      continue;
    }
    next[name] = value;
  }
  for (const name of ["q", "tag"] as const) {
    if (wanted[name] && !(name in next)) next[name] = wanted[name];
  }
  return next;
}

/**
 * Why a page has no rows (acceptance matrix, Library states). An offset past
 * the end names its page whatever the filters; a first page with a filter
 * names the filter; a first page without one is an empty library.
 */
export type LibraryEmpty =
  | { kind: "no-readings" }
  | { kind: "no-results"; q?: string; tag?: string }
  | { kind: "past-end"; page: number; q?: string; tag?: string };

export function libraryEmptyOf(params: LibraryParams): LibraryEmpty {
  const filters = { ...(params.q ? { q: params.q } : {}), ...(params.tag ? { tag: params.tag } : {}) };
  if (params.offset > 0) return { kind: "past-end", page: pageNumber(params.offset), ...filters };
  if (params.q || params.tag) return { kind: "no-results", ...filters };
  return { kind: "no-readings" };
}

/**
 * The sentence for an empty page: "No readings yet.", "No readings match
 * “q”.", "No readings tagged T.", both joined, and each "on page N" when the
 * page is past the end.
 */
export function libraryEmptyCopy(empty: LibraryEmpty): string {
  if (empty.kind === "no-readings") return "No readings yet.";
  const parts = ["No readings"];
  if (empty.q) parts.push(`match “${empty.q}”`);
  if (empty.tag) parts.push(`tagged ${empty.tag}`);
  if (empty.kind === "past-end") parts.push(`on page ${empty.page}`);
  return `${parts.join(" ")}.`;
}
