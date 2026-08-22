import { truncateForEmbed } from "../../../src/process-reading";
import type { SimilarContext } from "../../../src/modules/anthropic";
import type { VectorizeMatch } from "../../lib/cf-clients";
import type { EmbedResult } from "./clients";
import {
  SIMILAR_TOP_K,
  SIMILARITY_FLOOR,
  aboveFloor,
  excludeSelf,
  summarizeSimilarity,
} from "../../../src/modules/stores/similarity-store";
import type { ExtractedTarget, SummarizeTarget } from "./types";

// Mirror the realtime pipeline: embed the source text, query the index for the
// top-K most similar readings, and feed those (id/url/title) into the summarize
// prompt to ground novelty_verdict + connections.
const TOP_K = SIMILAR_TOP_K;

export interface SimilarDeps {
  embedMany(inputs: string[]): Promise<EmbedResult>;
  query(
    vector: number[],
    opts: { topK: number; returnMetadata?: boolean },
  ): Promise<VectorizeMatch[]>;
  now(): string;
  topK?: number;
}

export async function resolveSimilar(
  extracted: ExtractedTarget[],
  deps: SimilarDeps,
): Promise<SummarizeTarget[]> {
  if (extracted.length === 0) return [];
  const topK = deps.topK ?? TOP_K;

  const { embeddings, tokensByInput } = await deps.embedMany(
    extracted.map((e) => truncateForEmbed(e.markdown)),
  );

  const out: SummarizeTarget[] = [];
  for (let i = 0; i < extracted.length; i++) {
    const e = extracted[i]!;
    // Over-fetch by one, then drop self: on a recover/reprocess the reading is
    // already indexed and would otherwise consume a neighbour slot.
    const matches = await deps.query(embeddings[i]!, { topK: topK + 1, returnMetadata: true });
    const neighbours = excludeSelf(matches, e.target.readingId, topK);
    // Floor the prompt context only; the snapshot below measures the unfloored
    // neighbourhood (see process-reading.ts for why the two differ).
    const related = aboveFloor(neighbours, SIMILARITY_FLOOR);
    const similar: SimilarContext[] = related
      .map((m) => {
        const md = (m.metadata ?? {}) as { url?: unknown; title?: unknown; tldr?: unknown };
        const ctx: SimilarContext = {
          id: m.id,
          url: typeof md.url === "string" ? md.url : "",
          score: m.score,
        };
        if (typeof md.title === "string") ctx.title = md.title;
        if (typeof md.tldr === "string") ctx.tldr = md.tldr;
        return ctx;
      });
    out.push({
      extracted: e,
      similar,
      queryEmbedTokens: tokensByInput[i] ?? 0,
      similarity: summarizeSimilarity(
        neighbours.map((m) => ({ id: m.id, score: m.score, url: "" })),
        deps.now(),
      ),
    });
  }
  return out;
}
