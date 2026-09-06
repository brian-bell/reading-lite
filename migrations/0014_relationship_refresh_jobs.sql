-- One latest refresh checkpoint per tenant/reading, never one per nightly run.
-- Null result means a provider dispatch may have happened: a duplicate must not
-- call the provider again unless retry_at_ms records a confirmed rate limit.
-- Purge and account teardown delete these checkpoints.
CREATE TABLE relationship_refresh_jobs (
  tenant_id TEXT NOT NULL REFERENCES users(id),
  reading_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  owner TEXT NOT NULL,
  source_etag TEXT NOT NULL,
  result_json TEXT,
  retry_at_ms INTEGER,
  PRIMARY KEY (tenant_id, reading_id)
);
