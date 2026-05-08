import { z } from "zod";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const sha256Hex = () => z.string().regex(SHA256_HEX, "must be 64 lowercase hex chars");

export const NoveltyVerdictSchema = z.enum(["novel", "familiar", "duplicate"]);
export type NoveltyVerdict = z.infer<typeof NoveltyVerdictSchema>;

export const ConnectionSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const EmitReadingToolInputSchema = z.object({
  title: z.string().min(1),
  tldr: z.string().min(1),
  tags: z.array(z.string().min(1)),
  keywords: z.array(z.string().min(1)),
  people: z.array(z.string().min(1)),
  orgs: z.array(z.string().min(1)),
  novelty_verdict: NoveltyVerdictSchema,
  connections: z.array(ConnectionSchema),
  summary_markdown: z.string().min(1),
});
export type EmitReadingToolInput = z.infer<typeof EmitReadingToolInputSchema>;

export const ManifestStatusSchema = z.enum(["pending", "ready", "failed"]);
export type ManifestStatus = z.infer<typeof ManifestStatusSchema>;

export const ContentStatusSchema = z.enum(["captured", "raw_only", "failed"]);
export type ContentStatus = z.infer<typeof ContentStatusSchema>;

export const ProcessingAttemptTriggerSchema = z.enum(["submit", "reprocess"]);
export type ProcessingAttemptTrigger = z.infer<typeof ProcessingAttemptTriggerSchema>;

export const ProcessingAttemptStatusSchema = z.enum(["running", "succeeded", "failed"]);
export type ProcessingAttemptStatus = z.infer<typeof ProcessingAttemptStatusSchema>;

export const ProcessingStageSchema = z.enum([
  "queued",
  "fetch_source",
  "write_raw",
  "write_extracted",
  "embed_source",
  "query_similar",
  "summarize",
  "embed_summary",
  "upsert_vector",
  "write_manifest",
  "write_indexes",
]);
export type ProcessingStage = z.infer<typeof ProcessingStageSchema>;

export const UsageSchema = z.object({
  anthropic_input_tokens: z.number().int().nonnegative(),
  anthropic_output_tokens: z.number().int().nonnegative(),
  openai_embedding_tokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const ManifestErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  stage: ProcessingStageSchema.optional(),
  failed_at: z.string().datetime().optional(),
  retryable: z.boolean().optional(),
});
export type ManifestError = z.infer<typeof ManifestErrorSchema>;

export const ProcessingAttemptSummarySchema = z
  .object({
    id: z.string().min(1),
    trigger: ProcessingAttemptTriggerSchema,
    status: ProcessingAttemptStatusSchema,
    stage: ProcessingStageSchema.optional(),
    started_at: z.string().datetime(),
    finished_at: z.string().datetime().optional(),
    error: ManifestErrorSchema.optional(),
  })
  .strip();
export type ProcessingAttemptSummary = z.infer<typeof ProcessingAttemptSummarySchema>;

export const ProcessingAttemptEventSchema = z
  .object({
    stage: ProcessingStageSchema,
    status: z.enum(["started", "succeeded", "failed"]),
    at: z.string().datetime(),
    duration_ms: z.number().nonnegative().optional(),
    error: ManifestErrorSchema.optional(),
  })
  .strip();
export type ProcessingAttemptEvent = z.infer<typeof ProcessingAttemptEventSchema>;

export const ProcessingAttemptSchema = ProcessingAttemptSummarySchema.extend({
  reading_id: z.string().min(1),
  url: z.string().url(),
  url_hash: sha256Hex(),
  key_prefix: z.string().min(1),
  events: z.array(ProcessingAttemptEventSchema),
}).strip();
export type ProcessingAttempt = z.infer<typeof ProcessingAttemptSchema>;

export const ManifestSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().url(),
    url_hash: sha256Hex(),
    status: ManifestStatusSchema,
    error: ManifestErrorSchema.optional(),
    active_attempt: ProcessingAttemptSummarySchema.optional(),
    last_attempt: ProcessingAttemptSummarySchema.optional(),

    title: z.string().min(1).optional(),
    tldr: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
    people: z.array(z.string()).optional(),
    orgs: z.array(z.string()).optional(),
    novelty_verdict: NoveltyVerdictSchema.optional(),
    connections: z.array(ConnectionSchema).optional(),
    summary_markdown: z.string().optional(),

    content_type: z.string().min(1),
    content_status: ContentStatusSchema,
    content_bytes: z.number().int().nonnegative(),
    extracted_bytes: z.number().int().nonnegative().optional(),
    content_sha256: sha256Hex(),

    fetched_at: z.string().datetime().optional(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),

    usage: UsageSchema.optional(),
  })
  .strip();
export type Manifest = z.infer<typeof ManifestSchema>;

export const ByUrlPointerSchema = z.object({
  id: z.string().min(1),
  key_prefix: z.string().min(1),
});
export type ByUrlPointer = z.infer<typeof ByUrlPointerSchema>;
