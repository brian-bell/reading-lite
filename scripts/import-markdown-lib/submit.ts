import { classifyOutcome, type ReadingApi } from "../lib/reading-api";

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
  // HTTP mechanics (auth, transport retry, outcome decoding) live behind the
  // Reading API client; this loop owns orchestration only.
  api: Pick<ReadingApi, "importMarkdown">;
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
    const outcome = await opts.api.importMarkdown({
      source_url: article.sourceUrl,
      markdown: article.markdown,
      email: opts.email,
      ...(article.title === undefined ? {} : { title: article.title }),
    });
    const result: MarkdownSubmitResult = {
      index: i + 1,
      total: articles.length,
      sourceUrl: article.sourceUrl,
      filePath: article.filePath,
      ...classifyOutcome(outcome),
    };
    summary[counterFor(result.classification)] += 1;
    await opts.onResult(result);
  }

  return summary;
}

function counterFor(c: MarkdownClassification): keyof Omit<MarkdownSubmitSummary, "total"> {
  if (c === "new") return "new";
  if (c === "existing") return "existing";
  return "errors";
}
