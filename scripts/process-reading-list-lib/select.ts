import type { ReadingListEntry } from "../check-corpus-lib/corpus";

export interface Selectable {
  // Position in the original entries array, so results can be written back.
  index: number;
  url: string;
  entry: ReadingListEntry;
}

export interface SelectResult {
  selected: Selectable[];
  alreadyProcessed: number;
  alreadySubmitted: number;
  noUrl: number;
}

export interface SelectOptions {
  // Re-submit entries already marked submitted (e.g. to retry a queued batch).
  resubmit?: boolean;
}

// Decides which entries to POST to the reading-lite API. `processed: true`
// (already in the corpus) is always skipped; `submitted: true` is skipped
// unless resubmit, which makes a re-run resume rather than duplicate work.
export function selectUnprocessed(
  entries: ReadingListEntry[],
  opts: SelectOptions = {},
): SelectResult {
  const out: SelectResult = {
    selected: [],
    alreadyProcessed: 0,
    alreadySubmitted: 0,
    noUrl: 0,
  };
  entries.forEach((entry, index) => {
    if (entry.processed === true) {
      out.alreadyProcessed += 1;
      return;
    }
    const url = typeof entry.url === "string" ? entry.url : "";
    if (!isHttpUrl(url)) {
      out.noUrl += 1;
      return;
    }
    if (!opts.resubmit && (entry as { submitted?: unknown }).submitted === true) {
      out.alreadySubmitted += 1;
      return;
    }
    out.selected.push({ index, url, entry });
  });
  return out;
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}
