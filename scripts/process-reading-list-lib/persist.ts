import type { ReadingListEntry } from "../check-corpus-lib/corpus";
import type { SubmitResult } from "../import-bookmarks-lib/submit";
import { applyResults, type ApplySummary } from "./annotate";

export interface ResultSinkOpts {
  entries: ReadingListEntry[];
  now: string;
  // Persists the full annotated entry list. Called after every non-skipped
  // result so an interrupt mid-run cannot lose an accepted (200/202) outcome:
  // the file always reflects every result seen so far, and a re-run resumes
  // from the persisted `submitted`/`processed` markers instead of re-POSTing.
  flush: (entries: ReadingListEntry[]) => Promise<void>;
  onResultLog?: (result: SubmitResult) => void;
}

export interface ResultSink {
  onResult: (result: SubmitResult) => Promise<void>;
  summary: () => ApplySummary;
  readonly skipped: number;
}

export function createResultSink(opts: ResultSinkOpts): ResultSink {
  const resultsByUrl = new Map<string, SubmitResult>();
  let skipped = 0;

  return {
    async onResult(result: SubmitResult): Promise<void> {
      opts.onResultLog?.(result);
      if (result.classification === "skipped") {
        skipped += 1;
        return;
      }
      resultsByUrl.set(result.url, result);
      const { entries } = applyResults(opts.entries, resultsByUrl, opts.now);
      await opts.flush(entries);
    },
    summary(): ApplySummary {
      return applyResults(opts.entries, resultsByUrl, opts.now).summary;
    },
    get skipped(): number {
      return skipped;
    },
  };
}
