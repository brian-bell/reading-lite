// The way back to the list the reader opened (#407; design spec, Routes and
// navigation state). A library card records `libraryReturn` and the button
// says "Back to library". A catalog card records `catalogReturn` and the
// button says "Back to catalog". With no record from this load, the button
// is a link to `/library`.
//
// Opening a reading from a card records that entry's history position. The
// reading, every relationship followed from it, and the Summary/Source
// switch carry the record on. The button then goes back through history to
// that entry, whose URL is the list the reader left, rather than pushing
// that URL again: scroll
// restoration keys positions by history entry, so only the entry itself
// brings the library back where the reader left it, as browser Back does. From
// a hopped-to reading that one step skips the readings in between, because the
// reader asked for the library they started from, not the previous reading.
//
// Like the trail (reading-trail.ts) the record names the document load that
// wrote it. A reload or a shared link carries none from this load, and neither
// does a server render, so both render the plain link to `/library` and hydration has
// nothing to disagree about.

import type { HistoryState, ParsedHistoryState } from "@tanstack/history";
import { currentLoadId } from "./reading-trail";

export interface LibraryReturnState {
  /** The document load that wrote this record; see currentLoadId. */
  load: string;
  /** The list entry's history position (@tanstack/history's `__TSR_index`). */
  index: number;
}

export type ReturnOrigin = "library" | "catalog";

const RETURN_KEY = {
  library: "libraryReturn",
  catalog: "catalogReturn",
} as const satisfies Record<ReturnOrigin, "libraryReturn" | "catalogReturn">;

export const RETURN_LABEL = {
  library: "Back to library",
  catalog: "Back to catalog",
} as const satisfies Record<ReturnOrigin, string>;

declare module "@tanstack/history" {
  interface HistoryState {
    libraryReturn?: LibraryReturnState;
    catalogReturn?: LibraryReturnState;
  }
}

/** The state a reading opened from the library or the catalog carries. */
export function originReturnState(origin: ReturnOrigin) {
  return (
    from: Partial<ParsedHistoryState> | undefined,
    loadId: string = currentLoadId(),
  ): Pick<HistoryState, "libraryReturn" | "catalogReturn"> => {
    const index = from?.__TSR_index;
    if (typeof index !== "number") return {};
    return { [RETURN_KEY[origin]]: { load: loadId, index } };
  };
}

function returnDelta(
  state: Partial<ParsedHistoryState> | undefined,
  origin: ReturnOrigin,
  loadId: string,
): number | undefined {
  const record = state?.[RETURN_KEY[origin]];
  const current = state?.__TSR_index;
  if (!record || record.load !== loadId || typeof current !== "number") return undefined;
  return record.index < current ? record.index - current : undefined;
}

/** The list this reading was opened from, when this load still has that entry behind it. */
export function readingReturn(
  state: Partial<ParsedHistoryState> | undefined,
  loadId: string = currentLoadId(),
): { origin: ReturnOrigin; delta: number } | undefined {
  for (const origin of ["catalog", "library"] as const) {
    const delta = returnDelta(state, origin, loadId);
    if (delta !== undefined) return { origin, delta };
  }
  return undefined;
}

/** Copies whichever list entry a later hop should keep. */
export function carryReturn(
  prev: Partial<HistoryState> | undefined,
): Pick<HistoryState, "libraryReturn" | "catalogReturn"> {
  return { libraryReturn: prev?.libraryReturn, catalogReturn: prev?.catalogReturn };
}
