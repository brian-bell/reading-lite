// Pure corpus-membership logic. Kept free of I/O so it is unit-testable:
// the wrangler call lives in fetch-index.ts and the file read/write in the CLI.

// Mirror of the worker's terminal statuses (src/schemas/manifest.ts). By
// default, "already in the corpus" means ready; callers can opt into pending
// or failed matches when they want ownership rather than finished content.
export type CorpusStatus = "pending" | "ready" | "failed";

export interface CorpusItem {
  url: string;
  status: string;
}

// Hand-parse rather than importing the worker's zod schema: scripts must not
// drag in Workers-only module resolution, and we only need url + status.
export function parseListIndex(raw: string): CorpusItem[] {
  const parsed: unknown = JSON.parse(raw);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as { items?: unknown }).items)
  ) {
    throw new Error('expected an object with an "items" array (index/list.json shape)');
  }
  const items = (parsed as { items: unknown[] }).items;
  const out: CorpusItem[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const url = (item as { url?: unknown }).url;
    const status = (item as { status?: unknown }).status;
    if (typeof url === "string" && url.length > 0 && typeof status === "string") {
      out.push({ url, status });
    }
  }
  return out;
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

// Membership is exact-URL match, using the same URL string the worker hashes for
// its by-url ownership pointer.
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
