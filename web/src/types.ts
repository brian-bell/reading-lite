// Hand-rolled mirror of ../../src/schemas/manifest.ts and ../../src/schemas/api.ts.
// The Worker's zod schemas are the source of truth; if they change here, update there.

export type ManifestStatus = "pending" | "ready" | "failed";
export type NoveltyVerdict = "novel" | "familiar" | "duplicate";
export type ContentStatus = "captured" | "raw_only" | "failed";

export interface Connection {
  id: string;
  reason: string;
}

export interface ManifestError {
  code: string;
  message: string;
}

export interface Usage {
  anthropic_input_tokens: number;
  anthropic_output_tokens: number;
  openai_embedding_tokens: number;
}

export interface Manifest {
  id: string;
  url: string;
  url_hash: string;
  status: ManifestStatus;
  error?: ManifestError;

  title?: string;
  tldr?: string;
  tags?: string[];
  keywords?: string[];
  people?: string[];
  orgs?: string[];
  novelty_verdict?: NoveltyVerdict;
  connections?: Connection[];
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

export interface ListReadingsResponse {
  readings: Manifest[];
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface SubmitReadingResponse {
  id: string;
  status: ManifestStatus;
  poll: string;
}
