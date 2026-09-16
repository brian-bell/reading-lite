import { categorize } from "./reading-failure";
import type { LibraryRow } from "./library";

// What a library card says about a reading's state (#415; acceptance matrix,
// Library rows "Pending or failed row" and "Reprocess failed on a ready
// reading"). A badge is text, never a control: the title link stays the
// card's one target.
//
// The pending and failed rules are the detail page's
// (components/ReadingStatusCard.tsx), read from the list row's copy of the
// same fields, so a card and the reading it opens agree. A running attempt
// decides before the status does, because a reprocess over a ready reading
// keeps `status: "ready"` (backend `reprocessPending`); a failed reprocess
// over one restores the ready manifest with the failed attempt as
// `last_attempt` and no error of its own (backend `rollForward`), which is
// the only way a ready row carries a failed attempt. The detail page says
// nothing about that state yet: #410 adds its "Reprocess failed" state with
// the Reprocess action, and should share this classification rather than
// copy it a third time.

export type LibraryBadge =
  | { kind: "pending"; label: "Processing" }
  | { kind: "failed"; label: "Failed"; message: string }
  | { kind: "reprocess-failed"; label: "Reprocess failed" };

export function libraryBadge(row: LibraryRow): LibraryBadge | undefined {
  if (row.active_attempt?.status === "running" || row.status === "pending") {
    return { kind: "pending", label: "Processing" };
  }
  if (row.status === "failed") {
    // The manifest's own error, else the one the last attempt recorded; the
    // category headline, which for an unknown code is the backend's message.
    const error = row.error ?? row.last_attempt?.error;
    return { kind: "failed", label: "Failed", message: error ? categorize(error).headline : "Processing failed." };
  }
  if (row.last_attempt?.trigger === "reprocess" && row.last_attempt.status === "failed") {
    return { kind: "reprocess-failed", label: "Reprocess failed" };
  }
  return undefined;
}
