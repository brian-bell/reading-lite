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
  // Full destination URL of the readings endpoint, e.g.
  // https://reading-lite.bbell.dev/readings.
  destinationUrl: string;
  token: string;
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

    const result = await processOne(url, index, total, opts);
    summary[counterFor(result.classification)] += 1;
    await opts.onResult(result);
  }
  return summary;
}

async function processOne(
  url: string,
  index: number,
  total: number,
  opts: SubmitOpts,
): Promise<SubmitResult> {
  try {
    const res = await postWithRetry(opts.destinationUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url }),
    }, opts.fetch);
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
      error: formatFetchError(err),
    };
  }
}

// Unwraps the cause chain so undici's opaque "fetch failed" surfaces the real
// reason (UND_ERR_SOCKET, ECONNRESET, TLS error code, etc.).
function formatFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [err.message];
  let cause: unknown = (err as { cause?: unknown }).cause;
  while (cause) {
    if (cause instanceof Error) {
      const code = (cause as { code?: string }).code;
      parts.push(code ? `${code}: ${cause.message}` : cause.message);
      cause = (cause as { cause?: unknown }).cause;
    } else {
      parts.push(String(cause));
      break;
    }
  }
  return parts.join(" / ");
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

// Retries the POST on a transport-level throw (undici "fetch failed" from a
// closed keep-alive socket, edge connection cycling, etc). HTTP error statuses
// are not retried — those are the worker speaking, not a transport blip.
// Re-POSTing is safe because the worker dedupes by url_hash.
async function postWithRetry(
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch,
  retries = 2,
  baseDelayMs = 250,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchFn(url, init);
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, baseDelayMs * (1 << attempt)));
    }
  }
  throw lastErr;
}

function counterFor(c: Classification): keyof Omit<SubmitSummary, "total"> {
  if (c === "new") return "new";
  if (c === "existing") return "existing";
  if (c === "skipped") return "skipped";
  return "errors";
}
