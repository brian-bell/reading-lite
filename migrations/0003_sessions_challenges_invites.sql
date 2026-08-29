-- Browser sessions, newest-only magic-link challenges, and invite eligibility
-- records (ADR 0001). Invites are not bearer URLs; an invited address still
-- completes the 15-minute magic-link flow.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  secret_hmac TEXT NOT NULL,
  hash_key_version INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  authenticated_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  idle_expires_at_ms INTEGER NOT NULL,
  absolute_expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  revocation_reason TEXT,
  user_agent_label TEXT,
  created_from_claim_id TEXT NOT NULL
);

CREATE INDEX sessions_user_id ON sessions (user_id);
-- Claim ids are client-chosen. Uniqueness is per user so a reused id cannot
-- attach to another account's session. Idempotent retry looks up this pair.
CREATE UNIQUE INDEX sessions_user_claim ON sessions (user_id, created_from_claim_id);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'email_change')),
  email_canonical TEXT NOT NULL,
  email_display TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  secret_hmac TEXT NOT NULL,
  hash_key_version INTEGER NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('issued', 'claimed', 'consumed', 'revoked')),
  claim_id TEXT,
  claimed_at_ms INTEGER,
  consumed_at_ms INTEGER,
  completed_user_id TEXT,
  completed_session_id TEXT
);

CREATE INDEX auth_challenges_email_purpose ON auth_challenges (email_canonical, purpose, issued_at_ms DESC);
-- Newest-only: at most one issued login/email-change challenge per address.
CREATE UNIQUE INDEX auth_challenges_one_issued
  ON auth_challenges (email_canonical, purpose)
  WHERE state = 'issued';

CREATE TABLE signup_invites (
  email_canonical TEXT PRIMARY KEY,
  email_display TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  consumed_at_ms INTEGER
);

-- Local-only magic-link outbox. Production/staging never enable LOCAL_MAIL_SINK,
-- so this table stays empty there. The credential column is the test interface;
-- it is never logged.
CREATE TABLE dev_mail_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  verify_url TEXT NOT NULL,
  sent_at_ms INTEGER NOT NULL
);
