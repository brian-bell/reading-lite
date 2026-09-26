import { ALREADY_PROCESSING_SENTENCE, captureRefusalSentence } from "../capture-refusal";
import { CaptureRefusalNotice } from "./CaptureNotice";
import { InlineNotice } from "./ReadingStates";
import type { ReprocessNotice } from "./use-reprocess";

// What a reprocess that did not start leaves behind (acceptance matrix,
// Capture), in one wording for the reading page's Retry and Reprocess (#410)
// and the Import a copy dialog (#411). They differ only in what the 503 says
// could not be done and in which ways on each can offer.

/** Which request was refused: Retry or Reprocess, or Import a copy. */
export type ReprocessRequest = "reprocess" | "import";

const UNAVAILABLE: Record<ReprocessRequest, string> = {
  reprocess: "Reprocessing is unavailable right now.",
  import: "Importing is unavailable right now.",
};

/** What a refused reprocess says, in one place: the notice and the live region that announces it. */
export function reprocessNoticeSentence(notice: ReprocessNotice, request: ReprocessRequest): string {
  switch (notice.kind) {
    case "already-processing":
      return ALREADY_PROCESSING_SENTENCE;
    case "markdown-missing":
      return "The Markdown this reading was imported from is no longer available.";
    case "invalid":
      return notice.message;
    case "forbidden":
      return "You don't have permission to reprocess this reading.";
    case "account-changed":
      return "This tab is signed in to a different account than the page expects.";
    case "limited":
    case "guard-unavailable":
    case "unavailable":
      return captureRefusalSentence(notice, UNAVAILABLE[request]);
    case "offline":
      return "You're offline. Check your connection and try again.";
    case "server-error":
      return `Something went wrong on our side. ${notice.message}`;
  }
}

/**
 * The notice, with the way on when there is one. Not a live region of its
 * own: the surface's standing region says the same sentence.
 *
 * A 403 or 412 is a notice here, not the page-replacing state /save shows:
 * the refusal is of the write, and the reading's own read, the next time it
 * is made, replaces the page when the reading itself is no longer the
 * reader's. A 412's Reload makes it now.
 */
export function ReprocessNoticeBanner({
  notice,
  request,
  onTryAgain,
  onCheck,
  onImportCopy,
}: {
  notice: ReprocessNotice;
  request: ReprocessRequest;
  onTryAgain: () => void;
  /** Reads the reading again, after a 409 over an attempt already running. */
  onCheck?: () => void;
  /** Opens Import a copy, after a 409 over a Markdown reading whose copy is gone. */
  onImportCopy?: () => void;
}) {
  const message = reprocessNoticeSentence(notice, request);
  switch (notice.kind) {
    case "already-processing":
      // On the page, the reader is on the reading already; opening it is
      // reading it again.
      return <InlineNotice message={message} actionLabel="Open reading" onAction={onCheck} live={false} />;
    case "markdown-missing":
      return <InlineNotice message={message} actionLabel="Import a copy" onAction={onImportCopy} live={false} />;
    case "account-changed":
      return (
        <InlineNotice message={message} actionLabel="Reload" onAction={() => window.location.reload()} live={false} />
      );
    case "invalid":
    case "forbidden":
      return <InlineNotice message={message} live={false} />;
    case "limited":
    case "guard-unavailable":
    case "unavailable":
      return <CaptureRefusalNotice refusal={notice} unavailable={UNAVAILABLE[request]} onTryAgain={onTryAgain} />;
    case "offline":
    case "server-error":
      return <InlineNotice message={message} actionLabel="Try again" onAction={onTryAgain} live={false} />;
  }
}
