-- The hosted nightly refresh's tension checkpoints (reading-lite-mtdh).
--
-- The sibling of relationship_refresh_jobs (0003) for pairwise tension
-- judgements: one latest checkpoint per tenant and unordered pair, never one
-- per nightly run. A pair is stored canonically, reading_a < reading_b, so
-- (a,b) and (b,a) are one row. A NULL result means a provider dispatch may
-- have happened: a duplicate must not call the provider again unless retry_at
-- records a confirmed rate limit. result_json holds the judgement and the
-- hashes of the two readings it produced, so a replay can publish it without
-- another provider call.
--
-- No foreign key to either reading, like relationship_refresh_jobs: purge
-- deletes the rows naming the purged reading on either side (hence the
-- reading_b index), the account wipe deletes the tenant's rows, and teardown
-- deletes them before the users row.
CREATE TABLE tension_refresh_jobs (
  tenant_id text NOT NULL REFERENCES users (id),
  reading_a text NOT NULL,
  reading_b text NOT NULL,
  run_at timestamptz NOT NULL,
  owner text NOT NULL,
  -- The version (manifest hash) of each side the judgement was dispatched on.
  a_version text NOT NULL,
  b_version text NOT NULL,
  result_json jsonb,
  retry_at timestamptz,
  PRIMARY KEY (tenant_id, reading_a, reading_b),
  CHECK (reading_a < reading_b)
);

CREATE INDEX tension_refresh_jobs_reading_b ON tension_refresh_jobs (tenant_id, reading_b);
