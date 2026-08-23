import {
  classifyOutcome,
  type ReadingApi,
  type ReadingApiOutcome,
} from "../lib/reading-api";

export type Classification = "new" | "existing" | "error" | "skipped";

export interface SubmitResult {
  index: number;
  total: number;
  url: string;
  classification: Classification;
  id?: string;
  error?: string;
}

export interface SubmitSummary {
  total: number;
  new: number;
  existing: number;
  errors: number;
  skipped: number;
}

export type BeforeSubmitDecision = "submit" | "skip" | "quit";

export interface BeforeSubmitContext {
  index: number;
  total: number;
  url: string;
}

export interface SubmitOpts {
  // HTTP mechanics (auth, transport retry, outcome decoding) live behind the
  // Reading API client; this loop owns orchestration only.
  api: Pick<ReadingApi, "submit">;
  onResult: (result: SubmitResult) => Promise<void> | void;
  // When provided, called before each POST. Returning "skip" counts the URL
  // as skipped; "quit" stops the run. Without it, every URL is submitted.
  beforeSubmit?: (ctx: BeforeSubmitContext) => Promise<BeforeSubmitDecision>;
}

// Always serial — concurrent POSTs raced on the shared index tmp file and
// added little throughput in practice (the worker spawns per-URL background
// work via ctx.waitUntil() either way). One in flight at a time keeps the
// index writes simple and the run easy to follow.
export async function submitAll(urls: string[], opts: SubmitOpts): Promise<SubmitSummary> {
  const summary: SubmitSummary = { total: urls.length, new: 0, existing: 0, errors: 0, skipped: 0 };

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    const index = i + 1;
    const total = urls.length;

    if (!isHttpUrl(url)) {
      const result: SubmitResult = { index, total, url, classification: "skipped" };
      summary.skipped += 1;
      await opts.onResult(result);
      continue;
    }

    if (opts.beforeSubmit) {
      const decision = await opts.beforeSubmit({ index, total, url });
      if (decision === "quit") return summary;
      if (decision === "skip") {
        const result: SubmitResult = { index, total, url, classification: "skipped" };
        summary.skipped += 1;
        await opts.onResult(result);
        continue;
      }
    }

    const outcome: ReadingApiOutcome = await opts.api.submit(url);
    const classified = classifyOutcome(outcome);
    const result: SubmitResult = { index, total, url, ...classified };
    summary[counterFor(result.classification)] += 1;
    await opts.onResult(result);
  }
  return summary;
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function counterFor(c: Classification): keyof Omit<SubmitSummary, "total"> {
  if (c === "new") return "new";
  if (c === "existing") return "existing";
  if (c === "skipped") return "skipped";
  return "errors";
}
