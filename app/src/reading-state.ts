import { isProcessing, type ReadingError } from "./reading";

// Which of the acceptance matrix's states a reading is in, for everything that
// says so: the reading page's status card and its outcome announcement
// (components/ReadingPage.tsx, ReadingStatusCard.tsx) and the library's badge
// (library-card.ts). A `Reading` and a `LibraryRow` both carry the fields it
// reads, so a card and the reading it opens cannot disagree.
//
// - Being worked on is `isProcessing` (reading.ts): a running attempt decides
//   before the status does, because a reprocess of a ready reading keeps
//   `status: "ready"` (backend `reprocessPending`).
// - A failed reprocess over a ready reading restores the ready manifest with
//   the failed attempt as `last_attempt` and no error of its own (backend
//   `rollForward`). That is the only way a ready reading carries a failed
//   attempt, and the trigger is checked so nothing else is read as one.

/** The fields the classification reads. */
export interface ReadingStateFields {
  status?: string;
  error?: ReadingError;
  active_attempt?: { status?: string } | null;
  last_attempt?: { trigger?: string; status?: string; error?: ReadingError } | null;
}

export type ReadingState =
  | { kind: "processing" }
  /** `error` is the manifest's own, else the one the last attempt recorded. */
  | { kind: "failed"; error?: ReadingError }
  /** Ready, with the prior material kept; `error` is the failed attempt's. */
  | { kind: "reprocess-failed"; error?: ReadingError }
  /** Ready, or a status this app has no state for: nothing to say about it. */
  | { kind: "ready" };

export function readingState(reading: ReadingStateFields): ReadingState {
  if (isProcessing(reading)) return { kind: "processing" };
  if (reading.status === "failed") return { kind: "failed", error: reading.error ?? reading.last_attempt?.error };
  if (reading.last_attempt?.trigger === "reprocess" && reading.last_attempt.status === "failed") {
    return { kind: "reprocess-failed", error: reading.last_attempt.error };
  }
  return { kind: "ready" };
}
