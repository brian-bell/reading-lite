-- Anthropic tenant keys (reading-lite-gh341.15.2; ADR 0004, amended 2026-10-03).
--
-- A tenant may store an Anthropic key beside its required OpenAI key, one row
-- per (tenant_id, provider), and choose which provider summarizes. Embeddings
-- always use the OpenAI key. Removing the Anthropic key resets the choice to
-- openai in the same transaction; an Anthropic key marked invalid leaves it.
ALTER TABLE tenant_provider_credentials
  DROP CONSTRAINT tenant_provider_credentials_provider_check,
  ADD CONSTRAINT tenant_provider_credentials_provider_check
    CHECK (provider IN ('openai', 'anthropic'));

ALTER TABLE user_settings
  ADD COLUMN summarization_provider text NOT NULL DEFAULT 'openai'
    CHECK (summarization_provider IN ('openai', 'anthropic'));
