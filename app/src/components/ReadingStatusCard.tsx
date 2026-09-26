import type { Ref } from "react";
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
// status" is the way on.
//
// A failed reading offers Retry, which reprocesses at once with no
// confirmation (#410; design spec, Reading surface), and Import a copy, which
// reprocesses it from Markdown the reader supplies (#411). A ready reading
// whose reprocess failed keeps its prior material below a card that says so;
// its way on is the confirmed Reprocess in the heading row, never an
// unconfirmed Retry.

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
  onImportCopy,
  sending,
  actionRef,
}: {
  reading: Reading;
  watch: WatchStatus;
  /** Whether the latest check failed while the reading stayed on screen. */
  checkFailed: boolean;
  onCheck: () => void;
  onRetry: () => void;
  onImportCopy: () => void;
  /** A reprocess request is in flight. */
  sending: boolean;
  /** The card's first action, which stays the same button from Retry to Check status. */
  actionRef?: Ref<HTMLButtonElement>;
}) {
  // `readingState` (reading-state.ts) is the shared rule, the library badge's
  // too. A running attempt decides before the manifest status does, because
  // reprocessing a ready reading keeps `status: "ready"` and adds the attempt,
  // so status alone would hide the card for the whole reprocess — the
  // acceptance matrix puts that reading in the Pending row, with the prior
  // content still below.
  const state = readingState(reading);
  if (state.kind === "ready") return null;
  const failed = state.kind !== "processing";

  // One section and, when there is one, one action button, in the same place
  // whatever the state: a Retry that turns the card into "being processed"
  // becomes that card's Check status, so the reader's focus stays on the
  // control they pressed instead of falling to the document — whether the
  // retry started the attempt or found one already running. Import a copy
  // follows it on a failed reading and goes with the failure; its dialog gives
  // focus back to this one.
  let action: { label: string; onClick: () => void; busy: boolean } | null = null;
  if (state.kind === "processing") action = { label: "Check status", onClick: onCheck, busy: false };
  // A ready reading whose reprocess failed has no action here: its way on is
  // the confirmed Reprocess in the heading row, never an unconfirmed Retry.
  if (state.kind === "failed") action = { label: "Retry", onClick: onRetry, busy: sending };

  return (
    <section className={failed ? "status-card status-card-failed" : "status-card"} aria-label="Processing status">
      <div>
        {state.kind === "processing" ? (
          <PendingText reading={reading} text={checkText(watch, checkFailed)} />
        ) : state.kind === "failed" ? (
          <FailureText error={state.error} />
        ) : (
          <FailureText lead="Reprocess failed. The previous version is still here." error={state.error} />
        )}
      </div>
      {action ? (
        <div className="status-card-actions">
          {/* aria-disabled, not disabled, while a request is in flight: a
              disabled button drops the reader's focus (SavePage.tsx). The
              second press is refused in use-reprocess.ts either way. */}
          <button
            type="button"
            className="button"
            ref={actionRef}
            aria-disabled={action.busy || undefined}
            onClick={action.onClick}
          >
            {action.label}
          </button>
          {state.kind === "failed" ? (
            <button type="button" className="button" aria-disabled={sending || undefined} onClick={onImportCopy}>
              Import a copy
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PendingText({ reading, text }: { reading: Reading; text: string | undefined }) {
  // A reprocess of a ready reading leaves the previous summary on the page, so
  // "still being processed" would misdescribe what the reader is looking at.
  const again = reading.status === "ready";
  return (
    <>
      <p className="status-card-headline">
        {again ? "This reading is being processed again." : "This reading is still being processed."}
      </p>
      <p className="status-card-detail">{stageLabel(reading.active_attempt?.stage)}.</p>
      {text ? <p className="form-hint">{text}.</p> : null}
    </>
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
