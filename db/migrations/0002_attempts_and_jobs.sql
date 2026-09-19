-- Attempt and job state (ADR 0005, slice 1b). These replace the R2 attempt
-- logs (`attempts/`), the processing checkpoints (`processing/`), and the
-- queue message as the only record that work was asked for.
--
-- readings.active_attempt and last_attempt stay as the summaries the Manifest
-- projection returns; the rows here are the full log behind them.

CREATE TABLE reading_attempts (
  tenant_id text NOT NULL,
  reading_id text NOT NULL,
  id text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('submit', 'reprocess', 'import')),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  stage text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  error jsonb,
  -- Ordered stage events, appended as the attempt runs.
  events jsonb NOT NULL DEFAULT '[]',
  -- Paid results kept across queue retries so a redelivery never pays twice.
  checkpoint jsonb,
  -- Relative R2 keys of the content this attempt captured, under its own
  -- immutable revision prefix. A reading that was never published has no
  -- revision, so /content finds its bytes here.
  raw_key text,
  extracted_key text,
  PRIMARY KEY (tenant_id, reading_id, id),
  FOREIGN KEY (tenant_id, reading_id) REFERENCES readings (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX reading_attempts_recent ON reading_attempts (tenant_id, reading_id, started_at DESC);

-- Durable job intent. The row commits with the claim or the reprocess that
-- asked for the work, before the queue send, so a failed send leaves a
-- recoverable record (`send_failed`). `payload` is the queue message body.
-- Only the reading DLQ marks a job `dead`.
CREATE TABLE reading_jobs (
  tenant_id text NOT NULL,
  reading_id text NOT NULL,
  attempt_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'sent', 'done', 'dead', 'send_failed')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, reading_id, attempt_id),
  FOREIGN KEY (tenant_id, reading_id, attempt_id)
    REFERENCES reading_attempts (tenant_id, reading_id, id) ON DELETE CASCADE
);
