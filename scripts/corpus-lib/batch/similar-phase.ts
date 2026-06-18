import { truncateForEmbed } from "../../../src/process-reading";
import type { SimilarContext } from "../../../src/modules/anthropic";
import type { VectorizeMatch } from "../../lib/cf-clients";
import type { EmbedResult } from "./clients";
import type { ExtractedTarget, SummarizeTarget } from "./types";

// Mirror the realtime pipeline: embed the source text, query the index for the
// top-K most similar readings, and feed those (id/url/title) into the summarize
// prompt to ground novelty_verdict + connections.
const TOP_K = 5;

export interface SimilarDeps {
  embedMany(inputs: string[]): Promise<EmbedResult>;
  query(
    vector: number[],
    opts: { topK: number; returnMetadata?: boolean },
  ): Promise<VectorizeMatch[]>;
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
    const matches = await deps.query(embeddings[i]!, { topK, returnMetadata: true });
    const similar: SimilarContext[] = matches
      .filter((m) => m.id !== e.target.readingId)
      .map((m) => {
        const md = (m.metadata ?? {}) as { url?: unknown; title?: unknown };
        const ctx: SimilarContext = {
          id: m.id,
          url: typeof md.url === "string" ? md.url : "",
        };
        if (typeof md.title === "string") ctx.title = md.title;
        return ctx;
      });
    out.push({ extracted: e, similar, queryEmbedTokens: tokensByInput[i] ?? 0 });
  }
  return out;
}
