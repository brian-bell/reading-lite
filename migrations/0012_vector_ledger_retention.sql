-- S4 must retain unconfirmed vector ids after control-plane teardown.
-- D1 enforces foreign keys by default: 0010's REFERENCES users(id) prevents
-- deleting a user when a residue wipe has deliberately kept its ledger rows.
-- Like account_deletions, this repair evidence must outlive the users row.
-- Rebuild with identical columns, constraints, data and index, except that FK.
-- No ledger rows are discarded and existing writers remain compatible.
CREATE TABLE vector_ledger_retained (
  tenant_id TEXT NOT NULL,
  reading_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('live', 'delete_submitted')),
  upserted_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  absent_streak INTEGER NOT NULL DEFAULT 0,
  last_absent_at_ms INTEGER,
  PRIMARY KEY (tenant_id, reading_id)
);

INSERT INTO vector_ledger_retained (
  tenant_id, reading_id, state, upserted_at_ms, deleted_at_ms,
  absent_streak, last_absent_at_ms
)
SELECT tenant_id, reading_id, state, upserted_at_ms, deleted_at_ms,
       absent_streak, last_absent_at_ms
FROM vector_ledger;

DROP TABLE vector_ledger;
ALTER TABLE vector_ledger_retained RENAME TO vector_ledger;
CREATE INDEX vector_ledger_tenant_state ON vector_ledger (tenant_id, state);
