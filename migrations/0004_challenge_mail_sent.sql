-- Delivery marker so failed overlapping replacements restore only a
-- predecessor whose magic-link mail actually went out.
ALTER TABLE auth_challenges ADD COLUMN mail_sent_at_ms INTEGER;
