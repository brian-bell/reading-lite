// PostgreSQL similarity reads over pgvector (ADR 0005). Same method names and
// SimilarityMatch shape as SimilarityStore, so slice 1b swaps it in and
// aboveFloor, excludeSelf and summarizeSimilarity are reused unchanged.
// Nothing at runtime constructs this yet.
//
// Score is cosine similarity, `1 - (embedding <=> query)`, matching
// Vectorize's cosine metric. Only ready readings are returned; the title,
// tldr and tags come from the reading row rather than copied vector metadata.
//
// The scan is exact: reading_embeddings has no HNSW index on purpose. A graph
// shared by every tenant filters by tenant after the walk and left a small
// tenant's vectors unreachable beside a larger cluster (ADR 0005 has the
// evidence). Exact over one tenant's rows is complete, isolated and cheap at
// this corpus size.

import type { TenantContext } from "../../../control-plane/ids";
import { EMBEDDING_DIM } from "../../../schemas/api";
import { vectorLiteral, type Sql } from "../../db/sql";
import { WrongEmbeddingDimensionError, type SimilarityMatch } from "../similarity";
import { pgTenantId } from "./reading-store";

const MIN_TOP_K = 1;

/**
 * A sanity ceiling on one similarity query, not the user-facing limit.
 *
 * `POST /api/readings/similar` bounds its own `k` at 50 in
 * `PostReadingsSimilarBodySchema`, which rejects a larger request rather than
 * quietly trimming it, so nothing a caller sends reaches this.
 *
 * It is 100 because that is the widest any internal caller asks for: the
 * offline refresh's reverse-neighbour query (`REVERSE_TOP_K`). That query
 * decides whether to escalate to a full sweep by comparing the rows it got
 * against the topK it asked for, so a cap BELOW the ask would clamp every
 * answer to the cap, make "came back full" unreachable, and silently kill the
 * escalation that keeps a narrowed scope honest. Raising a caller past this
 * must raise this too.
 */
export const MAX_SIMILARITY_TOP_K = 100;

export function pgSimilarityStoreFor(sql: Sql, tenant: TenantContext): PgSimilarityStore {
  return new PgSimilarityStore(sql, pgTenantId(tenant));
}

interface MatchRow {
  [column: string]: unknown;
  id: string;
  score: number;
  url: string;
  title: string | null;
  tldr: string | null;
  tags: string[] | null;
  created_at: string;
}

export class PgSimilarityStore {
  constructor(
    private readonly sql: Sql,
    private readonly tenantId: string,
  ) {}

  async query(embedding: readonly number[], topK: number): Promise<SimilarityMatch[]> {
    if (embedding.length !== EMBEDDING_DIM) {
      throw new WrongEmbeddingDimensionError(embedding.length);
    }
    return this.nearest(vectorLiteral(embedding), topK);
  }

  // Neighbours of a stored vector, self included (callers excludeSelf). Null
  // when the reading has no vector, which is distinct from no neighbours.
  async queryByVectorId(id: string, topK: number): Promise<SimilarityMatch[] | null> {
    const [row] = await this.sql.query<{ embedding: string }>(
      "SELECT embedding::text AS embedding FROM reading_embeddings WHERE tenant_id = $1 AND reading_id = $2",
      [this.tenantId, id],
    );
    return row ? this.nearest(row.embedding, topK) : null;
  }

  private async nearest(vector: string, topK: number): Promise<SimilarityMatch[]> {
    const limit = Math.min(MAX_SIMILARITY_TOP_K, Math.max(MIN_TOP_K, Math.trunc(topK)));
    const rows = await this.sql.query<MatchRow>(
      `SELECT r.id, 1 - (e.embedding <=> $2::vector) AS score, r.url, r.title, r.tldr, r.tags, r.created_at
       FROM reading_embeddings e
       JOIN readings r ON (r.tenant_id, r.id) = (e.tenant_id, e.reading_id)
       WHERE e.tenant_id = $1 AND r.status = 'ready'
       ORDER BY e.embedding <=> $2::vector, r.id
       LIMIT $3`,
      [this.tenantId, vector, limit],
    );
    return rows.map((row) => {
      const match: SimilarityMatch = { id: row.id, score: row.score, url: row.url };
      if (row.title !== null) match.title = row.title;
      if (row.tldr !== null) match.tldr = row.tldr;
      if (row.tags !== null) match.tags = row.tags;
      match.created_at = row.created_at;
      return match;
    });
  }
}
