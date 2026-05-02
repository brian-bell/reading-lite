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
  fetch: typeof fetch;
  base: string;
  token: string;
  concurrency: number;
  onResult: (result: SubmitResult) => Promise<void> | void;
  // When provided, submission runs serially and consults this hook before each
  // POST. Returning "skip" counts the URL as skipped; "quit" stops the run.
  // Without it, URLs run through the worker pool at full concurrency.
  beforeSubmit?: (ctx: BeforeSubmitContext) => Promise<BeforeSubmitDecision>;
}

export async function submitAll(urls: string[], opts: SubmitOpts): Promise<SubmitSummary> {
  const summary: SubmitSummary = { total: urls.length, new: 0, existing: 0, errors: 0, skipped: 0 };
  const base = opts.base.replace(/\/+$/, "");

  if (opts.beforeSubmit) {
    return runSerial(urls, summary, base, opts);
  }

  const concurrency = Math.max(1, Math.floor(opts.concurrency));
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= urls.length) return;
      const url = urls[i]!;
      const result = await processOne(url, i + 1, urls.length, base, opts);
      summary[counterFor(result.classification)] += 1;
      await opts.onResult(result);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  return summary;
}

async function runSerial(
  urls: string[],
  summary: SubmitSummary,
  base: string,
  opts: SubmitOpts,
): Promise<SubmitSummary> {
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

    const decision = await opts.beforeSubmit!({ index, total, url });
    if (decision === "quit") return summary;
    if (decision === "skip") {
      const result: SubmitResult = { index, total, url, classification: "skipped" };
      summary.skipped += 1;
      await opts.onResult(result);
      continue;
    }

    const result = await processOne(url, index, total, base, opts);
    summary[counterFor(result.classification)] += 1;
    await opts.onResult(result);
  }
  return summary;
}

async function processOne(
  url: string,
  index: number,
  total: number,
  base: string,
  opts: SubmitOpts,
): Promise<SubmitResult> {
  if (!isHttpUrl(url)) {
    return { index, total, url, classification: "skipped" };
  }
  try {
    const res = await opts.fetch(`${base}/readings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url }),
    });
    if (res.status === 202 || res.status === 200) {
      const body = (await res.json().catch(() => ({}))) as { id?: unknown };
      const id = typeof body.id === "string" ? body.id : undefined;
      return {
        index,
        total,
        url,
        classification: res.status === 202 ? "new" : "existing",
        id,
      };
    }
    const snippet = await res.text().catch(() => "");
    return {
      index,
      total,
      url,
      classification: "error",
      error: `${res.status} ${snippet.slice(0, 200)}`.trim(),
    };
  } catch (err) {
    return {
      index,
      total,
      url,
      classification: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
