import { z } from "zod";
import {
  ConnectionSchema,
  NoveltyVerdictSchema,
  ReadingSummarySchema,
  type ReadingSummary,
} from "./reading-summary";

export {
  ConnectionSchema,
  NoveltyVerdictSchema,
  ReadingSummarySchema,
} from "./reading-summary";
export type {
  Connection,
  NoveltyVerdict,
  ReadingSummary,
} from "./reading-summary";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const sha256Hex = () => z.string().regex(SHA256_HEX, "must be 64 lowercase hex chars");

export const EmitReadingToolInputSchema = ReadingSummarySchema;
export type EmitReadingToolInput = ReadingSummary;

export const ManifestStatusSchema = z.enum(["pending", "ready", "failed"]);
export type ManifestStatus = z.infer<typeof ManifestStatusSchema>;

export const SourceTypeSchema = z.enum(["url", "markdown"]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const ContentStatusSchema = z.enum(["captured", "raw_only", "failed"]);
export type ContentStatus = z.infer<typeof ContentStatusSchema>;

export const ProcessingAttemptTriggerSchema = z.enum(["submit", "reprocess", "import"]);
export type ProcessingAttemptTrigger = z.infer<typeof ProcessingAttemptTriggerSchema>;

export const ProcessingAttemptStatusSchema = z.enum(["running", "succeeded", "failed"]);
export type ProcessingAttemptStatus = z.infer<typeof ProcessingAttemptStatusSchema>;

export const ProcessingStageSchema = z.enum([
  "queued",
  "fetch_source",
  "prepare_markdown",
  "write_raw",
  "write_extracted",
  "embed_source",
  "query_similar",
  "summarize",
  "embed_summary",
  "upsert_vector",
  "write_manifest",
  "write_indexes",
  // send_email is appended to the attempt log post-write_indexes; it does not
  // run via runStage and never flips the manifest to failed.
  "send_email",
]);
export type ProcessingStage = z.infer<typeof ProcessingStageSchema>;

const LegacyUsageSchema = z.object({
  anthropic_input_tokens: z.number().int().nonnegative(),
  anthropic_output_tokens: z.number().int().nonnegative(),
  openai_embedding_tokens: z.number().int().nonnegative(),
});

const OpenAISummarizationUsageSchema = z.object({
  provider: z.literal("openai"),
  model: z.string().min(1),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  reasoning_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  cache_write_tokens: z.number().int().nonnegative(),
});

const AnthropicSummarizationUsageSchema = z.object({
  provider: z.literal("anthropic"),
  model: z.string().min(1),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
});

export const SummarizationUsageSchema = z.discriminatedUnion("provider", [
  OpenAISummarizationUsageSchema,
  AnthropicSummarizationUsageSchema,
]);
export type SummarizationUsage = z.infer<typeof SummarizationUsageSchema>;

const UsageV2Schema = z.object({
  summarization: SummarizationUsageSchema,
  openai_embedding_tokens: z.number().int().nonnegative(),
});

export const UsageSchema = z.union([LegacyUsageSchema, UsageV2Schema]);
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
    source_type: SourceTypeSchema.optional(),
    status: ManifestStatusSchema,
    error: ManifestErrorSchema.optional(),
    active_attempt: ProcessingAttemptSummarySchema.optional(),
    last_attempt: ProcessingAttemptSummarySchema.optional(),
    preserve_ready_manifest: z.unknown().optional(),

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
