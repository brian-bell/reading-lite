CREATE TABLE tenant_provider_credentials (
  tenant_id text NOT NULL REFERENCES users (id),
  provider text NOT NULL CHECK (provider IN ('openai')),
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  key_version integer NOT NULL CHECK (key_version >= 0),
  credential_version integer NOT NULL CHECK (credential_version > 0),
  last_four text NOT NULL CHECK (char_length(last_four) = 4),
  status text NOT NULL CHECK (status IN ('active', 'invalid')),
  validated_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, provider)
);

ALTER TABLE user_settings
  ADD COLUMN summarization_effort text NOT NULL DEFAULT 'high'
    CHECK (summarization_effort IN ('low', 'medium', 'high')),
  ADD COLUMN daily_spend_cap_microdollars bigint
    CHECK (daily_spend_cap_microdollars > 0);
