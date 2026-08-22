import { EMBEDDING_DIM } from "../../schemas/api";

export class WrongEmbeddingDimensionError extends Error {
  constructor(public readonly got: number) {
    super(`embedding has wrong dimension: got ${got}, expected ${EMBEDDING_DIM}`);
    this.name = "WrongEmbeddingDimensionError";
  }
}

export interface SimilarityMetadata {
  url: string;
  title?: string;
  tags?: string[];
  created_at?: string;
}

export interface SimilarityMatch extends SimilarityMetadata {
  id: string;
  score: number;
}

// How many neighbours ground novelty_verdict/connections and the similarity
// snapshot. Shared so the realtime and offline-batch pipelines agree.
export const SIMILAR_TOP_K = 5;

// Removes the reading's own vector from its query results, then caps the list.
//
// Order matters. On a reprocess the reading is already indexed and scores ~1.0
// against itself, so a bare topK query spends one slot on self and leaves only
// topK-1 real neighbours -- while a first-time submit gets a full topK. That
// made `count` and `mean` incomparable between fresh and reprocessed readings,
// and silently dropped the genuine last neighbour. Callers over-fetch by one
// and cap here, so the neighbourhood is the same size either way.
export function excludeSelf<T extends { id: string }>(
  matches: T[],
  selfId: string,
  limit: number,
): T[] {
  return matches.filter((m) => m.id !== selfId).slice(0, limit);
}

// A measured snapshot of how close a reading sits to its nearest neighbours at
// the moment it was summarized.
//
// The point is that this is a *number*, not a label. `novelty_verdict` asks an
// LLM for a three-way judgement about closeness while the exact quantity is
// already computed here and thrown away; as the corpus grows that verdict
// decays toward the constant "familiar" and stops discriminating. A stored
// score stays granular however large the library gets, and can be re-derived
// from embeddings alone -- no summarization call.
//
// `computed_at` is load-bearing rather than decorative: this is a claim about a
// *relationship*, stored on one node, so it goes stale whenever the corpus
// changes around it. Stamping the measurement is what makes staleness
// detectable instead of invisible.
export interface SimilaritySnapshot {
  // How many neighbours the score was computed over, after excluding self.
  count: number;
  // Omitted, rather than zeroed, when count is 0 -- "no neighbours" and
  // "neighbours at cosine 0" are different facts and must not collapse.
  max?: number;
  mean?: number;
  computed_at: string;
}

export function summarizeSimilarity(
  matches: SimilarityMatch[],
  computedAt: string,
): SimilaritySnapshot {
  if (matches.length === 0) return { count: 0, computed_at: computedAt };
  const scores = matches.map((m) => m.score);
  return {
    count: scores.length,
    max: Math.max(...scores),
    mean: scores.reduce((a, b) => a + b, 0) / scores.length,
    computed_at: computedAt,
  };
}

const MIN_TOP_K = 1;
const MAX_TOP_K = 50;

export class SimilarityStore {
  constructor(private readonly index: VectorizeIndex) {}

  async upsert(id: string, embedding: number[], metadata: SimilarityMetadata): Promise<void> {
    if (embedding.length !== EMBEDDING_DIM) {
      throw new WrongEmbeddingDimensionError(embedding.length);
    }
    await this.index.upsert([
      {
        id,
        values: embedding,
        metadata: metadata as unknown as Record<string, VectorizeVectorMetadata>,
      },
    ]);
  }

  async delete(id: string): Promise<void> {
    await this.index.deleteByIds([id]);
  }

  async query(embedding: number[], topK: number): Promise<SimilarityMatch[]> {
    if (embedding.length !== EMBEDDING_DIM) {
      throw new WrongEmbeddingDimensionError(embedding.length);
    }
    const clampedTopK = Math.min(MAX_TOP_K, Math.max(MIN_TOP_K, Math.trunc(topK)));
    const result = await this.index.query(embedding, {
      topK: clampedTopK,
      returnMetadata: true,
    });
    return result.matches.map((m) => {
      const md = (m.metadata ?? {}) as Partial<SimilarityMetadata>;
      const out: SimilarityMatch = {
        id: m.id,
        score: m.score,
        url: typeof md.url === "string" ? md.url : "",
      };
      if (typeof md.title === "string") out.title = md.title;
      if (Array.isArray(md.tags)) out.tags = md.tags.filter((t): t is string => typeof t === "string");
      if (typeof md.created_at === "string") out.created_at = md.created_at;
      return out;
    });
  }
}
