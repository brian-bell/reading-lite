// Pure corpus-membership logic. Kept free of I/O so it is unit-testable: the
// corpus lookup lives in the command, over the store, and the file read/write
// in the CLI.

// Mirror of the worker's terminal statuses (src/schemas/manifest.ts). A URL
// claim exists from the moment a reading is claimed, so status is what
// distinguishes "already in the corpus" — "ready" by default.
export type CorpusStatus = "pending" | "ready" | "failed";

export interface CorpusItem {
  url: string;
  status: string;
}


export interface BuildSetOptions {
  statuses?: string[];
}

export function buildCorpusUrlSet(
  items: CorpusItem[],
  opts: BuildSetOptions = {},
): Set<string> {
  const allow = new Set(opts.statuses ?? ["ready"]);
  const urls = new Set<string>();
  for (const item of items) {
    if (allow.has(item.status)) urls.add(item.url);
  }
  return urls;
}

export interface ReadingListEntry {
  url?: unknown;
  [key: string]: unknown;
}

export interface AnnotateSummary {
  total: number;
  processed: number;
  unprocessed: number;
  missingUrl: number;
}

export interface AnnotateResult {
  entries: Array<ReadingListEntry & { processed: boolean }>;
  summary: AnnotateSummary;
}

// Membership is exact-URL match — the same key the worker hashes for its by-url
// dedup pointer, so this agrees with what a re-submit would classify.
export function annotateEntries(
  entries: ReadingListEntry[],
  corpusUrls: Set<string>,
): AnnotateResult {
  const summary: AnnotateSummary = {
    total: entries.length,
    processed: 0,
    unprocessed: 0,
    missingUrl: 0,
  };
  const out = entries.map((entry) => {
    const url = typeof entry.url === "string" ? entry.url : "";
    if (!url) summary.missingUrl += 1;
    const processed = url.length > 0 && corpusUrls.has(url);
    if (processed) summary.processed += 1;
    else summary.unprocessed += 1;
    return { ...entry, processed };
  });
  return { entries: out, summary };
}
