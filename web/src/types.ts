// Hand-rolled mirror of ../../src/schemas/manifest.ts and ../../src/schemas/api.ts.
// The Worker's zod schemas are the source of truth; if they change here, update there.

export type ManifestStatus = "pending" | "ready" | "failed";
export type NoveltyVerdict = "novel" | "familiar" | "duplicate";
export type ContentStatus = "captured" | "raw_only" | "failed";
export type SourceType = "url" | "markdown";
export type ProcessingAttemptTrigger = "submit" | "reprocess" | "import";
export type ProcessingAttemptStatus = "running" | "succeeded" | "failed";
export type ProcessingStage =
  | "queued"
  | "fetch_source"
  | "prepare_markdown"
  | "write_raw"
  | "write_extracted"
  | "embed_source"
  | "query_similar"
  | "summarize"
  | "embed_summary"
  | "upsert_vector"
  | "write_manifest"
  | "write_indexes"
  | "send_email";

export interface Connection {
  id: string;
  reason: string;
}

// Mirrors TensionKindSchema / TensionSchema / TensionJudgedSchema in
// src/schemas/reading-summary.ts. `kind` reads from this reading's point of
// view: "supersedes" means this reading supersedes `id`.
export type TensionKind =
  | "contradicts"
  | "supersedes"
  | "superseded_by"
  | "qualifies"
  | "qualified_by";

export interface Tension {
  id: string;
  kind: TensionKind;
  reason: string;
  computed_at: string;
}

export interface TensionJudged {
  id: string;
  judged_at: string;
}

export interface ManifestError {
  code: string;
  message: string;
  stage?: ProcessingStage;
  failed_at?: string;
  retryable?: boolean;
}

export interface ProcessingAttemptSummary {
  id: string;
  trigger: ProcessingAttemptTrigger;
  status: ProcessingAttemptStatus;
  stage?: ProcessingStage;
  started_at: string;
  finished_at?: string;
  error?: ManifestError;
}

export interface ProcessingAttemptEvent {
  stage: ProcessingStage;
  status: "started" | "succeeded" | "failed";
  at: string;
  duration_ms?: number;
  error?: ManifestError;
}

export interface ProcessingAttempt extends ProcessingAttemptSummary {
  reading_id: string;
  url: string;
  url_hash: string;
  key_prefix: string;
  events: ProcessingAttemptEvent[];
}

export interface LegacyUsage {
  anthropic_input_tokens: number;
  anthropic_output_tokens: number;
  openai_embedding_tokens: number;
}

export interface OpenAIUsage {
  summarization: {
    provider: "openai";
    model: string;
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cached_input_tokens: number;
    cache_write_tokens: number;
  };
  openai_embedding_tokens: number;
}

export interface AnthropicUsage {
  summarization: {
    provider: "anthropic";
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  openai_embedding_tokens: number;
}

export type Usage = LegacyUsage | OpenAIUsage | AnthropicUsage;

// Measured closeness to nearest neighbours at summarize time. Optional: it
// postdates the corpus, so older readings have none and the UI must render
// without it. Mirrors SimilaritySnapshotSchema in src/schemas/manifest.ts.
export interface SimilaritySnapshot {
  count: number;
  max?: number;
  mean?: number;
  computed_at: string;
}

export interface Manifest {
  id: string;
  url: string;
  url_hash: string;
  source_type?: SourceType;
  status: ManifestStatus;
  error?: ManifestError;
  active_attempt?: ProcessingAttemptSummary;
  last_attempt?: ProcessingAttemptSummary;
  preserve_ready_manifest?: unknown;

  title?: string;
  tldr?: string;
  tags?: string[];
  keywords?: string[];
  people?: string[];
  orgs?: string[];
  novelty_verdict?: NoveltyVerdict;
  similarity?: SimilaritySnapshot;
  connections?: Connection[];
  connections_computed_at?: string;
  connections_neighbourhood_ids?: string[];
  tensions?: Tension[];
  tensions_judged?: TensionJudged[];
  summary_markdown?: string;

  content_type: string;
  content_status: ContentStatus;
  content_bytes: number;
  extracted_bytes?: number;
  content_sha256: string;

  fetched_at?: string;
  created_at: string;
  updated_at: string;

  usage?: Usage;
}

// Alias kept so the SPA's UI code reads naturally.
export type Reading = Manifest;

// What `GET /api/readings` actually returns per entry — a denormalized projection
// of Manifest. Mirrors ListIndexItemSchema in ../../src/schemas/api.ts.
export interface ListReading {
  id: string;
  key_prefix: string;
  url: string;
  status: ManifestStatus;
  title?: string;
  tldr?: string;
  tags?: string[];
  keywords?: string[];
  novelty_verdict?: NoveltyVerdict;
  similarity?: SimilaritySnapshot;
  created_at: string;
  updated_at?: string;
  error?: ManifestError;
  active_attempt?: ProcessingAttemptSummary;
  last_attempt?: ProcessingAttemptSummary;
}

export interface ListReadingsResponse {
  readings: ListReading[];
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface SubmitReadingResponse {
  id: string;
  status: ManifestStatus;
  poll: string;
  attempt_id?: string;
}

// Mirrors PostReadingReprocessBodySchema. `source` lets a caller hand the
// worker the content to reprocess with instead of re-fetching the URL; a
// reading reprocessed that way keeps `source_type: "markdown"` afterwards.
export interface ReprocessMarkdownSource {
  kind: "markdown";
  markdown: string;
  title?: string;
}

export interface ReprocessReadingBody {
  force?: boolean;
  email?: boolean;
  source?: ReprocessMarkdownSource;
}

export interface ReprocessReadingResponse {
  id: string;
  status: ManifestStatus;
  poll: string;
  attempt_id: string;
}

// Mirrors DeleteReadingResponseSchema: the purge report from
// DELETE /api/readings/:id. `by_url_released` is false when the by-url slot
// belongs to a different (surviving) reading and was deliberately left alone.
export interface DeleteReadingResponse {
  id: string;
  vector_delete_requested: boolean;
  list_row_removed: boolean;
  by_url_released: boolean;
  objects_deleted: number;
}

export interface ReadingObjectInfo {
  key: string;
  size: number;
  uploaded?: string;
}

export interface ReadingDiagnostics {
  id: string;
  key_prefix: string;
  manifest: Manifest;
  index_item: ListReading | null;
  pointers: {
    by_id: {
      exists: boolean;
      pointer?: { id: string; key_prefix: string };
      matches_manifest: boolean;
    };
    by_url: {
      exists: boolean;
      pointer?: { id: string; key_prefix: string };
      matches_manifest: boolean;
    };
  };
  objects: ReadingObjectInfo[];
  attempts: ProcessingAttempt[];
}

export interface WhoamiResponse {
  tenant_id: string;
  user_id: string;
  principal: "api_token" | "session";
  tenant_data_plane: boolean;
  email: string;
  csrf_token?: string;
}

export interface SessionListItem {
  id: string;
  current: boolean;
  created_at_ms: number;
  authenticated_at_ms: number;
  last_seen_at_ms: number;
  idle_expires_at_ms: number;
  absolute_expires_at_ms: number;
  revoked_at_ms: number | null;
  revocation_reason: string | null;
  user_agent_label: string | null;
  usable: boolean;
}

export interface ListSessionsResponse {
  sessions: SessionListItem[];
  session_cap_warning: string | null;
}
