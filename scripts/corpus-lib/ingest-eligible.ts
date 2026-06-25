import {
  buildImportPlan,
  findOversizedMarkdownArticles,
  type MarkdownArticle,
  type MarkdownImportPlan,
  type OversizedMarkdownArticle,
} from "../import-markdown-lib/parse";

export interface EligibleSelection {
  plan: MarkdownImportPlan;
  oversized: OversizedMarkdownArticle[];
  // selected (deduped by source URL, largest wins, source present) minus any
  // oversized file. These are the articles the ownership check then runs on.
  eligible: MarkdownArticle[];
}

// Offline planning for corpus-ingest: dedupe by source URL, then drop oversized
// (>128 KB, blocked before submit like the realtime import) and missing-source
// files. buildImportPlan already excludes missing-source files from `selected`.
export function selectEligibleArticles(articles: MarkdownArticle[]): EligibleSelection {
  const plan = buildImportPlan(articles);
  const oversized = findOversizedMarkdownArticles(articles);
  const oversizedPaths = new Set(oversized.map((o) => o.article.filePath));
  const eligible = plan.selected.filter((a) => !oversizedPaths.has(a.filePath));
  return { plan, oversized, eligible };
}
