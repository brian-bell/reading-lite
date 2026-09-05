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

// Vectorize `deleteByIds` accepts at most 1000 ids per call. The API is
// asynchronous: it returns a mutationId and does not confirm the index is
// empty. Embeddings may take a short time to disappear; callers must not poll
// or wait as if the delete were synchronous.
export const VECTORIZE_DELETE_MAX_IDS = 1000;

// Vectorize `getByIds` request size.
//
// Measured, not assumed (report rl-195-s6-staging-gate §3.6): the v2 REST API
// answers `400 {"code":40007,"message":"too many ids in payload; max id count
// is 20, got 25"}` above 20, and 200 at 20. The Workers BINDING's own limit was
// not measured — nothing called `getByIds` through it before issue #195 S3 — so
// this deliberately does NOT assume 1000 by symmetry with `deleteByIds`.
//
// Guessing high is the one mistake the vector ledger's confirmation rule cannot
// absorb: an over-cap request answers 400 with an empty body, which reads
// exactly like "none of these ids exists".
export const VECTORIZE_GET_BY_IDS_MAX_IDS = 20;

export function vectorizeMutationRecord(result: unknown): string {
  if (result && typeof result === "object" && "mutationId" in result) {
    const mutationId = (result as { mutationId: unknown }).mutationId;
    if (typeof mutationId === "string" && mutationId.length > 0) return mutationId;
  }
  return JSON.stringify(result ?? null);
}

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
// and operator vector writers spell the same contract. The store composes it
// on upsert/delete and strips
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
    // stamp so runtime and operator writes retain the same ownership evidence.
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
    await this.deleteMany([id]);
  }

  // Submit `deleteByIds` in ≤1000 batches and return whatever identifier the
  // API yields (`mutationId` on current Vectorize; `ids`/`count` on the typed
  // beta binding). Does not query the index afterwards — Vectorize deletes
  // are async and embeddings may take a short time to disappear.
  async deleteMany(ids: readonly string[]): Promise<string[]> {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(id);
    }
    const mutations: string[] = [];
    for (let offset = 0; offset < unique.length; offset += VECTORIZE_DELETE_MAX_IDS) {
      const chunk = unique
        .slice(offset, offset + VECTORIZE_DELETE_MAX_IDS)
        .map((id) => tenantVectorId(this.namespace, id));
      mutations.push(vectorizeMutationRecord(await this.index.deleteByIds(chunk)));
    }
    return mutations;
  }

  // Which of these reading ids the index still holds.
  //
  // Absence here is the vector ledger's clearing evidence (issue #195 S3), so
  // two properties are load-bearing and neither is optional:
  //
  //   - It NEVER swallows a failure. A thrown binding error, a non-200, a
  //     timeout — all propagate, because the caller's rule treats a failed call
  //     as no information rather than as absence. Returning `[]` on a caught
  //     error would read as "every id is gone" and clear rows for vectors that
  //     are still live, which is unrecoverable: the ledger is the only id
  //     source left once R2 is empty.
  //   - Requests are capped at VECTOR_GET_BY_IDS_MAX_IDS. S6 measured the v2
  //     REST cap at 20 (21+ answers 400 with an empty body); the Workers
  //     binding's own limit is unverified, so it uses the same conservative
  //     number rather than assuming 1000 by symmetry with deleteByIds.
  //
  // Returns BARE reading ids, like `query` does: the `{tenantId}:{readingId}`
  // composition never escapes this class. An id the index does not hold is
  // simply missing from the result — that is the whole signal.
  async getByIds(ids: readonly string[]): Promise<string[]> {
    const index = this.index as {
      getByIds?: (ids: string[]) => Promise<Array<{ id: string }>>;
    };
    if (typeof index.getByIds !== "function") {
      // Fail loudly rather than answer "nothing found" from a binding that
      // cannot answer at all — see the no-swallowing note above.
      throw new Error("vectorize binding has no getByIds");
    }
    const out: string[] = [];
    for (let offset = 0; offset < ids.length; offset += VECTORIZE_GET_BY_IDS_MAX_IDS) {
      const chunk = ids
        .slice(offset, offset + VECTORIZE_GET_BY_IDS_MAX_IDS)
        .map((id) => tenantVectorId(this.namespace, id));
      const found = await index.getByIds(chunk);
      const ownPrefix = this.namespace === undefined ? undefined : `${this.namespace}:`;
      for (const vector of found) {
        const id =
          ownPrefix !== undefined && vector.id.startsWith(ownPrefix)
            ? vector.id.slice(ownPrefix.length)
            : vector.id;
        out.push(id);
      }
    }
    return out;
  }

  // Emptiness evidence for a namespace we believe we just wiped. The Vectorize
  // binding has no list/scan at any scope, so nearest-K against a probe vector
  // is the only read that returns ids the caller did not already hold. It can
  // never prove absence — sampling K points of a 1536-dimensional space is not
  // enumeration — but a single hit disproves it, which is what the account-wipe
  // terminal check needs: it must not claim success while the namespace answers.
  async probeNamespace(topK: number = MIN_TOP_K): Promise<SimilarityMatch[]> {
    // A unit basis vector, not zeros: cosine similarity against a zero vector
    // is undefined. Any probe returns the namespace's nearest K, which is all
    // an emptiness check needs.
    const probe = new Array<number>(EMBEDDING_DIM).fill(0);
    probe[0] = 1;
    return this.query(probe, topK);
  }

  // Whole-index vector count when the binding exposes `describe()`, else null.
  // Coarse on purpose: VectorizeIndexInfo counts the entire index, not one
  // namespace, so this is evidence for a delta check, never a gate. Failures
  // are swallowed for the same reason.
  async indexVectorCount(): Promise<number | null> {
    const index = this.index as {
      describe?: () => Promise<{ vectorsCount?: number; vectorCount?: number } | null>;
    };
    if (typeof index.describe !== "function") return null;
    try {
      const info = await index.describe();
      // Two spellings in @cloudflare/workers-types: the `VectorizeIndex`
      // binding this class is typed against returns
      // `VectorizeIndexDetails.vectorsCount`, while the V2 `Vectorize` class
      // returns `VectorizeIndexInfo.vectorCount`. Read both — reading only one
      // is how this returns null on every wipe forever, with the swallowed
      // catch and the cast between them hiding it from tsc and from the logs.
      const count = info?.vectorsCount ?? info?.vectorCount;
      // Callers persist this, and the account-wipe progress schema requires a
      // non-negative integer. A fractional or negative value out of an external
      // API read through an untyped cast would pass zod nowhere but here, then
      // fail the schema on the NEXT read — which now means the record is
      // treated as unparseable and deleted. Validate rather than let upstream
      // drift cost a wipe its cursor.
      return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
    } catch {
      return null;
    }
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
