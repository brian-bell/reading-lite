-- Control-plane tables (ADR 0005, slice 1c). These replace the D1 database
-- (`migrations/`): accounts, sessions, magic-link challenges, invites, API
-- tokens, settings, limits, the policy singleton, the digest ledger, refresh
-- checkpoints, account-wipe progress, and the deletion audit.
--
-- Column semantics match D1 so #348 can import rows with an explicit mapping
-- per column (the table in ADR 0005). What changes is the type:
--
--   *_at_ms INTEGER  -> *_at timestamptz (the _ms suffix goes with the unit)
--   0/1 INTEGER flag -> boolean
--   JSON as TEXT     -> jsonb
--   run_at ISO TEXT  -> timestamptz
--   microdollars     -> bigint
--
-- The TypeScript domain stays epoch milliseconds; src/control-plane/pg-time.ts
-- converts at the query boundary and nowhere else.
--
-- Foreign keys are the same set D1 declared, and none cascades. Account
-- teardown reads wipe_progress to decide it may delete the users row, so a
-- cascade would destroy that evidence at the moment it is needed; teardown
-- deletes every account-owned row explicitly, in order. PostgreSQL always
-- enforces these, where D1's were conditional on a pragma.
--
-- vector_ledger and vector_ledger_retained are deliberately not recreated:
-- embeddings are rows of reading_embeddings and delete with their reading in
-- one transaction, so there is no separate id ledger to keep in step.

CREATE TABLE users (
  id text PRIMARY KEY,
  email_canonical text NOT NULL UNIQUE,
  email_display text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'suspended', 'deleting')),
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  suspended_at timestamptz,
  deleting_at timestamptz
);

CREATE TABLE user_settings (
  user_id text PRIMARY KEY REFERENCES users (id),
  schema_version integer NOT NULL,
  notify_immediate boolean NOT NULL,
  digest_cadence text NOT NULL CHECK (digest_cadence IN ('off', 'daily', 'weekly')),
  time_zone text NOT NULL,
  digest_hour_local integer NOT NULL,
  digest_weekday integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- Due-user helper: the cron scans enabled cadences only.
CREATE INDEX user_settings_digest_enabled
  ON user_settings (digest_cadence)
  WHERE digest_cadence IN ('daily', 'weekly');

CREATE TABLE tenant_limits (
  tenant_id text PRIMARY KEY REFERENCES users (id),
  policy_version integer NOT NULL,
  submissions_per_hour integer NOT NULL CHECK (submissions_per_hour > 0),
  monthly_readings integer NOT NULL CHECK (monthly_readings > 0),
  max_concurrent_work integer NOT NULL CHECK (max_concurrent_work > 0),
  daily_spend_microdollars bigint NOT NULL CHECK (daily_spend_microdollars > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE api_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (id),
  name text NOT NULL,
  format text NOT NULL CHECK (format IN ('legacy', 'standard')),
  secret_hmac text NOT NULL,
  hash_key_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  user_agent_label text
);

CREATE UNIQUE INDEX api_tokens_secret_hmac ON api_tokens (secret_hmac);
CREATE INDEX api_tokens_user_id ON api_tokens (user_id);

CREATE TABLE api_token_scopes (
  token_id text NOT NULL REFERENCES api_tokens (id),
  scope text NOT NULL CHECK (scope IN ('readings:read', 'readings:write', 'readings:import', 'readings:delete')),
  PRIMARY KEY (token_id, scope)
);

-- A NULL global spend ceiling is deliberately fail-closed: deployment does not
-- invent a production budget; policy tooling must set one explicitly.
CREATE TABLE system_policy (
  id integer PRIMARY KEY CHECK (id = 1),
  signup_mode text NOT NULL CHECK (signup_mode IN ('closed', 'invite_only', 'open')),
  paid_work_enabled boolean NOT NULL,
  policy_version integer NOT NULL,
  catalog_version integer NOT NULL,
  updated_at timestamptz NOT NULL,
  max_concurrent_work integer NOT NULL DEFAULT 3,
  daily_spend_microdollars bigint CHECK (daily_spend_microdollars > 0)
);

-- Browser sessions, newest-only magic-link challenges, and invite eligibility
-- records (ADR 0001). Invites are not bearer URLs; an invited address still
-- completes the 15-minute magic-link flow.
CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (id),
  secret_hmac text NOT NULL,
  hash_key_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  authenticated_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  user_agent_label text,
  created_from_claim_id text NOT NULL
);

CREATE INDEX sessions_user_id ON sessions (user_id);
-- Claim ids are client-chosen. Uniqueness is per user so a reused id cannot
-- attach to another account's session. Idempotent retry looks up this pair.
CREATE UNIQUE INDEX sessions_user_claim ON sessions (user_id, created_from_claim_id);

CREATE TABLE auth_challenges (
  id text PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('login', 'email_change')),
  email_canonical text NOT NULL,
  email_display text NOT NULL,
  user_id text REFERENCES users (id),
  secret_hmac text NOT NULL,
  hash_key_version integer NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('issued', 'claimed', 'consumed', 'revoked')),
  claim_id text,
  claimed_at timestamptz,
  consumed_at timestamptz,
  completed_user_id text,
  completed_session_id text,
  -- Delivery marker so failed overlapping replacements restore only a
  -- predecessor whose magic-link mail actually went out.
  mail_sent_at timestamptz,
  -- Binds an email_change challenge to the session that requested it. No FK:
  -- sessions are soft-revoked, not deleted.
  bound_session_id text
);

CREATE INDEX auth_challenges_email_purpose ON auth_challenges (email_canonical, purpose, issued_at DESC);
-- Newest-only: at most one issued login/email-change challenge per address.
CREATE UNIQUE INDEX auth_challenges_one_issued
  ON auth_challenges (email_canonical, purpose)
  WHERE state = 'issued';
-- Teardown reaches challenges by owner, to collect every address the account
-- used and to delete its rows; nothing else prunes this table.
CREATE INDEX auth_challenges_user_id ON auth_challenges (user_id);
CREATE INDEX auth_challenges_completed_user_id ON auth_challenges (completed_user_id);

CREATE TABLE signup_invites (
  email_canonical text PRIMARY KEY,
  email_display text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  consumed_at timestamptz
);

-- Local-only magic-link outbox. Production and staging never enable
-- LOCAL_MAIL_SINK, so this table stays empty there. verify_url is the test
-- interface; it is never logged.
CREATE TABLE dev_mail_outbox (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  to_email text NOT NULL,
  subject text NOT NULL,
  verify_url text NOT NULL,
  sent_at timestamptz NOT NULL
);

-- Digest delivery ledger. The primary key is the CAS key that prevents a
-- second send for one local day or ISO week.
CREATE TABLE digest_deliveries (
  user_id text NOT NULL REFERENCES users (id),
  cadence text NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  period_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  skip_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- Resend message id, stored on success.
  resend_id text,
  PRIMARY KEY (user_id, cadence, period_key)
);

CREATE INDEX digest_deliveries_status ON digest_deliveries (status);

-- One latest refresh checkpoint per tenant and reading, never one per nightly
-- run. A NULL result means a provider dispatch may have happened: a duplicate
-- must not call the provider again unless retry_at records a confirmed rate
-- limit. Purge and account teardown delete these checkpoints.
CREATE TABLE relationship_refresh_jobs (
  tenant_id text NOT NULL REFERENCES users (id),
  reading_id text NOT NULL,
  run_at timestamptz NOT NULL,
  owner text NOT NULL,
  source_etag text NOT NULL,
  result_json jsonb,
  retry_at timestamptz,
  PRIMARY KEY (tenant_id, reading_id)
);

-- Account-wipe progress, lease, and completion record.
--
-- The lease is `WHERE tenant_id = $1 AND lease_seq = $2` on a monotonic
-- counter, so ownership never depends on the wall clock: zero rows updated
-- means a sibling owns this wipe. updated_at is only the advisory hint cron
-- uses to avoid enqueuing a duplicate it would then turn away.
--
-- The row is kept after completion. It holds no reading id (the cursor is
-- cleared) and is the evidence teardown gates its delete of the users row on.
--
-- D1's Vectorize-only columns (vector_cursor, mutation_ids, index_count_*,
-- probe_*, seed_*) have no counterpart: an embedding is a row now, so there is
-- nothing to submit, confirm or seed. The `rows` phase deletes the tenant's
-- reading rows (embeddings by cascade) and its refresh checkpoints, and the
-- `objects` phase then pages R2. Rows go FIRST, which is the same contract
-- D1's wipe kept by submitting vector deletes before object deletes: a reading
-- whose objects outlive its row is invisible, where the reverse would be a
-- listed reading whose content 404s.
CREATE TABLE wipe_progress (
  tenant_id text PRIMARY KEY REFERENCES users (id),
  phase text NOT NULL CHECK (phase IN ('rows', 'objects', 'done')),
  -- Optimistic-lock version. Every write bumps it and is conditional on the
  -- value the writer last read or wrote.
  lease_seq integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL,
  -- Objects-phase R2 list cursor.
  r2_cursor text,
  force boolean NOT NULL DEFAULT false,
  objects_deleted integer NOT NULL DEFAULT 0,
  -- Self-sent `continue` deliveries in this pass. Bounds a wipe that makes a
  -- little progress and then fails forever, which would otherwise reset its
  -- queue retry budget on every self-send and never reach the DLQ.
  continuations integer NOT NULL DEFAULT 0,
  -- completed_at and residue describe the current state; reopening a finished
  -- wipe clears them, which is why teardown gates on them. The first_ pair is
  -- written once, at the first terminal transition, and never cleared: proof
  -- that the data plane was wiped at least once and whether it came back clean.
  completed_at timestamptz,
  residue boolean NOT NULL DEFAULT false,
  first_completed_at timestamptz,
  first_residue boolean NOT NULL DEFAULT false
);

-- Fan-out reads every unfinished wipe on each cron tick.
CREATE INDEX wipe_progress_unfinished
  ON wipe_progress (tenant_id)
  WHERE completed_at IS NULL;

-- Account-deletion audit. It outlives the account, so it carries no foreign
-- key at all: teardown removes the users row this describes. It also carries
-- no email, display name, reading id or count, which a deletion request
-- covers; what is left is an opaque tenant id, timestamps and flags.
CREATE TABLE account_deletions (
  tenant_id text PRIMARY KEY,
  -- When DELETE /api/account fenced the account. Nullable: a `deleting` row
  -- with no deleting_at occurs, and the audit records "not known" rather than
  -- inventing a timestamp.
  deleting_at timestamptz,
  completed_at timestamptz NOT NULL,
  residue boolean NOT NULL DEFAULT false,
  -- The wipe's write-once history, copied across before wipe_progress goes.
  first_completed_at timestamptz,
  first_residue boolean NOT NULL DEFAULT false,
  -- When teardown began, stamped before any destructive delete so a crash part
  -- way through still leaves evidence. A retry preserves the original stamp.
  torn_down_at timestamptz NOT NULL
);
