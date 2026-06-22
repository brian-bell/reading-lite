import {
  buildImportPlan,
  findOversizedMarkdownArticles,
  type DuplicateGroup,
  type MarkdownArticle,
  type OversizedMarkdownArticle,
} from "../../import-markdown-lib/parse";
import {
  prepareFreshMarkdown,
  type FreshMarkdownArticle,
  type PrepareFreshDeps,
  type PrepareFreshResult,
} from "./prepare-fresh-markdown";

export interface IngestPlan {
  fileCount: number;
  uniqueSources: number;
  duplicateGroups: DuplicateGroup[];
  missingSource: MarkdownArticle[];
  oversized: OversizedMarkdownArticle[];
  // Idempotency-resolved targets, capped by --limit, plus the ready/pending skips
  // and any drops. `targets` is exactly what would be submitted.
  prep: PrepareFreshResult;
}

// Resolve a markdown directory's parsed articles into the full ingest plan:
// dedupe (largest wins), drop oversized + missing-source, run the client-side
// idempotency check, then cap to --limit. The cap is applied AFTER idempotency
// (on the would-submit targets) so already-ready/pending owners don't consume a
// slot — re-runs chunk through the not-yet-ingested files, not the front of the
// list.
export async function planFreshMarkdownIngest(
  articles: MarkdownArticle[],
  limit: number,
  deps: PrepareFreshDeps,
): Promise<IngestPlan> {
  const plan = buildImportPlan(articles);
  const oversized = findOversizedMarkdownArticles(plan.selected);
  const oversizedNames = new Set(oversized.map((o) => o.article.fileName));

  const freshArticles: FreshMarkdownArticle[] = plan.selected
    .filter((a) => !oversizedNames.has(a.fileName))
    .filter((a): a is MarkdownArticle & { sourceUrl: string } => a.sourceUrl !== undefined)
    .map((a) => ({
      sourceUrl: a.sourceUrl,
      markdown: a.markdown,
      ...(a.title === undefined ? {} : { title: a.title }),
    }));

  const resolved = await prepareFreshMarkdown(freshArticles, deps);
  const capped = Number.isFinite(limit) ? resolved.targets.slice(0, limit) : resolved.targets;

  return {
    fileCount: plan.files.length,
    uniqueSources: plan.selected.length,
    duplicateGroups: plan.duplicateGroups,
    missingSource: plan.missingSource,
    oversized,
    prep: { targets: capped, skipped: resolved.skipped, dropped: resolved.dropped },
  };
}
