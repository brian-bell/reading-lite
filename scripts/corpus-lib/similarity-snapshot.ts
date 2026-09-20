// Measuring and merging a similarity snapshot, for `corpus refresh-neighbours`.
//
// These helpers outlived `corpus backfill-similarity`, which retired with the
// manifest storage it rewrote (docs/operator-tooling.md). What the backfill
// established, and what the refresh still depends on, is the discipline: a
// measurement pass adds a score and changes NOTHING else. Reprocessing a
// reading re-runs the summarizer, and doing that on unchanged source text
// rewrites the title and re-rolls every tag — observed on a real reading,
// whose tags changed completely and whose title gained a typo fix. So
// `withSimilarity` sets exactly one field and leaves the rest byte-identical,
// `updated_at` included.
//
// Scoring needs no embedding call: each reading is scored against the corpus
// using the embedding it already owns, so there is no provider spend and no
// risk of a re-embed drifting from the vector actually stored.

import { ManifestSchema } from "../../src/schemas/manifest";
import {
  SIMILAR_TOP_K,
  excludeSelf,
  summarizeSimilarity,
  type SimilaritySnapshot,
} from "../../src/modules/stores/similarity-store";

// Matches come back from a query seeded by the reading's own embedding, so the
// reading itself is always among them at ~1.0 and must be dropped before
// measuring.
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

// Adds the measurement and changes nothing else — not even updated_at, since
// no content changed and a bumped timestamp would misreport the reading as
// freshly written to anything reading the library.
export function withSimilarity<T extends object>(
  manifest: T,
  similarity: SimilaritySnapshot,
): T & { similarity: SimilaritySnapshot } {
  return { ...manifest, similarity };
}

// Checks the object the refresh is about to WRITE, not the one it read.
//
// AGENTS.md requires manifests to be parsed at the seam, because stored shape
// can drift. This is the one corpus tool that writes the projection back, so
// skipping validation would do more than tolerate an invalid object: it would
// add a score to something the Worker rejects at read time and mark the
// reading scored, hiding it from any later repair.
//
// Validating the candidate rather than the input matters in one direction.
// A manifest whose ONLY defect is a malformed `similarity` — left by an older
// writer or a manual repair — is repaired by this very write, so rejecting it
// on the way in would fail the same reading on every run forever while
// refusing the fix it could safely make. Unrelated drift still fails, because
// the candidate carries it too.
//
// On success it returns the ORIGINAL merged object, not the parsed one.
// ManifestSchema is `.strip()`, so writing the zod output would silently drop
// any field the schema does not know about — exactly the byte-identical
// guarantee that separates this from a reprocess. Parsing is a gate here, not
// a transform.
export type ManifestCheck =
  | { ok: true; manifest: Record<string, unknown> }
  | { ok: false; error: string };

export function validateSnapshotWrite(
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
