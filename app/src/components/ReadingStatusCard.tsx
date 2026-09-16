import { categorize } from "../reading-failure";
import type { ProcessingStage, Reading, ReadingError } from "../reading";
import { readingState } from "../reading-state";
import type { WatchStatus } from "./use-status-watch";

// The status card at the top of a reading that is not ready, or that is ready
// with an attempt running over it (design spec, Reading surface; acceptance
// matrix, Reading detail).
//
// It reports what the backend last wrote and nothing more (acceptance matrix,
// Status refresh contract): a coarse stage, never a percentage. The page keeps
// it current on the contract's bounded schedule (use-status-watch.ts); once
// that stops, at the cap or after failed checks, the card says so and "Check
// status" is the way on. Retry and Import a copy arrive with capture (#410,
// #411).

type StageLabel = "Fetching" | "Analyzing" | "Publishing";

/** ProcessingStage → the coarse label the refresh contract allows. */
const STAGE_LABELS: Record<ProcessingStage, StageLabel> = {
  queued: "Fetching",
  fetch_source: "Fetching",
  prepare_markdown: "Fetching",
  write_raw: "Fetching",
  write_extracted: "Fetching",
  embed_source: "Analyzing",
  query_similar: "Analyzing",
  summarize: "Analyzing",
  embed_summary: "Analyzing",
  upsert_vector: "Publishing",
  write_manifest: "Publishing",
  write_indexes: "Publishing",
  send_email: "Publishing",
};

/** The contract's label for a stage, or "Processing" for none or one this app does not know. */
export function stageLabel(stage: string | undefined): StageLabel | "Processing" {
  return (stage !== undefined && STAGE_LABELS[stage as ProcessingStage]) || "Processing";
}

/**
 * What the card adds once automatic checks are not the whole story: the last
 * check failed (automatic or "Check status"), the three-failure stop, or the
 * cap. A failed check outranks the cap, so a manual check after it that fails
 * does not pass silently.
 */
function checkText(watch: WatchStatus, checkFailed: boolean): string | undefined {
  if (checkFailed || watch === "failures") return "Couldn't check status";
  if (watch === "cap") return "Still processing";
  return undefined;
}

export function ReadingStatusCard({
  reading,
  watch,
  checkFailed,
  onCheck,
}: {
  reading: Reading;
  watch: WatchStatus;
  /** Whether the latest check failed while the reading stayed on screen. */
  checkFailed: boolean;
  onCheck: () => void;
}) {
  // `readingState` (reading-state.ts) is the shared rule, the library badge's
  // too. A running attempt decides before the manifest status does, because
  // reprocessing a ready reading keeps `status: "ready"` and adds the attempt,
  // so status alone would hide the card for the whole reprocess — the
  // acceptance matrix puts that reading in the Pending row, with the prior
  // content still below.
  const state = readingState(reading);
  if (state.kind === "processing") {
    return <PendingCard reading={reading} text={checkText(watch, checkFailed)} onCheck={onCheck} />;
  }
  if (state.kind === "failed") return <FailedCard error={state.error} />;
  return null;
}

function PendingCard({ reading, text, onCheck }: { reading: Reading; text: string | undefined; onCheck: () => void }) {
  // A reprocess of a ready reading leaves the previous summary on the page, so
  // "still being processed" would misdescribe what the reader is looking at.
  const again = reading.status === "ready";
  return (
    <section className="status-card" aria-label="Processing status">
      <p className="status-card-headline">
        {again ? "This reading is being processed again." : "This reading is still being processed."}
      </p>
      <p className="status-card-detail">{stageLabel(reading.active_attempt?.stage)}.</p>
      {text ? <p className="form-hint">{text}.</p> : null}
      <div className="status-card-actions">
        <button type="button" className="button" onClick={onCheck}>
          Check status
        </button>
      </div>
    </section>
  );
}

function FailedCard({ error }: { error: ReadingError | undefined }) {
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
      {failure.stage ? <p className="form-hint">Stopped at: {stageLabel(failure.stage)}.</p> : null}
    </section>
  );
}
