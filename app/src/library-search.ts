import type { LibraryParams } from "./library";

// The library's URL state, `/?q=&tag=&offset=` (acceptance matrix, Routes),
// and its pages (#414). Parameters stay the plain strings the current SPA
// writes: `offset` is read with parseInt and snapped down to a 20-row page, so
// "Page N" always names the slice served, and the first page is the URL
// without `offset`.
//
// The route keeps the string it was given rather than the snapped one: a
// validateSearch that rewrites the value redirects a server render to the new
// spelling, which the current SPA never does. Links the page writes are
// snapped already.
//
// validateSearch picks only the library's own parameters, but the router's
// search is not strict (src/router.tsx sets no `search.strict`), so the match
// carries every other parameter the URL had as well. searchForPage spreads
// them into the page links, which is how an unknown parameter survives a page
// change (smoke/worker.test.ts). The index signature says so to the type.

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

/** What the backend is asked for. Filters join with #417. */
export function libraryParamsOf(search: LibrarySearch): LibraryParams {
  return { offset: snapOffset(search.offset) };
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
