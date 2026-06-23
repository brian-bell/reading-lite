import {
  buildImportPlan,
  findOversizedMarkdownArticles,
  type DuplicateGroup,
  type MarkdownArticle,
  type OversizedMarkdownArticle,
} from "../../import-markdown-lib/parse";
import { prepareFreshMarkdown, type FreshMarkdownDeps, type SkippedTarget } from "./fresh-markdown";
import type { ExtractedTarget } from "./types";

export interface IngestPlan {
  // Deduped articles with a source URL that are within the size limit and would
  // be summarized (after idempotency skips). `would-submit`.
  targets: ExtractedTarget[];
  // Owners skipped client-side: ready (already summarized) or pending (in flight).
  skipped: SkippedTarget[];
  // Files reported and excluded before idempotency.
  missingSource: MarkdownArticle[];
  oversized: OversizedMarkdownArticle[];
  duplicateGroups: DuplicateGroup[];
}

// Compose the markdown-dir front-end into one plan: dedup by source URL (largest
// wins), drop missing-source and oversized files, then run the idempotency check
// to split the survivors into would-submit targets and skipped owners. The CLI
// renders this for the dry-run plan and feeds `targets` to runFreshBatch.
export async function buildIngestPlan(
  articles: MarkdownArticle[],
  deps: FreshMarkdownDeps,
): Promise<IngestPlan> {
  // Drop oversized files BEFORE dedup. buildImportPlan picks the largest file in
  // each source-URL group, so filtering after dedup would let an oversized dump
  // mask a valid smaller sibling and silently lose the URL. Filtering first lets
  // the largest *eligible* file win, matching realtime import (which imports each
  // file independently and would never lose the small one).
  const oversized = findOversizedMarkdownArticles(articles);
  const oversizedFiles = new Set(oversized.map((o) => o.article.filePath));
  const withinLimit = articles.filter((a) => !oversizedFiles.has(a.filePath));

  const plan = buildImportPlan(withinLimit);
  const { targets, skipped } = await prepareFreshMarkdown(plan.selected, deps);

  return {
    targets,
    skipped,
    missingSource: plan.missingSource,
    oversized,
    duplicateGroups: plan.duplicateGroups,
  };
}
