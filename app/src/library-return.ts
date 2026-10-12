// The way back to the library (#407; design spec, Routes and navigation
// state): "Back to library" returns to the library URL the reader came from,
// carried in router history state, else `/library`.
//
// Opening a reading from a library card records the library entry's history
// position. The reading, every relationship followed from it, and the
// Summary/Source switch carry the record on. "Back to library" then goes back
// through history to that entry, whose URL is the library URL the reader
// left, rather than pushing that URL again: scroll
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
  /** The library entry's history position (@tanstack/history's `__TSR_index`). */
  index: number;
}

declare module "@tanstack/history" {
  interface HistoryState {
    libraryReturn?: LibraryReturnState;
  }
}

/** The state a reading opened from the library carries, given the library entry's history state. */
export function libraryReturnState(
  from: Partial<ParsedHistoryState> | undefined,
  loadId: string = currentLoadId(),
): Pick<HistoryState, "libraryReturn"> {
  const index = from?.__TSR_index;
  return typeof index === "number" ? { libraryReturn: { load: loadId, index } } : {};
}

/**
 * How far back the library entry is, when this location carries a record from
 * this load that points behind it; otherwise undefined and the page links to `/library`.
 */
export function libraryReturnDelta(state: Partial<ParsedHistoryState> | undefined, loadId: string = currentLoadId()): number | undefined {
  const record = state?.libraryReturn;
  const current = state?.__TSR_index;
  if (!record || record.load !== loadId || typeof current !== "number") return undefined;
  return record.index < current ? record.index - current : undefined;
}
