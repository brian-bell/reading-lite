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
