CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email_canonical TEXT NOT NULL UNIQUE,
  email_display TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'deleting')),
  email_verified_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  suspended_at_ms INTEGER,
  deleting_at_ms INTEGER
);

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  schema_version INTEGER NOT NULL,
  notify_immediate INTEGER NOT NULL CHECK (notify_immediate IN (0, 1)),
  digest_cadence TEXT NOT NULL CHECK (digest_cadence IN ('off', 'daily', 'weekly')),
  time_zone TEXT NOT NULL,
  digest_hour_local INTEGER NOT NULL,
  digest_weekday INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE tenant_limits (
  tenant_id TEXT PRIMARY KEY REFERENCES users(id),
  policy_version INTEGER NOT NULL,
  submissions_per_hour INTEGER NOT NULL CHECK (submissions_per_hour > 0),
  monthly_readings INTEGER NOT NULL CHECK (monthly_readings > 0),
  max_concurrent_work INTEGER NOT NULL CHECK (max_concurrent_work > 0),
  daily_spend_microdollars INTEGER NOT NULL CHECK (daily_spend_microdollars > 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('legacy', 'standard')),
  secret_hmac TEXT NOT NULL,
  hash_key_version INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  last_used_at_ms INTEGER,
  user_agent_label TEXT
);

CREATE UNIQUE INDEX api_tokens_secret_hmac ON api_tokens (secret_hmac);
CREATE INDEX api_tokens_user_id ON api_tokens (user_id);

CREATE TABLE api_token_scopes (
  token_id TEXT NOT NULL REFERENCES api_tokens(id),
  scope TEXT NOT NULL CHECK (scope IN ('readings:read', 'readings:write', 'readings:import')),
  PRIMARY KEY (token_id, scope)
);

CREATE TABLE system_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  signup_mode TEXT NOT NULL CHECK (signup_mode IN ('closed', 'invite_only', 'open')),
  paid_work_enabled INTEGER NOT NULL CHECK (paid_work_enabled IN (0, 1)),
  policy_version INTEGER NOT NULL,
  catalog_version INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
