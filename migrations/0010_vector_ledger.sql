-- Durable per-tenant vector-id ledger (issue #195 slice S3 / #261).
--
-- WHY THIS TABLE EXISTS
--
-- Vectorize exposes no list or scan at any scope, so a vector can only be
-- deleted by an id you already hold. Until now the account wipe derived those
-- ids from R2 (`index/list.json`, `index/by-id/`, the `readings/` key layout).
-- That made R2 the id source, and it stranded every vector whose R2 objects
-- were gone first: `src/account-wipe.ts`'s header listed four such races,
-- including the offline vector writers (`corpus backfill-vectors`,
-- `corpus migrate-founder`, `batch/write-phase`), which check no `users.status`
-- and can upsert into a tenant whose wipe is already past its vectors phase.
--
-- This table takes R2 out of that role. Every vector writer records the id here
-- BEFORE it upserts, so the id outlives the R2 objects and the wipe terminates
-- on "no rows left for this tenant" rather than "the R2 prefix is empty".
--
-- NO `ON DELETE CASCADE`, like every other table in this schema. S4's
-- control-plane teardown deletes these rows explicitly, after it has read the
-- gate it needs; a cascade would destroy the evidence at the moment it is used.
-- (As with 0001-0009 this `REFERENCES` is a declaration of intent: nothing sets
-- `PRAGMA foreign_keys = ON`. Ordering is the caller's responsibility either
-- way, which is exactly why it must not be delegated to a cascade.)
--
-- INDEPENDENT OF 0011. Migration 0011 (S4's `account_deletions` audit table) is
-- being built in parallel. This migration references nothing but `users`, so
-- the two apply cleanly in either order.
CREATE TABLE vector_ledger (
  tenant_id TEXT NOT NULL REFERENCES users(id),
  -- The BARE reading id (`rd_…`), never the `{tenantId}:{readingId}` vector id.
  -- The composition rule lives in one place, `tenantVectorId` in
  -- src/modules/stores/similarity-store.ts, and a stored copy of its output
  -- would be a second spelling of it that could drift.
  reading_id TEXT NOT NULL,
  -- `live`             — a vector was (or is about to be) upserted for this id.
  -- `delete_submitted` — `deleteByIds` has been submitted for it. Vectorize
  --                      deletes are asynchronous, so this is a claim about
  --                      what we asked for, never about what the index holds.
  --
  -- A row is DELETED, not moved to a third state, once the confirmation rule in
  -- src/control-plane/vector-ledger.ts says the vector is gone. An empty ledger
  -- for a tenant is what "this tenant has no vectors left" means.
  state TEXT NOT NULL CHECK (state IN ('live', 'delete_submitted')),
  upserted_at_ms INTEGER NOT NULL,
  -- When `deleteByIds` was submitted. Load-bearing, not decorative: the first
  -- confirmation attempt is only allowed at +120s from this stamp, because S6
  -- measured `deleteByIds` propagation at 30-90s and a probe inside that window
  -- carries no information (report rl-195-s6-staging-gate §5.2).
  deleted_at_ms INTEGER,
  -- Consecutive `getByIds` calls that returned 200 WITHOUT this id, each one at
  -- least VECTOR_LEDGER_MIN_CONFIRM_SPACING_MS after the last. The row clears at
  -- two. A non-200 response resets this to 0 — it is no information, and the
  -- 20-id REST cap makes that concrete: a 21-id chunk answers 400 with an empty
  -- body, which a naive reader would take as "all 21 are gone".
  absent_streak INTEGER NOT NULL DEFAULT 0,
  -- When the most recent counted absence was observed, so the spacing rule can
  -- be enforced across deliveries. Two calls back to back inside one isolate
  -- hit the same replica milliseconds apart and confirm nothing; the spacing is
  -- the load-bearing half of the rule, not the count.
  last_absent_at_ms INTEGER,
  PRIMARY KEY (tenant_id, reading_id)
);

-- The wipe's two hot reads: "which ids still need submitting" (state = 'live')
-- and "is this tenant's ledger empty".
CREATE INDEX vector_ledger_tenant_state ON vector_ledger (tenant_id, state);

-- `vector_cursor` retires with `collectReadingIds`.
--
-- It was the vectors phase's resume point by VALUE — the last reading id
-- submitted to `deleteByIds` — needed only because ids were re-derived from a
-- full R2 re-list on every delivery and the phase is batch-bounded. The ledger
-- resumes on `state = 'live'` instead, which advances itself as ids are
-- submitted and, unlike a forward-only cursor, cannot miss an id that first
-- appears below it. Nothing reads or writes the column after this slice.
--
-- ITS DATA IS CLEARED; THE COLUMN IS NOT DROPPED, and the difference is
-- deliberate.
--
-- Clearing is not optional: the value is a reading id, and the completion
-- record outlives the account until S4's teardown, so leaving one behind would
-- put a reading id on a row about a deleted tenant — exactly the leak that
-- moved this state out of R2 (0009's header, and `ops account
-- sweep-wipe-prefix`).
--
-- The UPDATE settles that for every row that exists when it runs, which is not
-- quite the same as settling it forever. Migrations apply BEFORE the new Worker
-- uploads, so a wipe in flight during that window can have the old code write
-- the column again a moment after this clears it — and nothing clears it a
-- second time, because the new code neither reads nor writes it. That is why
-- the runbook's first step before merging is to check for an unfinished
-- wipe_progress row, and why the eventual column drop is what closes it for
-- good.
--
-- Dropping it would buy nothing and cost two things. `ops deploy worker`
-- applies migrations and THEN uploads, so a dropped column breaks the previous
-- Worker for the length of the deploy — and not only its writes: the old
-- `COLUMNS` list in wipe-progress.ts SELECTs `vector_cursor` too, so cron
-- fan-out and every resuming delivery would throw as well. Worse, D1 has no
-- reverse migration here, so a Worker ROLLBACK would leave that state
-- permanent rather than lasting one deploy window. An unread, always-NULL
-- column is free; a rollback that cannot read `wipe_progress` at all is not.
-- Drop it in a later migration once rolling back past this slice is no longer
-- a consideration.
UPDATE wipe_progress SET vector_cursor = NULL;

-- Ledger-coverage verification, recorded once per wipe.
--
-- `src/account-wipe.ts` refuses to delete a tenant's R2 objects while a reading
-- that should own a vector has no ledger row, because R2 is the only source
-- `ops corpus seed-vector-ledger` can derive those ids from. That check has to
-- run BEFORE the vectors phase — once deletes are submitted the rows flip to
-- `delete_submitted` and a live-row count no longer measures coverage — and it
-- must not re-run on every delivery, because the walk is not free.
--
-- So the verdict is stamped here the first time it passes, and every later
-- delivery of the same wipe honours it. A reopen clears it, because a reopened
-- wipe is looking at a corpus that has changed since.
ALTER TABLE wipe_progress ADD COLUMN coverage_verified_at_ms INTEGER;
