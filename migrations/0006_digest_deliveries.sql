-- Digest delivery ledger (issue 196 B1). Unique (user_id, cadence, period_key)
-- is the CAS key that prevents a second send for one local day / ISO week.
CREATE TABLE digest_deliveries (
  user_id TEXT NOT NULL REFERENCES users(id),
  cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  period_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  skip_reason TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, cadence, period_key)
);

CREATE INDEX digest_deliveries_status ON digest_deliveries (status);

-- Due-user helper: the cron scans enabled cadences only.
CREATE INDEX user_settings_digest_enabled
  ON user_settings (digest_cadence)
  WHERE digest_cadence IN ('daily', 'weekly');
