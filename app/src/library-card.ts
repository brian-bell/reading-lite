import { categorize } from "./reading-failure";
import type { LibraryRow } from "./library";
import { readingState } from "./reading-state";

// What a library card says about a reading's state (#415; acceptance matrix,
// Library rows "Pending or failed row" and "Reprocess failed on a ready
// reading"). A badge is text, never a control: the title link stays the
// card's one target.
//
// Which state a row is in is `readingState` (reading-state.ts), the same
// classification the reading page's status card renders, so a card and the
// reading it opens agree. This decides only the badge's words.

export type LibraryBadge =
  | { kind: "pending"; label: "Processing" }
  | { kind: "failed"; label: "Failed"; message: string }
  | { kind: "reprocess-failed"; label: "Reprocess failed" };

export function libraryBadge(row: LibraryRow): LibraryBadge | undefined {
  const state = readingState(row);
  switch (state.kind) {
    case "processing":
      return { kind: "pending", label: "Processing" };
    case "failed":
      // The category headline, which for an unknown code is the backend's message.
      return { kind: "failed", label: "Failed", message: state.error ? categorize(state.error).headline : "Processing failed." };
    case "reprocess-failed":
      return { kind: "reprocess-failed", label: "Reprocess failed" };
    case "ready":
      return undefined;
  }
}
