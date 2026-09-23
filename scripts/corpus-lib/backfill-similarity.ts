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

import { ManifestSchema } from "../../src/schemas/manifest";
import { SIMILAR_TOP_K, excludeSelf, summarizeSimilarity, type SimilaritySnapshot } from "../../src/modules/stores/similarity";

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

// Checks the object the backfill is about to WRITE, not the one it read.
//
// AGENTS.md requires manifest reads from R2 to be parsed, because stored schema
// can drift. The backfill is the one corpus tool that writes the manifest back,
// so skipping validation would do more than tolerate an invalid object: it
// would add a score to something the Worker rejects at read time and mark its
// list row scored, hiding it from any later repair.
//
// Validating the candidate rather than the input matters in one direction.
// A manifest whose ONLY defect is a malformed `similarity` -- left by an older
// writer, a manual repair, or a manifest/index divergence -- is repaired by
// this very write, so rejecting it on the way in would fail the same reading on
// every run forever while refusing the fix it could safely make. Unrelated
// drift still fails, because the candidate carries it too.
//
// On success it returns the ORIGINAL merged object, not the parsed one.
// ManifestSchema is `.strip()`, so writing the zod output would silently drop
// any field the schema does not know about -- exactly the byte-identical
// guarantee that separates this tool from a reprocess. Parsing is a gate here,
// not a transform.
export type ManifestCheck =
  | { ok: true; manifest: Record<string, unknown> }
  | { ok: false; error: string };

export function validateBackfillWrite(
  raw: unknown,
  similarity: SimilaritySnapshot,
): ManifestCheck {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "manifest is not an object" };
  }
  const candidate = withSimilarity(raw as Record<string, unknown>, similarity);
  const parsed = ManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "failed ManifestSchema",
    };
  }
  return { ok: true, manifest: candidate };
}
