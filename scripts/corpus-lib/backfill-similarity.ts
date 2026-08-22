// Pure planning + merging for `corpus-backfill-similarity`.
//
// The similarity snapshot landed after most of the corpus was written, so
// existing readings carry none and every consumer has to treat the field as
// optional indefinitely. This fills them in.
//
// The important constraint is what a backfill must NOT do. Reprocessing a
// reading re-runs the summarizer, and doing that on unchanged source text
// rewrites the title and re-rolls every tag -- observed on a real reading, whose
// tags changed completely and whose title gained a typo fix. A backfill adds a
// measurement and nothing else, so `withSimilarity` sets exactly one field and
// leaves the rest of the manifest byte-identical, `updated_at` included.
//
// Scoring needs no embedding call. Vectorize can be queried by an existing
// vector's id, so each reading is scored against the index using the vector it
// already owns -- no OpenAI spend, and no risk of a re-embed drifting from the
// vector actually stored.

import {
  SIMILAR_TOP_K,
  excludeSelf,
  summarizeSimilarity,
  type SimilaritySnapshot,
} from "../../src/modules/stores/similarity-store";

export interface BackfillRow {
  id: string;
  url: string;
  status: string;
  key_prefix: string;
  similarity?: SimilaritySnapshot;
}

export interface BackfillPlan {
  targets: BackfillRow[];
  alreadyScored: number;
  skippedNotReady: number;
}

// Only `ready` readings own a vector, so only they can be scored this way.
export function planBackfill(
  items: BackfillRow[],
  opts: { only?: string[]; rescore?: boolean } = {},
): BackfillPlan {
  const only = opts.only && opts.only.length > 0 ? new Set(opts.only) : null;
  let alreadyScored = 0;
  let skippedNotReady = 0;
  const targets: BackfillRow[] = [];
  for (const it of items) {
    if (only && !only.has(it.id)) continue;
    if (it.status !== "ready") {
      skippedNotReady++;
      continue;
    }
    // Resumability is just this check: a re-run skips what it already wrote.
    // `rescore` overrides it, for readings whose stored snapshot was measured
    // against a neighbourhood that has since changed -- a corpus-sweep keeper.
    if (it.similarity !== undefined && opts.rescore !== true) {
      alreadyScored++;
      continue;
    }
    targets.push(it);
  }
  return { targets, alreadyScored, skippedNotReady };
}

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

// Adds the measurement and changes nothing else -- not even updated_at, since
// no content changed and a bumped timestamp would misreport the reading as
// freshly written to anything reading the list index.
export function withSimilarity<T extends object>(
  manifest: T,
  similarity: SimilaritySnapshot,
): T & { similarity: SimilaritySnapshot } {
  return { ...manifest, similarity };
}
