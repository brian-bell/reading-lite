import { z } from "zod";
import { EMBEDDING_DIM } from "../schemas/api";
import {
  ReadingSummarySchema,
  SimilaritySnapshotSchema,
  SummarizationUsageSchema,
} from "../schemas/manifest";
import type { EmbeddingResult } from "./embeddings";
import type { SimilarContext, SummarizeReadingResult } from "./summarizer";
import type { SimilaritySnapshot } from "./stores/similarity";

// Mid-job paid-stage artifacts for a single attempt. Written after each
// succeeded paid dispatch so a DeferPaidWorkError retry can skip already-paid
// work (summarize / embed_source) instead of restarting from extractSource.

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

export function embedSourceCheckpoint(result: EmbeddingResult): ProcessingCheckpoint["embed_source"] {
  return result;
}

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
