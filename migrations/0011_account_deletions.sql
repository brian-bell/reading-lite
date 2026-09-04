-- Account-deletion audit record (issue 195 S4 / #263, design decision E).
--
-- This is the one row that OUTLIVES the account. Every other row keyed to the
-- tenant — `users` itself, `user_settings`, `tenant_limits`, `api_tokens`,
-- `api_token_scopes`, `sessions`, `auth_challenges`, `digest_deliveries`, the
-- account's own `signup_invites` rows, and `wipe_progress` — is deleted by
-- `src/control-plane/account-teardown.ts`. This one stays.
--
-- Why it is a separate table rather than "keep the wipe_progress row":
-- `wipe_progress.tenant_id REFERENCES users(id)`, and teardown's whole job is
-- to remove that `users` row. A record that points at a deleted user is a
-- dangling reference at best and, the day `PRAGMA foreign_keys = ON` is ever
-- turned on, an unsatisfiable one. So the audit row deliberately carries **no
-- foreign key at all**: it must survive the row it describes, which is exactly
-- the property a foreign key would deny it.
--
-- Nothing here cascades, and nothing anywhere else in this schema does either
-- (every `REFERENCES` in migrations 0001-0009 is bare). A cascade from `users`
-- would destroy the completion evidence at the very moment teardown reads it
-- to decide it may act. Teardown therefore deletes `wipe_progress` explicitly,
-- in order, after the gate has been read — the ordering is the code's
-- responsibility, not the database's.
--
-- What it deliberately does NOT carry: no email address, no display name, no
-- reading ids, no counts of what the account held. A deletion request is meant
-- to remove exactly those, so the audit of the deletion must not reintroduce
-- them. What is left is a tenant id (already an opaque `usr_` uuid), three
-- timestamps-or-flags, and no way to work backwards to a person.
CREATE TABLE account_deletions (
  -- Deliberately NO `REFERENCES users(id)`: see above.
  tenant_id TEXT PRIMARY KEY,
  -- When `DELETE /api/account` fenced the account (`users.deleting_at_ms`).
  -- NULLABLE, unlike the design sketch: S2 added the
  -- `account_wipe_missing_deleting_at` log precisely because a `deleting` row
  -- with a NULL `deleting_at_ms` is a state that occurs. NOT NULL here would
  -- force teardown to fabricate a timestamp for the one case the log exists to
  -- surface, so the column records "not known" instead of inventing an answer.
  deleting_at_ms INTEGER,
  -- When the data-plane wipe reported terminal
  -- (`wipe_progress.completed_at_ms`, the current-state field teardown gates
  -- on), and whether that wipe confirmed the tenant's Vectorize namespace
  -- clean. `residue = 1` means it did not — see `wipe_progress.residue`.
  completed_at_ms INTEGER NOT NULL,
  residue INTEGER NOT NULL DEFAULT 0,
  -- The wipe's durable history, copied across before `wipe_progress` is
  -- deleted. `wipe_progress` pins these two write-once in SQL precisely so a
  -- reopen that never finishes cannot erase the fact that the tenant's data
  -- plane was wiped at least once and whether that wipe came back clean — and
  -- teardown then deletes the row that holds them. Without carrying them here,
  -- a `residue = 1` tenant ends up with stranded vectors, no users row, no wipe
  -- row, and nothing for the residue scan (S5) to read. Neither column carries
  -- anything a deletion request covers: a timestamp and a flag.
  first_completed_at_ms INTEGER,
  first_residue INTEGER NOT NULL DEFAULT 0,
  -- When teardown BEGAN — stamped as this row is written, which happens before
  -- a single destructive delete, so a crash part-way through still leaves
  -- durable evidence that the account's teardown was attempted and when. It is
  -- distinct from `completed_at_ms`, because the data-plane wipe can finish a
  -- cron interval or more before the control plane is torn down. A retry after
  -- a crash preserves the original stamp rather than moving it.
  torn_down_at_ms INTEGER NOT NULL
);

-- Teardown reaches `auth_challenges` by owner twice: once to collect every
-- address the account ever used, and once to delete its rows inside the
-- all-or-nothing batch. Migration 0003 indexes only
-- `(email_canonical, purpose, issued_at_ms)` and the partial one-issued index,
-- so both were full scans of a table nothing prunes.
--
-- This is not really about speed. A scan that grows without bound is a scan
-- that can eventually trip a D1 rows-read or duration limit, and that throw
-- lands *inside* the batch — which would wedge teardown on every cron tick
-- forever, with the audit row already written and nothing deleted. That is the
-- same failure mode the invite-delete chunking exists to prevent, so it gets
-- the same treatment.
CREATE INDEX auth_challenges_user_id ON auth_challenges (user_id);
CREATE INDEX auth_challenges_completed_user_id ON auth_challenges (completed_user_id);
