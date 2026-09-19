-- Reading-side schema (ADR 0005). Every table carries tenant_id as the first
-- column of its primary key and every foreign key includes it, so a
-- cross-tenant reference cannot be expressed. Identity, ownership, state and
-- queried fields are relational columns; summary and diagnostic data are JSONB.
-- Content bytes stay in R2; rows hold relative keys only.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE readings (
  tenant_id text NOT NULL,
  id text NOT NULL,
  -- The stored relative R2 prefix. Never re-derived from id and created_at:
  -- imported prefixes need not follow buildKeyPrefix.
  key_prefix text NOT NULL,
  url text NOT NULL,
  url_hash text NOT NULL CHECK (url_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  source_type text CHECK (source_type IN ('url', 'markdown')),
  title text,
  tldr text,
  -- NULL means the manifest field is absent, which differs from empty.
  tags text[],
  keywords text[],
  people text[],
  orgs text[],
  novelty_verdict text CHECK (novelty_verdict IN ('novel', 'familiar', 'duplicate')),
  source_date date,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- Content state of the reading as it stands now. Required for every status:
  -- a pending or failed reading has no published revision.
  content_type text NOT NULL,
  content_status text NOT NULL CHECK (content_status IN ('captured', 'raw_only', 'failed')),
  content_bytes integer NOT NULL CHECK (content_bytes >= 0),
  extracted_bytes integer CHECK (extracted_bytes >= 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  error jsonb,
  similarity jsonb,
  enrichment_degradation jsonb,
  active_attempt jsonb,
  last_attempt jsonb,
  current_revision_id text,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX readings_library_order ON readings (tenant_id, created_at DESC, id DESC);
CREATE INDEX readings_url_hash ON readings (tenant_id, url_hash);

-- Tenant-scoped URL ownership. Separate from readings on purpose: the corpus
-- holds failed orphan duplicates of one URL, and only one reading owns it.
CREATE TABLE reading_urls (
  tenant_id text NOT NULL,
  url_hash text NOT NULL CHECK (url_hash ~ '^[0-9a-f]{64}$'),
  reading_id text NOT NULL,
  PRIMARY KEY (tenant_id, url_hash),
  UNIQUE (tenant_id, reading_id),
  FOREIGN KEY (tenant_id, reading_id) REFERENCES readings (tenant_id, id) ON DELETE CASCADE
);

-- A revision exists only once a reading has been published. It keeps its own
-- copy of the content fields; the Manifest projection takes those from
-- readings, never from here.
CREATE TABLE reading_revisions (
  tenant_id text NOT NULL,
  reading_id text NOT NULL,
  id text NOT NULL,
  raw_key text NOT NULL,
  extracted_key text,
  content_type text NOT NULL,
  content_status text NOT NULL CHECK (content_status IN ('captured', 'raw_only', 'failed')),
  content_bytes integer NOT NULL CHECK (content_bytes >= 0),
  extracted_bytes integer CHECK (extracted_bytes >= 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  summary_markdown text,
  usage jsonb,
  -- Relationship rows cannot tell an absent array from an empty one.
  connections_present boolean NOT NULL DEFAULT false,
  tensions_present boolean NOT NULL DEFAULT false,
  connections_computed_at timestamptz,
  connections_neighbourhood_ids text[],
  tensions_judged jsonb,
  published_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, reading_id, id),
  FOREIGN KEY (tenant_id, reading_id) REFERENCES readings (tenant_id, id) ON DELETE CASCADE
);

-- Deferred so a reading and its first revision commit in one transaction.
ALTER TABLE readings
  ADD CONSTRAINT readings_current_revision
  FOREIGN KEY (tenant_id, id, current_revision_id)
  REFERENCES reading_revisions (tenant_id, reading_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- Connections and tensions are ordered arrays; position preserves that order.
-- The foreign key covers the source only: detail reads tolerate missing targets.
CREATE TABLE reading_relationships (
  tenant_id text NOT NULL,
  source_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('connection', 'tension')),
  target_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  tension_kind text CHECK (tension_kind IN ('contradicts', 'supersedes', 'superseded_by', 'qualifies', 'qualified_by')),
  reason text NOT NULL,
  computed_at timestamptz,
  PRIMARY KEY (tenant_id, source_id, kind, target_id),
  CHECK ((kind = 'tension') = (tension_kind IS NOT NULL AND computed_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, source_id) REFERENCES readings (tenant_id, id) ON DELETE CASCADE
);

-- Kept out of readings so list scans never touch the vectors.
--
-- Deliberately no HNSW index (ADR 0005): similarity is an exact cosine scan
-- over one tenant's rows, found through the primary key. One HNSW graph shared
-- by every tenant applies the tenant filter after the graph walk, and an
-- incrementally built graph left a small tenant's vectors unreachable beside a
-- larger cluster whatever hnsw.iterative_scan or ef_search said. Exact is
-- always complete and tenant-isolated, and cheap at thousands of rows per
-- tenant; a per-tenant or partitioned index is the scaling path.
CREATE TABLE reading_embeddings (
  tenant_id text NOT NULL,
  reading_id text NOT NULL,
  embedding vector(1536) NOT NULL,
  PRIMARY KEY (tenant_id, reading_id),
  FOREIGN KEY (tenant_id, reading_id) REFERENCES readings (tenant_id, id) ON DELETE CASCADE
);
