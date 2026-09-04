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
--
-- Note this is a declaration of intent more than an enforced constraint: like
-- every other `REFERENCES` in migrations 0001-0008, it does nothing at runtime
-- unless `PRAGMA foreign_keys = ON`, which this codebase never sets. Declaring
-- no-cascade still matters — it is what the schema means, and it is what would
-- happen if enforcement were ever turned on — but S4 must delete this row
-- explicitly because the ordering is its own responsibility, not the database's.
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
  -- Completion record, in two pairs, because they answer different questions.
  --
  -- `completed_at_ms` / `residue` describe the CURRENT state: the wipe has
  -- nothing left to do. Reopening a finished wipe (leftover objects turned up
  -- under the prefix) clears them, which is what makes them the right thing for
  -- the later teardown to gate on — it must not hard-delete the users row while
  -- a reopened pass is still running.
  --
  -- `first_completed_at_ms` / `first_residue` are written ONCE, at the first
  -- terminal transition, and never overwritten or cleared. They are the durable
  -- history: proof that this tenant's data plane was wiped at least once, and
  -- whether that wipe came back clean. Without them a reopen that fails or
  -- dead-letters would erase the only evidence the earlier wipe ever finished —
  -- destroying, at the moment it is needed, exactly what the non-cascading
  -- foreign key above exists to preserve. The residue scan reads this pair.
  --
  -- `residue = 1` means the wipe finished without a clean namespace
  -- confirmation; read alongside `probe_saw_residue` it separates "vectors were
  -- still there" from "we never got an answer".
  completed_at_ms INTEGER,
  residue INTEGER NOT NULL DEFAULT 0,
  first_completed_at_ms INTEGER,
  first_residue INTEGER NOT NULL DEFAULT 0
);

-- Fan-out reads every unfinished wipe on each cron tick.
CREATE INDEX wipe_progress_unfinished
  ON wipe_progress (tenant_id)
  WHERE completed_at_ms IS NULL;
