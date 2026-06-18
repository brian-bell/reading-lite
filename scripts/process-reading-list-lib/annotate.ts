import type { ReadingListEntry } from "../check-corpus-lib/corpus";
import type { SubmitResult } from "../import-bookmarks-lib/submit";

export interface ApplySummary {
  // 200 from the API: a by-url pointer already existed, i.e. ready in the corpus.
  confirmed: number;
  // 202 from the API: accepted and queued, not yet ready.
  queued: number;
  errors: number;
}

export interface ApplyResult {
  entries: ReadingListEntry[];
  summary: ApplySummary;
}

// Writes submit outcomes back onto the entries, keyed by URL. Deliberately
// conservative about `processed`: only a 200/existing (success-only by-url
// pointer) flips it to true. A 202/new is recorded as submitted but stays
// processed:false until the queue finishes and a re-run of check-reading-list
// promotes it.
export function applyResults(
  entries: ReadingListEntry[],
  resultsByUrl: Map<string, SubmitResult>,
  now: string,
): ApplyResult {
  const summary: ApplySummary = { confirmed: 0, queued: 0, errors: 0 };
  const out = entries.map((entry) => {
    const url = typeof entry.url === "string" ? entry.url : "";
    const r = url ? resultsByUrl.get(url) : undefined;
    if (!r) return { ...entry };

    // A success supersedes any submit_error from a previous failed attempt.
    const { submit_error: _stale, ...rest } = entry as ReadingListEntry & { submit_error?: unknown };
    if (r.classification === "existing") {
      summary.confirmed += 1;
      return { ...rest, processed: true, reading_id: r.id, submitted_at: now };
    }
    if (r.classification === "new") {
      summary.queued += 1;
      return { ...rest, submitted: true, reading_id: r.id, submitted_at: now };
    }
    if (r.classification === "error") {
      summary.errors += 1;
      return { ...entry, submit_error: r.error ?? "unknown error" };
    }
    return { ...entry };
  });
  return { entries: out, summary };
}
