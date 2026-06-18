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
}

// An extracted target with its similar-readings context resolved — ready to
// build a summarize request.
export interface SummarizeTarget {
  extracted: ExtractedTarget;
  similar: SimilarContext[];
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
  preserveReadyManifest?: Manifest;
}

export interface Sidecar {
  batchId: string;
  model: string;
  processingStatus: string;
  resultsUrl: string | null;
  targets: SidecarTarget[];
}
