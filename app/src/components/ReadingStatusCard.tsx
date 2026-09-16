import { categorize } from "../reading-failure";
import { useEffect, useRef } from "react";
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
// status" is the way on.
//
// A failed reading offers Retry, which reprocesses at once with no
// confirmation (#410; design spec, Reading surface); Import a copy arrives
// with #411. A ready reading whose reprocess failed keeps its prior material
// below a card that says so; its way on is the confirmed Reprocess in the
// heading row, never an unconfirmed Retry.

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
  onRetry,
  sending,
  retryStarted,
}: {
  reading: Reading;
  watch: WatchStatus;
  /** Whether the latest check failed while the reading stayed on screen. */
  checkFailed: boolean;
  onCheck: () => void;
  onRetry: () => void;
  /** A reprocess request is in flight. */
  sending: boolean;
  /** A Retry on this page started the attempt now running. */
  retryStarted: boolean;
}) {
  // `readingState` (reading-state.ts) is the shared rule, the library badge's
  // too. A running attempt decides before the manifest status does, because
  // reprocessing a ready reading keeps `status: "ready"` and adds the attempt,
  // so status alone would hide the card for the whole reprocess — the
  // acceptance matrix puts that reading in the Pending row, with the prior
  // content still below.
  const state = readingState(reading);
  switch (state.kind) {
    case "processing":
      return (
        <PendingCard
          reading={reading}
          text={checkText(watch, checkFailed)}
          onCheck={onCheck}
          takeFocus={retryStarted}
        />
      );
    case "failed":
      return <FailedCard error={state.error} onRetry={onRetry} sending={sending} />;
    case "reprocess-failed":
      return <ReprocessFailedCard error={state.error} />;
    case "ready":
      return null;
  }
}

function PendingCard({
  reading,
  text,
  onCheck,
  takeFocus,
}: {
  reading: Reading;
  text: string | undefined;
  onCheck: () => void;
  takeFocus: boolean;
}) {
  // Retry was on the failed card this one replaced, so the reader's focus went
  // with it; it lands here, on the one control, rather than the document. Only
  // when it was lost: a reader who moved on keeps their place.
  const checkRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (takeFocus && (active === null || active === document.body)) checkRef.current?.focus();
  }, [takeFocus]);
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
        <button type="button" className="button" ref={checkRef} onClick={onCheck}>
          Check status
        </button>
      </div>
    </section>
  );
}

function FailedCard({
  error,
  onRetry,
  sending,
}: {
  error: ReadingError | undefined;
  onRetry: () => void;
  sending: boolean;
}) {
  return (
    <section className="status-card status-card-failed" aria-label="Processing status">
      <FailureText error={error} />
      <div className="status-card-actions">
        {/* aria-disabled, not disabled, while the request is in flight: a
            disabled button drops the reader's focus (SavePage.tsx). The second
            press is refused in use-reprocess.ts either way. */}
        <button type="button" className="button" aria-disabled={sending || undefined} onClick={onRetry}>
          Retry
        </button>
      </div>
    </section>
  );
}

/**
 * A ready reading whose reprocess failed: the backend restored the previous
 * manifest, so what is below is the version from before the attempt.
 */
function ReprocessFailedCard({ error }: { error: ReadingError | undefined }) {
  return (
    <section className="status-card status-card-failed" aria-label="Processing status">
      <FailureText lead="Reprocess failed. The previous version is still here." error={error} />
    </section>
  );
}

/**
 * The failure category, message, and stage (acceptance matrix, Failure
 * categories). `lead`, when given, is the headline and the category follows it.
 */
function FailureText({ lead, error }: { lead?: string; error: ReadingError | undefined }) {
  const failure = error ? categorize(error) : undefined;
  return (
    <>
      <p className="status-card-headline">{lead ?? failure?.headline ?? "Processing failed."}</p>
      {lead && failure ? <p className="status-card-detail">{failure.headline}</p> : null}
      {/* For an unknown failure the backend's message is the headline already. */}
      {failure && failure.headline !== failure.message ? <p className="status-card-detail">{failure.message}</p> : null}
      {failure?.stage ? <p className="form-hint">Stopped at: {stageLabel(failure.stage)}.</p> : null}
    </>
  );
}
