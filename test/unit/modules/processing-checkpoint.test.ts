import { describe, expect, it } from "vitest";
import {
  ProcessingCheckpointSchema,
  type ProcessingCheckpoint,
} from "../../../src/modules/processing-checkpoint";
import { EMBEDDING_DIM } from "../../../src/schemas/api";

const summarizeWithNeighbour = (url: string): ProcessingCheckpoint => ({
  embed_source: {
    embedding: Array.from({ length: EMBEDDING_DIM }, () => 0.1),
    usage: { prompt_tokens: 10, total_tokens: 10 },
  },
  summarize: {
    reading: {
      title: "Test Article",
      tldr: "A short summary.",
      tags: ["test"],
      keywords: ["test", "article", "checkpoint"],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: "summary body",
    },
    usage: {
      provider: "openai",
      model: "test-model",
      input_tokens: 1,
      output_tokens: 1,
      reasoning_tokens: 0,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
    },
    similar_context: [{ id: "rd_NEIGHBOUR", url, title: "Neighbour", score: 0.9 }],
    similarity_snapshot: { count: 1, max: 0.9, mean: 0.9, computed_at: "2026-09-03T00:00:01.000Z" },
  },
});

describe("ProcessingCheckpointSchema", () => {
  it("accepts a neighbour whose url is empty", () => {
    const parsed = ProcessingCheckpointSchema.safeParse(summarizeWithNeighbour(""));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.summarize?.similar_context[0]?.url).toBe("");
    }
  });
});
