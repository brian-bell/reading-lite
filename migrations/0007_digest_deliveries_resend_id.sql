-- Digest send receipt (issue 196 B2). Resend message id stored on success.
ALTER TABLE digest_deliveries ADD COLUMN resend_id TEXT;
