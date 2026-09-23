// Similarity measurement from a neighbour query, shared by the neighbour
// refresh. The manifest-rewriting backfill that once lived here
// (`corpus-backfill-similarity`, with its plan, merge and pre-write manifest
// check) went with the R2 manifests: the snapshot now lives on the reading row
// and `scripts/pg-lib/operator-corpus.ts` writes it.
//
// Scoring needs no embedding call. The similarity store can be queried by an
// existing reading's stored vector, so each reading is scored against the
// corpus using the vector it already owns -- no OpenAI spend, and no risk of a
// re-embed drifting from the vector actually stored.

import { SIMILAR_TOP_K, excludeSelf, summarizeSimilarity, type SimilaritySnapshot } from "../../src/modules/stores/similarity";

// Matches come back from a query-by-vector-id, so the reading itself is always
// among them at ~1.0 and must be dropped before measuring.
export function snapshotFor(
  id: string,
  matches: { id: string; score: number }[],
  now: string,
): SimilaritySnapshot {
  const neighbours = excludeSelf(matches, id, SIMILAR_TOP_K);
  return summarizeSimilarity(
    neighbours.map((m) => ({ id: m.id, score: m.score, url: "" })),
    now,
  );
}
