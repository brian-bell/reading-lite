import type { SimilaritySnapshot } from "../../../src/modules/stores/similarity-store";
import type { Manifest } from "../../../src/schemas/manifest";
import type { ExtractedContent } from "../../../src/modules/extractor";
import type {
  OpenAIReasoningEffort,
  SimilarContext,
} from "../../../src/modules/summarizer/types";

// One reading the bulk path will summarize, resolved from an audit row + its
// existing manifest (the source of created_at, url_hash, content fields, and the
// ready-snapshot to preserve on failure).
export interface BatchTarget {
  readingId: string;
  url: string;
  urlHash: string;
  keyPrefix: string;
  createdAt: string;
  manifest: Manifest;
}

// A target whose article text is in hand: reused from R2 (`extracted.md`) or
// freshly extracted (then `fresh` carries the bytes/content fields to persist).
export interface ExtractedTarget {
  target: BatchTarget;
  markdown: string;
  title?: string;
  fresh?: ExtractedContent;
  freshActivation?: BatchActivationPolicy;
  contentAlreadyWritten?: true;
}

export interface ExpectedExistingFailed {
  id: string;
  keyPrefix: string;
  url: string;
  urlHash: string;
  createdAt: string;
}

export type BatchActivationPolicy =
  | { kind: "create-new" }
  | { kind: "create-existing-failed"; expected: ExpectedExistingFailed }
  | { kind: "verify-existing-failed"; expected: ExpectedExistingFailed }
  | { kind: "occupied-needs-repair"; reason: string };

// An extracted target with its similar-readings context resolved — ready to
// build a summarize request.
export interface SummarizeTarget {
  extracted: ExtractedTarget;
  similar: SimilarContext[];
  // Tokens billed embedding this reading's source to query for similar readings
  // (the realtime "query" embedding). Summed with the tldr embedding at write
  // time to mirror process-reading.ts's openai_embedding_tokens.
  queryEmbedTokens: number;
  // Measured closeness to the neighbours above, mirroring process-reading.ts so
  // a batch-written reading is indistinguishable from a realtime one.
  similarity: SimilaritySnapshot;
}

export interface DroppedTarget {
  readingId: string;
  reason: string;
}

// The non-LLM half of each reading's final manifest, resolved at submit time and
// persisted so the write phase (possibly a separate process after a crash) can
// reconstruct manifests from batch results without re-extracting. Fresh content
// objects (raw.*, extracted.md) are written to R2 at submit time, so only these
// scalar fields — plus the ready-snapshot to roll back to on failure — need to
// survive in the sidecar.
export interface SidecarTarget {
  customId: string;
  keyPrefix: string;
  id: string;
  url: string;
  urlHash: string;
  createdAt: string;
  sourceType: "url" | "markdown";
  contentType: string;
  contentStatus: string;
  contentBytes: number;
  contentSha256: string;
  extractedBytes?: number;
  // Persisted so the write phase records the full embedding cost even on a
  // resumed run (the similar phase, which computes it, doesn't re-run on resume).
  queryEmbedTokens: number;
  // Same reason: the similar phase measures it and does not re-run on resume.
  // Optional so sidecars written before this field still load.
  similarity?: SimilaritySnapshot;
  // Only fresh ingest sets this. Both batch paths now eagerly claim by-url before
  // submit, but they differ on terminal failure: a fresh ingest *created* the
  // slot, so write-phase releases that exact claim (set true for create-new /
  // create-existing-failed). A recover target's slot is a failed→pending flip of
  // pre-existing corpus ownership — left unset so the claim survives a failure and
  // the failed recover URL stays re-submittable by both recover and the online
  // reprocess path.
  releaseByUrlOnFailure?: true;
  preserveReadyManifest?: Manifest;
}

interface AnthropicSidecarV2 {
  version: 2;
  provider: "anthropic";
  model: string;
}

export interface Sidecar extends AnthropicSidecarV2 {
  phase: "submitted";
  batchId: string;
  processingStatus: string;
  resultsUrl: string | null;
  targets: SidecarTarget[];
}

export interface CreatingSidecar extends AnthropicSidecarV2 {
  phase: "creating";
  batchId: "";
  processingStatus: "pending";
  resultsUrl: null;
  targets: SidecarTarget[];
}

export interface ActivatingSidecar extends AnthropicSidecarV2 {
  phase: "activating";
  batchId: "";
  processingStatus: "activating";
  resultsUrl: null;
  targets: Array<{
    id: string;
    customId: string;
    keyPrefix: string;
    url: string;
    urlHash: string;
    createdAt: string;
  }>;
}

interface OpenAISidecarV2 {
  version: 2;
  provider: "openai";
  runId: string;
  model: string;
  reasoningEffort: OpenAIReasoningEffort;
}

export interface OpenAIActivatingSidecar extends OpenAISidecarV2 {
  phase: "activating";
  batchId: "";
  inputFileId: null;
  outputFileId: null;
  errorFileId: null;
  processingStatus: "activating";
  targets: ActivatingSidecar["targets"];
}

export interface OpenAIUploadingSidecar extends OpenAISidecarV2 {
  phase: "uploading";
  batchId: "";
  inputFileId: null;
  outputFileId: null;
  errorFileId: null;
  processingStatus: "uploading";
  targets: SidecarTarget[];
}

export interface OpenAICreatingSidecar extends OpenAISidecarV2 {
  phase: "creating";
  batchId: "";
  inputFileId: string;
  outputFileId: null;
  errorFileId: null;
  processingStatus: "creating";
  targets: SidecarTarget[];
}

export interface OpenAISubmittedSidecar extends OpenAISidecarV2 {
  phase: "submitted";
  batchId: string;
  inputFileId: string;
  outputFileId: string | null;
  errorFileId: string | null;
  processingStatus: string;
  targets: SidecarTarget[];
}

export type PersistedSidecar =
  | Sidecar
  | CreatingSidecar
  | ActivatingSidecar
  | OpenAIActivatingSidecar
  | OpenAIUploadingSidecar
  | OpenAICreatingSidecar
  | OpenAISubmittedSidecar;
