import type { Manifest } from "../../../src/schemas/manifest";
import type { ExtractedContent } from "../../../src/modules/extractor";
import type { SimilarContext } from "../../../src/modules/anthropic";

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
  // Fresh-ingest activation eagerly claimed by-url ownership before batch
  // submit; if the terminal batch result fails, write-phase may release that
  // exact claim. Recover-batch targets leave this unset because any matching
  // by-url pointer is pre-existing corpus ownership, not this run's claim.
  releaseByUrlOnFailure?: true;
  preserveReadyManifest?: Manifest;
}

export interface Sidecar {
  batchId: string;
  model: string;
  processingStatus: string;
  resultsUrl: string | null;
  targets: SidecarTarget[];
}

export interface ActivatingSidecar {
  batchId: "";
  model: string;
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

export type PersistedSidecar = Sidecar | ActivatingSidecar;
