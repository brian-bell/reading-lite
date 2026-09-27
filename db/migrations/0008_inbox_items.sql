-- The tenant's Markdown inbox (reading-lite-gh423). An inbox item is Markdown
-- an agent staged for a person to review before it becomes a reading; nothing
-- is billed, claimed or listed until a person promotes it.
--
-- The one exception to "content bytes stay in R2" (0001): this text is input
-- awaiting review, not captured content. It is capped at 128_000 bytes, the
-- queue envelope importMarkdown carries it in, so an item that could never be
-- promoted is refused at stage. Promote hands it to importMarkdown, which
-- writes the reading's content to R2 like any other import.
--
-- Tenant-first like 0001, with no foreign key to users, matching readings:
-- stage writes only under `users FOR SHARE` with the account active, the
-- account wipe deletes these rows, and teardown refuses while any remain.
--
-- One item per URL. Re-staging a URL overwrites its row and keeps its id.
CREATE TABLE inbox_items (
  tenant_id text NOT NULL,
  id text NOT NULL,
  url text NOT NULL,
  url_hash text NOT NULL CHECK (url_hash ~ '^[0-9a-f]{64}$'),
  -- Rides in the promote envelope with the Markdown, so it is bounded too.
  title text CHECK (char_length(title) <= 1000),
  markdown text NOT NULL CHECK (octet_length(markdown) BETWEEN 1 AND 128000),
  created_at timestamptz NOT NULL,
  -- Strictly increases on every overwrite: promote deletes the row only if it
  -- is still the version it loaded.
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, url_hash)
);

CREATE INDEX inbox_items_newest ON inbox_items (tenant_id, updated_at DESC, id DESC);
