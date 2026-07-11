#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { loadDotVars } from "./lib/dotvars";
import {
  filterUnseen,
  loadIndex,
  recordResult,
  saveIndex,
} from "./import-bookmarks-lib/index-store";
import {
  buildImportPlan,
  findOversizedMarkdownArticles,
  MARKDOWN_IMPORT_MAX_BYTES,
  type OversizedMarkdownArticle,
  readMarkdownDir,
  type MarkdownArticle,
} from "./import-markdown-lib/parse";
import {
  moveArticlesToProcessed,
  processedDirFor,
  type ProcessedMove,
} from "./import-markdown-lib/processed";
import {
  submitMarkdownAll,
  type MarkdownSubmitResult,
} from "./import-markdown-lib/submit";

interface Args {
  dir: string;
  destinationUrl: string;
  token: string;
  indexPath: string;
  dryRun: boolean;
  email: boolean;
}

const DEFAULT_DESTINATION_URL = "http://127.0.0.1:8787/api/readings/import-markdown";

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
      index: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      email: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  if (!values.dir) {
    console.error("missing required --dir <path>");
    printUsage();
    process.exit(2);
  }

  const devVars = loadDotVars(".dev.vars");
  const destinationUrl =
    values.url ?? process.env.READER_MARKDOWN_URL ?? DEFAULT_DESTINATION_URL;
  if (!/^https?:\/\//i.test(destinationUrl)) {
    console.error(`--url must start with http:// or https:// (got ${destinationUrl})`);
    process.exit(2);
  }

  const token =
    values.token ?? process.env.READER_API_TOKEN ?? devVars.READER_API_TOKEN ?? "";
  if (!token && !values["dry-run"]) {
    console.error(
      "missing token. pass --token, set READER_API_TOKEN in env, or add it to .dev.vars (use --dry-run to skip).",
    );
    process.exit(2);
  }

  return {
    dir: values.dir,
    destinationUrl,
    token,
    indexPath: values.index ?? "./.import-markdown-index.json",
    dryRun: values["dry-run"] === true,
    email: values.email === true,
  };
}

function printUsage(): void {
  console.log(`Usage: npm run import-markdown -- --dir <path> [options]

  --dir <path>          Directory containing .md files (required).
  --url <url>           Destination - full URL of the markdown import endpoint.
                        Default: READER_MARKDOWN_URL env, then
                        ${DEFAULT_DESTINATION_URL}.
  --token <token>       Bearer token. Default: READER_API_TOKEN env, then
                        .dev.vars READER_API_TOKEN.
  --index <path>        Path to local index file.
                        Default: ./.import-markdown-index.json.
  --dry-run             Print plan, don't POST.
  --email               Ask reading-lite to send emails for imported readings.
                        Default: false.
  --help                Show this message.

Each file must have a Markdown source line like:
  **Source:** https://example.com/article

When multiple files share the same source URL, the largest Markdown file wins.
Submissions are serial and recorded in the local index after each successful
new/existing response, so interrupted runs are resumable.`);
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const articles = await readMarkdownDir(args.dir);
  const plan = buildImportPlan(articles);
  const articlesBySource = groupArticlesBySource(plan.files);
  const selectedByUrl = new Map(
    plan.selected
      .filter((article): article is MarkdownArticle & { sourceUrl: string } =>
        article.sourceUrl !== undefined,
      )
      .map((article) => [article.sourceUrl, article]),
  );

  const index = await loadIndex(args.indexPath);
  const sourceUrls = [...selectedByUrl.keys()];
  const { unseen, seen } = filterUnseen(sourceUrls, index, args.destinationUrl);
  const toSubmit = unseen
    .map((sourceUrl) => selectedByUrl.get(sourceUrl))
    .filter((article): article is MarkdownArticle & { sourceUrl: string } => article !== undefined);
  const oversized = findOversizedMarkdownArticles(toSubmit);
  let movedCount = 0;

  logPlan(args, plan, seen.length, toSubmit, oversized.length);

  if (args.dryRun) {
    if (oversized.length > 0) logOversized(oversized);
    printSummary({
      dir: args.dir,
      files: articles.length,
      uniqueSources: sourceUrls.length,
      duplicateGroups: plan.duplicateGroups.length,
      missingSource: plan.missingSource.length,
      oversized: oversized.length,
      indexed: seen.length,
      submitted: 0,
      newCount: 0,
      existing: 0,
      errors: 0,
      moved: 0,
      indexPath: args.indexPath,
      processedDir: processedDirFor(args.dir),
    });
    return;
  }

  if (oversized.length > 0) {
    logOversized(oversized);
    printSummary({
      dir: args.dir,
      files: articles.length,
      uniqueSources: sourceUrls.length,
      duplicateGroups: plan.duplicateGroups.length,
      missingSource: plan.missingSource.length,
      oversized: oversized.length,
      indexed: seen.length,
      submitted: 0,
      newCount: 0,
      existing: 0,
      errors: oversized.length,
      moved: 0,
      indexPath: args.indexPath,
      processedDir: processedDirFor(args.dir),
    });
    process.exit(1);
  }

  const seenArticles = articlesForSources(seen, articlesBySource);
  if (seenArticles.length > 0) {
    const moves = await moveArticlesToProcessed(seenArticles, args.dir);
    movedCount += moves.length;
    logMoves("already processed", moves);
  }

  if (toSubmit.length === 0) {
    printSummary({
      dir: args.dir,
      files: articles.length,
      uniqueSources: sourceUrls.length,
      duplicateGroups: plan.duplicateGroups.length,
      missingSource: plan.missingSource.length,
      oversized: 0,
      indexed: seen.length,
      submitted: 0,
      newCount: 0,
      existing: 0,
      errors: 0,
      moved: movedCount,
      indexPath: args.indexPath,
      processedDir: processedDirFor(args.dir),
    });
    return;
  }

  const summary = await submitMarkdownAll(
    toSubmit.map((article) => ({
      sourceUrl: article.sourceUrl,
      markdown: article.markdown,
      filePath: article.filePath,
      ...(article.title === undefined ? {} : { title: article.title }),
    })),
    {
      fetch: globalThis.fetch,
      destinationUrl: args.destinationUrl,
      token: args.token,
      email: args.email,
      onResult: async (r) => {
        logResult(r);
        if (r.classification === "new" || r.classification === "existing") {
          recordResult(index, args.destinationUrl, r.sourceUrl, {
            id: r.id ?? "",
            submitted_at: new Date().toISOString(),
            classification: r.classification,
          });
          await saveIndex(args.indexPath, index);
          const moves = await moveArticlesToProcessed(
            articlesBySource.get(r.sourceUrl) ?? [],
            args.dir,
          );
          movedCount += moves.length;
          logMoves("processed", moves);
        }
      },
    },
  );

  printSummary({
    dir: args.dir,
    files: articles.length,
    uniqueSources: sourceUrls.length,
    duplicateGroups: plan.duplicateGroups.length,
    missingSource: plan.missingSource.length,
    oversized: 0,
    indexed: seen.length,
    submitted: summary.total,
    newCount: summary.new,
    existing: summary.existing,
    errors: summary.errors,
    moved: movedCount,
    indexPath: args.indexPath,
    processedDir: processedDirFor(args.dir),
  });
  if (summary.errors > 0) process.exit(1);
}

function logPlan(
  args: Args,
  plan: ReturnType<typeof buildImportPlan>,
  seenCount: number,
  toSubmit: Array<MarkdownArticle & { sourceUrl: string }>,
  oversizedCount: number,
): void {
  process.stderr.write(
    `Directory:        ${args.dir}\n` +
      `Files found:      ${plan.files.length}\n` +
      `Unique sources:   ${plan.selected.length}\n` +
      `Duplicate groups: ${plan.duplicateGroups.length}\n` +
      `Missing source:   ${plan.missingSource.length}\n` +
      `Oversized:        ${oversizedCount}  (> ${MARKDOWN_IMPORT_MAX_BYTES} bytes)\n` +
      `Already sent:     ${seenCount}  (from ${args.indexPath})\n` +
      `Would submit:     ${toSubmit.length} to ${args.destinationUrl}\n` +
      `Email:            ${args.email ? "yes" : "no"}\n\n`,
  );

  for (const group of plan.duplicateGroups) {
    process.stderr.write(
      `duplicate ${group.sourceUrl}\n` +
        `  selected: ${group.selected.fileName} (${group.selected.bytes} bytes)\n`,
    );
    for (const file of group.files) {
      if (file.fileName === group.selected.fileName) continue;
      process.stderr.write(`  skipped:  ${file.fileName} (${file.bytes} bytes)\n`);
    }
  }

  if (plan.missingSource.length > 0) {
    process.stderr.write("\nmissing source line:\n");
    for (const file of plan.missingSource) {
      process.stderr.write(`  ${file.fileName}\n`);
    }
  }
}

function logOversized(oversized: OversizedMarkdownArticle[]): void {
  process.stderr.write(
    `\nblocked oversized markdown files (Cloudflare Queues message limit: ${MARKDOWN_IMPORT_MAX_BYTES} bytes / 128 KB):\n`,
  );
  for (const item of oversized) {
    process.stderr.write(
      `  ${item.article.fileName}: ${item.article.bytes} bytes (${item.excessBytes} over)\n`,
    );
  }
}

function logResult(r: MarkdownSubmitResult): void {
  const tag = r.classification.padEnd(8);
  const id = r.id ? `id=${r.id} ` : "";
  const err = r.error ? ` -- ${r.error}` : "";
  process.stderr.write(`[${r.index}/${r.total}] ${tag}${id}${r.sourceUrl} (${r.filePath})${err}\n`);
}

function logMoves(label: string, moves: ProcessedMove[]): void {
  if (moves.length === 0) return;
  for (const move of moves) {
    process.stderr.write(
      `  moved ${label}: ${move.fileName} -> ${move.destinationPath}\n`,
    );
  }
}

function groupArticlesBySource(
  articles: MarkdownArticle[],
): Map<string, Array<MarkdownArticle & { sourceUrl: string }>> {
  const out = new Map<string, Array<MarkdownArticle & { sourceUrl: string }>>();
  for (const article of articles) {
    if (article.sourceUrl === undefined) continue;
    const group = out.get(article.sourceUrl) ?? [];
    group.push(article as MarkdownArticle & { sourceUrl: string });
    out.set(article.sourceUrl, group);
  }
  return out;
}

function articlesForSources(
  sourceUrls: string[],
  articlesBySource: Map<string, Array<MarkdownArticle & { sourceUrl: string }>>,
): Array<MarkdownArticle & { sourceUrl: string }> {
  return sourceUrls.flatMap((sourceUrl) => articlesBySource.get(sourceUrl) ?? []);
}

interface FinalSummary {
  dir: string;
  files: number;
  uniqueSources: number;
  duplicateGroups: number;
  missingSource: number;
  oversized: number;
  indexed: number;
  submitted: number;
  newCount: number;
  existing: number;
  errors: number;
  moved: number;
  indexPath: string;
  processedDir: string;
}

function printSummary(s: FinalSummary): void {
  process.stdout.write(JSON.stringify({
    dir: s.dir,
    files: s.files,
    unique_sources: s.uniqueSources,
    duplicate_groups: s.duplicateGroups,
    missing_source: s.missingSource,
    oversized: s.oversized,
    indexed: s.indexed,
    submitted: s.submitted,
    new: s.newCount,
    existing: s.existing,
    errors: s.errors,
    moved: s.moved,
    index_path: s.indexPath,
    processed_dir: s.processedDir,
  }, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
