-- Bind email_change challenges to the session that requested the change.
-- Confirming redeem must present that live session; cookie-less / other-session
-- redeem does not swap. No FK: sessions are soft-revoked, not deleted.
ALTER TABLE auth_challenges ADD COLUMN bound_session_id TEXT;
