import { EMBEDDING_DIM } from "../../schemas/api";
import { parseTenantId } from "../../control-plane/ids";
import type { TenantContext } from "../../control-plane/ids";

export class WrongEmbeddingDimensionError extends Error {
  constructor(public readonly got: number) {
    super(`embedding has wrong dimension: got ${got}, expected ${EMBEDDING_DIM}`);
    this.name = "WrongEmbeddingDimensionError";
  }
}

export interface SimilarityMetadata {
  url: string;
  title?: string;
  // Carried on the vector so a neighbour can be *described* to the summarizer,
  // not merely named. Judging novelty from five bare titles is what the prompt
  // was doing before; a tldr is 1-3 sentences by schema, far inside Vectorize's
  // 10KiB per-vector metadata budget.
  tldr?: string;
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

// Minimum cosine similarity for a neighbour to count as related.
//
// Vectorize's nearest-K always returns K results however far away they are, so
// without a floor every reading -- however novel -- reached the summarizer under
// the heading "Possibly-related readings already in the library:" followed by
// five entries. The framing presupposed the answer, and the "no prior readings"
// branch was unreachable once the corpus was non-trivial. That is a large part
// of why novelty_verdict decayed toward a constant "familiar".
//
// Calibrated against the live corpus, not guessed: 16 stored vectors queried
// back against the index (no embedding calls -- Vectorize can query by vector
// id), self excluded, giving this median score by neighbour rank:
//
//   rank 1  0.584   (min 0.443, max 0.855)
//   rank 2  0.538
//   rank 3  0.524
//   rank 4  0.515
//   rank 5  0.510
//
// The flat 0.51-0.54 tail across ranks 2-5 is the tell: those are not degrees
// of relatedness, they are the baseline similarity of same-domain prose. Only
// rank 1 pulls meaningfully away, and only sometimes. Note how high that
// baseline sits in absolute terms -- a 0.1-style threshold, or even 0.45, would
// sit *below* the noise floor and admit everything, changing nothing.
//
// 0.55 cuts just above that tail: on the sample it keeps 38% of neighbours and
// leaves 5 of 16 readings with an empty neighbourhood -- i.e. genuinely able to
// come back "novel" again. 0.60 was the alternative but pushed 9 of 16 to
// empty, which over-corrects for a corpus that really is topically concentrated.
//
// Worth revisiting against the full distribution once the backfill scores every
// reading, rather than a 16-reading sample.
export const SIMILARITY_FLOOR = 0.55;

// Keeps only neighbours at or above `floor`. Returning an empty list is a
// meaningful result, not a failure: it is what lets a novel reading reach the
// prompt's "no prior readings" branch.
export function aboveFloor<T extends { score: number }>(matches: T[], floor: number): T[] {
  return matches.filter((m) => m.score >= floor);
}

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

// Vectorize namespace for a tenant, or undefined while the data plane gate is
// off. Namespaces are Vectorize's own segmentation primitive: a query in one
// namespace cannot match a vector in another, with no metadata index to create
// (which a `filter` on a metadata property would have required).
//
// Returning undefined when the gate is off is what keeps the existing corpus
// working: its vectors were written with no namespace, so an unnamespaced query
// still finds them. Flipping TENANT_DATA_PLANE on therefore needs those vectors
// re-upserted into the founder namespace first, exactly like the R2 key-root
// migration -- see tenantKeyRoot in reading-store.ts, which this mirrors.
export function tenantNamespace(
  tenant: TenantContext,
  enabled: boolean,
): string | undefined {
  const tenantId = parseTenantId(String(tenant.tenantId));
  if (!tenantId) {
    throw new Error("malformed tenant id");
  }
  if (!enabled) return undefined;
  return tenantId;
}

// The tenant-scoped VECTOR ID (ADR 0002): inside a tenant namespace a vector
// is stored as `{tenantId}:{readingId}` so the namespace-blind deleteByIds
// cannot address another tenant's vector; without a namespace (the pre-tenant
// layout) the id is the bare reading id. Single-homed here so the worker store
// and the founder-migration tooling (scripts/corpus-lib/founder-migration.ts)
// spell the same contract. The store composes it on upsert/delete and strips
// it from query matches, so callers only ever see bare reading ids; migrated
// vectors are written with it from the start.
export function tenantVectorId(namespace: string | undefined, readingId: string): string {
  return namespace === undefined ? readingId : `${namespace}:${readingId}`;
}

export function similarityStoreFor(
  index: VectorizeIndex,
  tenant: TenantContext,
  env: { TENANT_DATA_PLANE?: string },
): SimilarityStore {
  return new SimilarityStore(index, tenantNamespace(tenant, env.TENANT_DATA_PLANE === "1"));
}

export class SimilarityStore {
  // `namespace` undefined means the shared, pre-tenant namespace. Construct via
  // similarityStoreFor in hosted code so the scope comes from a validated
  // TenantContext rather than an ad-hoc string.
  constructor(
    private readonly index: VectorizeIndex,
    private readonly namespace?: string,
  ) {}

  async upsert(id: string, embedding: number[], metadata: SimilarityMetadata): Promise<void> {
    if (embedding.length !== EMBEDDING_DIM) {
      throw new WrongEmbeddingDimensionError(embedding.length);
    }
    // ADR 0002's audit layer: every namespaced vector carries a tenant_id
    // stamp, matching what the founder migration writes. Reconciliation
    // (founder-migration.ts) rejects a prefixed vector without the stamp once
    // its legacy source is gone, so an unstamped realtime reprocess would
    // block re-certification of an already-migrated corpus.
    const stamped =
      this.namespace === undefined ? metadata : { ...metadata, tenant_id: this.namespace };
    await this.index.upsert([
      {
        id: tenantVectorId(this.namespace, id),
        values: embedding,
        ...(this.namespace === undefined ? {} : { namespace: this.namespace }),
        metadata: stamped as unknown as Record<string, VectorizeVectorMetadata>,
      },
    ]);
  }

  async delete(id: string): Promise<void> {
    await this.index.deleteByIds([tenantVectorId(this.namespace, id)]);
  }

  async query(embedding: number[], topK: number): Promise<SimilarityMatch[]> {
    if (embedding.length !== EMBEDDING_DIM) {
      throw new WrongEmbeddingDimensionError(embedding.length);
    }
    const clampedTopK = Math.min(MAX_TOP_K, Math.max(MIN_TOP_K, Math.trunc(topK)));
    const result = await this.index.query(embedding, {
      topK: clampedTopK,
      returnMetadata: true,
      ...(this.namespace === undefined ? {} : { namespace: this.namespace }),
    });
    const ownPrefix = this.namespace === undefined ? undefined : `${this.namespace}:`;
    return result.matches.map((m) => {
      const md = (m.metadata ?? {}) as Partial<SimilarityMetadata>;
      const out: SimilarityMatch = {
        id:
          ownPrefix !== undefined && m.id.startsWith(ownPrefix)
            ? m.id.slice(ownPrefix.length)
            : m.id,
        score: m.score,
        url: typeof md.url === "string" ? md.url : "",
      };
      if (typeof md.title === "string") out.title = md.title;
      if (typeof md.tldr === "string") out.tldr = md.tldr;
      if (Array.isArray(md.tags)) out.tags = md.tags.filter((t): t is string => typeof t === "string");
      if (typeof md.created_at === "string") out.created_at = md.created_at;
      return out;
    });
  }
}
