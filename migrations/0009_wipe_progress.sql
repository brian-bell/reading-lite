-- Account-wipe progress, lease, and completion record (issue 195 S2 / #261).
--
-- Replaces `wipe/{tenantId}/progress.json` in R2. Two things move with it:
--
--   1. The lease. R2 had no conditional delete and its etag CAS had to be
--      propped up by a live-clock heartbeat and a retry-time lease advance so a
--      cron tick at the 15-minute boundary could not last-write-wins a running
--      job. Here the CAS is `WHERE tenant_id = ? AND lease_seq = ?` on a
--      monotonic counter, so ownership no longer depends on the wall clock at
--      all: `changes = 0` means a sibling owns this wipe. `updated_at_ms` stays,
--      but only as the advisory hint cron uses to avoid enqueuing a duplicate
--      it would then have to turn away.
--
--   2. The completion record. The R2 object was DELETED at the terminal
--      transition, because its key named a deleted tenant and its body listed
--      that tenant's reading ids. This row is kept: it holds no reading id
--      (both cursors are cleared on completion) and it is the only durable
--      evidence that a wipe ran and how it ended. Fan-out reads it instead of
--      inferring "already wiped" from an empty R2 prefix, and S4's
--      control-plane teardown gates its hard delete of the users row on
--      `completed_at_ms`.
--
-- `REFERENCES users(id)` deliberately carries NO `ON DELETE CASCADE`: S4 hard-
-- deletes the users row and reads this record to decide it may, so a cascade
-- would destroy the evidence at the moment it is needed (design decision E).
-- S4 removes this row explicitly, after the gate has been read.
CREATE TABLE wipe_progress (
  tenant_id TEXT PRIMARY KEY REFERENCES users(id),
  phase TEXT NOT NULL CHECK (phase IN ('vectors', 'objects', 'done')),
  -- Optimistic-lock version. Every write bumps it; every write is conditional
  -- on the value the writer last read or wrote.
  lease_seq INTEGER NOT NULL DEFAULT 0,
  -- Advisory only (see above): how recently the owner was alive, so cron can
  -- skip a tenant whose job is still running.
  updated_at_ms INTEGER NOT NULL,
  -- Vectors-phase resume point, by VALUE: the last reading id submitted to
  -- deleteByIds. Reading ids are re-derived from R2 each delivery and the phase
  -- is batch-bounded, so without this a tenant larger than one delivery's worth
  -- of ids re-submits the same batch forever. Dropped with `collectReadingIds`
  -- when S3's vector ledger takes R2 out of the id-source role.
  vector_cursor TEXT,
  -- Objects-phase R2 list cursor.
  r2_cursor TEXT,
  force INTEGER NOT NULL DEFAULT 0,
  objects_deleted INTEGER NOT NULL DEFAULT 0,
  -- JSON array of Vectorize mutation ids submitted by this wipe. Opaque
  -- handles, not reading ids.
  mutation_ids TEXT NOT NULL DEFAULT '[]',
  -- Whole-index vector count sampled once at the start of a pass, for the
  -- terminal delta log. `index_count_sampled` distinguishes "not sampled yet"
  -- from "sampled, but the binding has no describe()" (NULL count).
  index_count_sampled INTEGER NOT NULL DEFAULT 0,
  index_count_start INTEGER,
  -- Terminal namespace probes that failed to confirm this pass, and whether any
  -- of them actually saw a vector (sticky, so a later transient probe error
  -- cannot downgrade an observed finding to "could not check").
  probe_attempts INTEGER NOT NULL DEFAULT 0,
  probe_saw_residue INTEGER NOT NULL DEFAULT 0,
  -- Self-sent `continue` deliveries in this pass. Bounds a wipe that makes a
  -- little progress and then fails forever, which would otherwise reset its
  -- queue retry budget on every self-send and never reach the DLQ (F7).
  continuations INTEGER NOT NULL DEFAULT 0,
  -- Completion record. `residue = 1` means the wipe finished without a clean
  -- namespace confirmation; read alongside `probe_saw_residue` it separates
  -- "vectors were still there" from "we never got an answer".
  completed_at_ms INTEGER,
  residue INTEGER NOT NULL DEFAULT 0
);

-- Fan-out reads every unfinished wipe on each cron tick.
CREATE INDEX wipe_progress_unfinished
  ON wipe_progress (tenant_id)
  WHERE completed_at_ms IS NULL;
