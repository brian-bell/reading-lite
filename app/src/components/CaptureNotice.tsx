import type { ReactNode } from "react";
import { captureRefusalSentence, type CaptureRefusal } from "../capture-refusal";
import { InlineNotice } from "./ReadingStates";

// The notice a capture write leaves when the backend refused it for a reason
// that will pass (acceptance matrix, Capture: "Request rate or quota", "Usage
// guard unavailable", "Saving unavailable"): /save's URL and Markdown tabs,
// and Retry, Reprocess, and Import a copy on the reading page. Each surface
// keeps the refusals only it can meet and words its own 503.
//
// "Try again" is live from the moment the notice appears rather than counting
// down to the reset: the limit is the backend's to enforce, and a reader who
// asks again a moment early gets the same sentence back, which is a smaller
// cost than a control they cannot use.
//
// Not a live region of its own (`live={false}`): every surface has a standing
// polite region that was on the page before there was anything to say, and it
// says the same sentence (captureRefusalSentence). One inserted with its text
// already in it is not reliably announced.

export function CaptureRefusalNotice({
  refusal,
  unavailable,
  onTryAgain,
  children,
}: {
  refusal: CaptureRefusal;
  /** The surface's 503 sentence. */
  unavailable: string;
  onTryAgain: () => void;
  /** Anything the surface adds, such as the reading a 503 names. */
  children?: ReactNode;
}) {
  return (
    <InlineNotice
      message={captureRefusalSentence(refusal, unavailable)}
      actionLabel="Try again"
      onAction={onTryAgain}
      live={false}
    >
      {children}
    </InlineNotice>
  );
}
