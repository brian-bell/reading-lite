-- The desk (reading-lite-kl7y.6): at most three readings a person has set
-- aside to read next, in order.
--
-- A side table, not a readings column: a toggle must not write the reading
-- row, whose xmin startAttempt compares as the row's version, or a toggle
-- would make a concurrent reprocess see "changed". Not the control plane
-- either: the foreign key cascades, so a wipe or a purge frees the slot with
-- no deletion code of its own, and the reading reads join it.
--
-- Writers serialize on a per-tenant advisory lock, because the row being
-- added may not exist yet, and renumber 1..n on every write so a purge's gap
-- closes on the next one. The position constraint is deferred so that
-- renumbering can pass through a duplicate within its statement.
CREATE TABLE reading_desk (
  tenant_id text NOT NULL,
  reading_id text NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  added_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, reading_id),
  UNIQUE (tenant_id, position) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, reading_id) REFERENCES readings (tenant_id, id) ON DELETE CASCADE
);
