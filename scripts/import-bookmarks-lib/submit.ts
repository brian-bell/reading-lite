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

export interface SubmitOpts {
  fetch: typeof fetch;
  base: string;
  token: string;
  concurrency: number;
  onResult: (result: SubmitResult) => Promise<void> | void;
}

export async function submitAll(urls: string[], opts: SubmitOpts): Promise<SubmitSummary> {
  const summary: SubmitSummary = { total: urls.length, new: 0, existing: 0, errors: 0, skipped: 0 };
  const base = opts.base.replace(/\/+$/, "");
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
