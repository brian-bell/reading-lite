-- Correct wipe_progress.phase's documented order (ADR 0005, slice 1c.4).
--
-- 0003's comment says the wipe deletes a tenant's R2 objects and then its
-- reading rows, "as the account-deletion contract requires". That reads the
-- contract wrong. The contract is that vector deletes precede object deletes,
-- and an embedding is a row now, so rows go FIRST: the `rows` phase deletes
-- the tenant's reading rows (embeddings by cascade) and its refresh
-- checkpoints, and the `objects` phase then pages R2. A reading whose objects
-- outlive its row is invisible; the reverse would be a listed reading whose
-- content 404s. The code always ran rows first — only 0003's comment and ADR
-- 0005 disagreed.
--
-- 0003 is applied, and an applied file is never edited (AGENTS.md), so the
-- correction lands here instead, on the column itself where a reader of the
-- live schema will find it. `CHECK (phase IN (...))` needs no change: the list
-- is a set, not a sequence.
COMMENT ON COLUMN wipe_progress.phase IS
  'Wipe phase, in order: rows (reading rows and refresh checkpoints), then objects (R2), then done. Rows go first — an embedding is a row, and the account-deletion contract puts embedding deletes before object deletes.';
