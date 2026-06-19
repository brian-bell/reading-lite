export type MarkdownClassification = "new" | "existing" | "error";

export interface MarkdownSubmitArticle {
  sourceUrl: string;
  markdown: string;
  filePath: string;
  title?: string;
}

export interface MarkdownSubmitResult {
  index: number;
  total: number;
  sourceUrl: string;
  filePath: string;
  classification: MarkdownClassification;
  id?: string;
  error?: string;
}

export interface MarkdownSubmitSummary {
  total: number;
  new: number;
  existing: number;
  errors: number;
}

export interface MarkdownSubmitOpts {
  fetch: typeof fetch;
  destinationUrl: string;
  token: string;
  email: boolean;
  onResult: (result: MarkdownSubmitResult) => Promise<void> | void;
}

export async function submitMarkdownAll(
  articles: MarkdownSubmitArticle[],
  opts: MarkdownSubmitOpts,
): Promise<MarkdownSubmitSummary> {
  const summary: MarkdownSubmitSummary = {
    total: articles.length,
    new: 0,
    existing: 0,
    errors: 0,
  };

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i]!;
    const result = await processOne(article, i + 1, articles.length, opts);
    summary[counterFor(result.classification)] += 1;
    await opts.onResult(result);
  }

  return summary;
}

async function processOne(
  article: MarkdownSubmitArticle,
  index: number,
  total: number,
  opts: MarkdownSubmitOpts,
): Promise<MarkdownSubmitResult> {
  try {
    const body = {
      source_url: article.sourceUrl,
      markdown: article.markdown,
      email: opts.email,
      ...(article.title === undefined ? {} : { title: article.title }),
    };
    const res = await postWithRetry(
      opts.destinationUrl,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      opts.fetch,
    );
    if (res.status === 202 || res.status === 200) {
      const responseBody = (await res.json().catch(() => ({}))) as {
        id?: unknown;
        status?: unknown;
      };
      const id = typeof responseBody.id === "string" ? responseBody.id : undefined;
      return {
        index,
        total,
        sourceUrl: article.sourceUrl,
        filePath: article.filePath,
        classification: res.status === 200 && responseBody.status === "ready" ? "existing" : "new",
        id,
      };
    }

    const snippet = await res.text().catch(() => "");
    return {
      index,
      total,
      sourceUrl: article.sourceUrl,
      filePath: article.filePath,
      classification: "error",
      error: `${res.status} ${snippet.slice(0, 200)}`.trim(),
    };
  } catch (err) {
    return {
      index,
      total,
      sourceUrl: article.sourceUrl,
      filePath: article.filePath,
      classification: "error",
      error: formatFetchError(err),
    };
  }
}

function counterFor(c: MarkdownClassification): keyof Omit<MarkdownSubmitSummary, "total"> {
  if (c === "new") return "new";
  if (c === "existing") return "existing";
  return "errors";
}

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
