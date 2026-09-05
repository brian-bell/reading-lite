-- #200: a NULL global ceiling is deliberately fail-closed.  Deployment does
-- not invent a production budget; policy tooling must set one explicitly.
ALTER TABLE system_policy
  ADD COLUMN daily_spend_microdollars INTEGER CHECK (daily_spend_microdollars > 0);
