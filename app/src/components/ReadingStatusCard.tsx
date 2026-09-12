import { categorize } from "../reading-failure";
import type { Reading } from "../reading";

// The status card at the top of a reading that is not ready, or that is ready
// with an attempt running over it (design spec, Reading surface; acceptance
// matrix, Reading detail).
//
// Read-only in this slice: it reports what the backend last wrote and nothing
// more. The bounded status refresh and its "Check status" control arrive with
// the refresh contract in Phase 4 (#339), and Retry / Import a copy arrive with
// capture in the same phase. Inventing step-level progress here is exactly what
// the contract forbids, so a pending reading names its stage and stops.

/** ProcessingStage → the coarse label the refresh contract allows. */
const STAGE_LABELS: Record<string, string> = {
  queued: "Queued",
  fetch_source: "Fetching the page",
  prepare_markdown: "Preparing the text",
  write_raw: "Saving the capture",
  write_extracted: "Saving the text",
  embed_source: "Reading the text",
  query_similar: "Looking for related readings",
  summarize: "Summarizing",
  embed_summary: "Filing the summary",
  upsert_vector: "Filing the summary",
  write_manifest: "Finishing",
  write_indexes: "Finishing",
  send_email: "Finishing",
};

export function ReadingStatusCard({ reading }: { reading: Reading }) {
  // A running attempt decides before the manifest status does. Reprocessing a
  // ready reading keeps `status: "ready"` and adds the running attempt
  // (backend `reprocessPending`), so status alone would hide the card for the
  // whole reprocess — the acceptance matrix puts that reading in the Pending
  // row, with the prior content still below.
  if (reading.active_attempt?.status === "running") return <PendingCard reading={reading} />;
  if (reading.status === "pending") return <PendingCard reading={reading} />;
  if (reading.status === "failed") return <FailedCard reading={reading} />;
  return null;
}

function PendingCard({ reading }: { reading: Reading }) {
  const stage = reading.active_attempt?.stage;
  const label = stage ? STAGE_LABELS[stage] : undefined;
  // A reprocess of a ready reading leaves the previous summary on the page, so
  // "still being processed" would misdescribe what the reader is looking at.
  const again = reading.status === "ready";
  return (
    <section className="status-card" aria-label="Processing status">
      <p className="status-card-headline">
        {again ? "This reading is being processed again." : "This reading is still being processed."}
      </p>
      {label ? <p className="status-card-detail">{label}.</p> : null}
      <p className="form-hint">Reload the page to see where it has got to.</p>
    </section>
  );
}

function FailedCard({ reading }: { reading: Reading }) {
  // The manifest's own error, else the one the last attempt recorded.
  const error = reading.error ?? reading.last_attempt?.error;
  if (!error) {
    return (
      <section className="status-card status-card-failed" aria-label="Processing status">
        <p className="status-card-headline">Processing failed.</p>
      </section>
    );
  }
  const failure = categorize(error);
  return (
    <section className="status-card status-card-failed" aria-label="Processing status">
      <p className="status-card-headline">{failure.headline}</p>
      {/* For an unknown failure the backend's message is the headline already. */}
      {failure.headline === failure.message ? null : (
        <p className="status-card-detail">{failure.message}</p>
      )}
      {failure.stage ? <p className="form-hint">Stopped at: {STAGE_LABELS[failure.stage] ?? failure.stage}.</p> : null}
    </section>
  );
}
