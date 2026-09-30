import { z } from "zod";
import { EMBEDDING_DIM } from "../schemas/api";
import {
  ReadingSummarySchema,
  SimilaritySnapshotSchema,
  SummarizationUsageSchema,
} from "../schemas/manifest";
import type { SimilarContext, SummarizeReadingResult } from "./summarizer";
import type { SimilaritySnapshot } from "./stores/similarity";

// Mid-job paid-stage artifacts for a single attempt. Written after each
// succeeded paid dispatch so a DeferPaidWorkError retry can skip already-paid
// work (summarize / embed_source) instead of restarting from extractSource.
//
// `config` records which configuration produced those artifacts (ADR 0004). A
// delivery reuses a stage only when the configuration that stage depends on
// still matches; otherwise the stage runs again. It holds no key or credential
// version: outputs do not depend on which key paid, so a key replacement alone
// keeps the checkpoint.

export const ProcessingConfigSchema = z
  .object({
    provider: z.enum(["openai", "anthropic"]),
    summarization_model: z.string().min(1),
    effort: z.string().min(1),
    embedding_model: z.string().min(1),
    catalog_version: z.number().int().positive(),
  })
  .strip();

export type ProcessingConfig = z.infer<typeof ProcessingConfigSchema>;

const SimilarContextSchema = z
  .object({
    id: z.string().min(1),
    url: z.string(),
    title: z.string().optional(),
    tldr: z.string().optional(),
    score: z.number().optional(),
  })
  .strip();

const EmbedSourceSchema = z.object({
  embedding: z.array(z.number()).length(EMBEDDING_DIM),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }),
});

export const ProcessingCheckpointSchema = z
  .object({
    config: ProcessingConfigSchema.optional(),
    embed_source: EmbedSourceSchema.optional(),
    summarize: z
      .object({
        reading: ReadingSummarySchema,
        usage: SummarizationUsageSchema,
        similar_context: z.array(SimilarContextSchema),
        similarity_snapshot: SimilaritySnapshotSchema,
      })
      .optional(),
  })
  .strip();

export type ProcessingCheckpoint = z.infer<typeof ProcessingCheckpointSchema>;

export function summarizeCheckpoint(
  result: SummarizeReadingResult,
  similarContext: SimilarContext[],
  similaritySnapshot: SimilaritySnapshot,
): NonNullable<ProcessingCheckpoint["summarize"]> {
  return {
    reading: result.reading,
    usage: result.usage,
    similar_context: similarContext,
    similarity_snapshot: similaritySnapshot,
  };
}

function sameEmbedding(a: ProcessingConfig, b: ProcessingConfig): boolean {
  return a.embedding_model === b.embedding_model && a.catalog_version === b.catalog_version;
}

function sameSummarization(a: ProcessingConfig, b: ProcessingConfig): boolean {
  return a.provider === b.provider &&
    a.summarization_model === b.summarization_model &&
    a.effort === b.effort;
}

export function sameProcessingConfig(a: ProcessingConfig | undefined, b: ProcessingConfig): boolean {
  return a !== undefined && sameEmbedding(a, b) && sameSummarization(a, b);
}

/**
 * The stored stages this delivery may reuse under `config`, stamped with it.
 * A checkpoint without a recorded configuration reuses nothing. The summary
 * was prompted with neighbours found by the source embedding, so it is kept
 * only when the embedding is.
 */
export function checkpointUnder(
  stored: ProcessingCheckpoint | null,
  config: ProcessingConfig,
): ProcessingCheckpoint {
  const prior = stored?.config;
  const keepEmbedding = prior !== undefined && sameEmbedding(prior, config);
  const keepSummary = keepEmbedding && sameSummarization(prior, config);
  return {
    config,
    ...(keepEmbedding && stored?.embed_source ? { embed_source: stored.embed_source } : {}),
    ...(keepSummary && stored?.summarize ? { summarize: stored.summarize } : {}),
  };
}
