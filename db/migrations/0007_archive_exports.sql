-- One archive export per request (reading-lite-mxwx). The row is the job:
-- the queue message carries only tenant and export id, and a redelivery
-- resumes from this row rather than from the payload.
--
-- No ON DELETE CASCADE. Teardown deletes the rows itself, in the same
-- transaction that deletes the user, as it does for every other child.
-- Cancelling an in-flight export when deletion starts, and the residue scan,
-- are later slices; the wipe already lists the whole tenant prefix, which
-- includes exports/{id}/.
--
-- At most one queued or building export per tenant. Ready, failed, expired,
-- and cancelled rows do not hold the slot. The daily limit is a query, not
-- an index: only queued, building, and ready requests inside the rolling
-- window count.
CREATE TABLE archive_exports (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES users (id),
  status text NOT NULL CHECK (status IN ('queued', 'building', 'ready', 'failed', 'expired', 'cancelled')),
  requested_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  lease_seq integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL,
  cursor jsonb,
  segments jsonb,
  counts jsonb,
  error jsonb,
  continuations integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX archive_exports_one_active
  ON archive_exports (tenant_id)
  WHERE status IN ('queued', 'building');
