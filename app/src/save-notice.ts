// The notice a save leaves on the reading it opened (#432): a URL the reader
// already owned is not saved again, and the reading they land on says so —
// "Already in your library", or "Already saved and still processing" when it
// has not finished.
//
// It travels in router history state, never in the URL: it is about the save
// that just happened, not about the reading, so a shared link to the same
// reading must not carry it and the URL must stay the one anybody can share.
//
// It belongs to the history entry the save wrote, exactly as the return trail
// does (reading-trail.ts), and that is the whole of the rule: the Summary
// /Source switch replaces that entry and keeps its state, so the notice stays,
// and browser Back to it within the same document load shows the notice again,
// which is the arrival it describes. What it is not is durable — like the
// trail it names the document load that wrote it, because @tanstack/history
// rebuilds the location from `window.history.state` when the document loads
// and a notice written before a reload would otherwise come back with the
// page. A server render never matches either, so it is never part of the
// server's HTML.

import type { HistoryState } from "@tanstack/history";
import { currentLoadId } from "./reading-trail";
import type { SaveNotice } from "./save";

export interface SaveNoticeState {
  /** The document load that wrote this notice; see currentLoadId. */
  load: string;
  kind: SaveNotice;
}

declare module "@tanstack/history" {
  interface HistoryState {
    saveNotice?: SaveNoticeState;
  }
}

/** The notice a location carries, or none when its state is from another load. */
export function saveNoticeOf(state: HistoryState | undefined, loadId: string = currentLoadId()): SaveNotice | undefined {
  const notice = state?.saveNotice;
  if (!notice || notice.load !== loadId) return undefined;
  return notice.kind;
}

/** The state a save attaches to the reading it opens. */
export function saveNoticeState(kind: SaveNotice, loadId: string = currentLoadId()): SaveNoticeState {
  return { load: loadId, kind };
}
