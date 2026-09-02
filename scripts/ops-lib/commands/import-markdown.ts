// `ops import markdown` — import a directory of local .md files through
// POST /api/readings/import-markdown.
//
// This workflow used to act by default with an opt-out --dry-run
// (scripts/import-markdown.ts). Under the common contract the old dry-run is
// the default: a mode-less invocation reads the directory and local index to
// print the file-selection and size plan, but makes no POST, writes no resume
// state, and moves no files into processed/. --execute performs the current
// submit → record → move path unchanged. Tokens are resolved only on the
// execute path and never printed.

import { parseArgs } from "node:util";
import { loadDotVars } from "../../lib/dotvars";
import {
  filterUnseen,
  recordResult,
  type Index,
} from "../../import-bookmarks-lib/index-store";
import {
  buildImportPlan,
  findOversizedMarkdownArticles,
  MARKDOWN_IMPORT_MAX_BYTES,
  type OversizedMarkdownArticle,
  type MarkdownArticle,
} from "../../import-markdown-lib/parse";
import { processedDirFor, type ProcessedMove } from "../../import-markdown-lib/processed";
import type {
  MarkdownSubmitResult,
  MarkdownSubmitSummary,
  MarkdownSubmitArticle,
  MarkdownSubmitOpts,
} from "../../import-markdown-lib/submit";
import { apiBaseFromEndpoint, readingApiFor, type ReadingApi } from "../../lib/reading-api";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface ImportMarkdownDeps extends BaseDeps {
  readMarkdownDir: (dir: string) => Promise<MarkdownArticle[]>;
  loadIndex: (path: string) => Promise<Index>;
  saveIndex: (path: string, index: Index) => Promise<void>;
  moveArticlesToProcessed: (
    articles: Array<MarkdownArticle & { sourceUrl: string }>,
    dir: string,
  ) => Promise<ProcessedMove[]>;
  submitAll: (articles: MarkdownSubmitArticle[], opts: MarkdownSubmitOpts) => Promise<MarkdownSubmitSummary>;
  // Constructed only on the execute path (plan mode never touches the network).
  makeApi: (target: { base: string; token: string }) => ReadingApi;
  resolveToken: (flag?: string) => string;
  now: () => number;
}

const DEFAULT_DESTINATION_URL = "http://127.0.0.1:8787/api/readings/import-markdown";

interface Args {
  dir: string;
  destinationUrl: string;
  tokenFlag?: string;
  indexPath: string;
  execute: boolean;
  email: boolean;
}

function parseImportArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        dir: { type: "string" },
        url: { type: "string" },
        token: { type: "string" },
        index: { type: "string" },
        execute: { type: "boolean", default: false },
        email: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (!values.dir) throw new UsageError("missing required --dir <path>");
  const destinationUrl = values.url ?? process.env.READER_MARKDOWN_URL ?? DEFAULT_DESTINATION_URL;
  if (!/^https?:\/\//i.test(destinationUrl)) {
    throw new UsageError(`--url must start with http:// or https:// (got ${destinationUrl})`);
  }
  return {
    dir: values.dir,
    destinationUrl,
    tokenFlag: values.token,
    indexPath: values.index ?? "./.import-markdown-index.json",
    execute: values.execute === true,
    email: values.email === true,
  };
}

async function runImportMarkdown(argv: string[], deps: ImportMarkdownDeps): Promise<number> {
  const args = parseImportArgs(argv);

  const articles = await deps.readMarkdownDir(args.dir);
  const plan = buildImportPlan(articles);
  const articlesBySource = groupArticlesBySource(plan.files);
  const selectedByUrl = new Map(
    plan.selected
      .filter((article): article is MarkdownArticle & { sourceUrl: string } =>
        article.sourceUrl !== undefined,
      )
      .map((article) => [article.sourceUrl, article]),
  );

  const index = await deps.loadIndex(args.indexPath);
  const sourceUrls = [...selectedByUrl.keys()];
  const { unseen, seen } = filterUnseen(sourceUrls, index, args.destinationUrl);
  const toSubmit = unseen
    .map((sourceUrl) => selectedByUrl.get(sourceUrl))
    .filter((article): article is MarkdownArticle & { sourceUrl: string } => article !== undefined);
  const oversized = findOversizedMarkdownArticles(toSubmit);
  let movedCount = 0;

  logPlan(deps.io, args, plan, seen.length, toSubmit, oversized.length);

  if (!args.execute) {
    if (oversized.length > 0) logOversized(deps.io, oversized);
    deps.io.stderr("Rerun with --execute to submit, record, and move files.");
    printSummary(deps.io, {
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
    return 0;
  }

  const token = deps.resolveToken(args.tokenFlag);
  if (!token) {
    throw new UsageError("missing token. pass --token, set READER_API_TOKEN in env, or add it to .dev.vars.");
  }

  if (oversized.length > 0) {
    logOversized(deps.io, oversized);
    printSummary(deps.io, {
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
    return 1;
  }

  const seenArticles = articlesForSources(seen, articlesBySource);
  if (seenArticles.length > 0) {
    const moves = await deps.moveArticlesToProcessed(seenArticles, args.dir);
    movedCount += moves.length;
    logMoves(deps.io, "already processed", moves);
  }

  if (toSubmit.length === 0) {
    printSummary(deps.io, {
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
    return 0;
  }

  const summary = await deps.submitAll(
    toSubmit.map((article) => ({
      sourceUrl: article.sourceUrl,
      markdown: article.markdown,
      filePath: article.filePath,
      ...(article.title === undefined ? {} : { title: article.title }),
    })),
    {
      api: deps.makeApi({ base: apiBaseFromEndpoint(args.destinationUrl), token }),
      email: args.email,
      onResult: async (r) => {
        logResult(deps.io, r);
        if (r.classification === "new" || r.classification === "existing") {
          recordResult(index, args.destinationUrl, r.sourceUrl, {
            id: r.id ?? "",
            submitted_at: new Date(deps.now()).toISOString(),
            classification: r.classification,
          });
          await deps.saveIndex(args.indexPath, index);
          const moves = await deps.moveArticlesToProcessed(
            articlesBySource.get(r.sourceUrl) ?? [],
            args.dir,
          );
          movedCount += moves.length;
          logMoves(deps.io, "processed", moves);
        }
      },
    },
  );

  printSummary(deps.io, {
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
  return summary.errors > 0 ? 1 : 0;
}

function logPlan(
  io: CommandIo,
  args: Args,
  plan: ReturnType<typeof buildImportPlan>,
  seenCount: number,
  toSubmit: Array<MarkdownArticle & { sourceUrl: string }>,
  oversizedCount: number,
): void {
  io.stderr(
    `Directory:        ${args.dir}\n` +
      `Files found:      ${plan.files.length}\n` +
      `Unique sources:   ${plan.selected.length}\n` +
      `Duplicate groups: ${plan.duplicateGroups.length}\n` +
      `Missing source:   ${plan.missingSource.length}\n` +
      `Oversized:        ${oversizedCount}  (> ${MARKDOWN_IMPORT_MAX_BYTES} bytes)\n` +
      `Already sent:     ${seenCount}  (from ${args.indexPath})\n` +
      `Would submit:     ${toSubmit.length} to ${args.destinationUrl}\n` +
      `Email:            ${args.email ? "yes" : "no"}\n`,
  );

  for (const group of plan.duplicateGroups) {
    io.stderr(
      `duplicate ${group.sourceUrl}\n` +
        `  selected: ${group.selected.fileName} (${group.selected.bytes} bytes)`,
    );
    for (const file of group.files) {
      if (file.fileName === group.selected.fileName) continue;
      io.stderr(`  skipped:  ${file.fileName} (${file.bytes} bytes)`);
    }
  }

  if (plan.missingSource.length > 0) {
    io.stderr("\nmissing source line:");
    for (const file of plan.missingSource) {
      io.stderr(`  ${file.fileName}`);
    }
  }
}

function logOversized(io: CommandIo, oversized: OversizedMarkdownArticle[]): void {
  io.stderr(
    `\nblocked oversized markdown files (Cloudflare Queues message limit: ${MARKDOWN_IMPORT_MAX_BYTES} bytes / 128 KB):`,
  );
  for (const item of oversized) {
    io.stderr(`  ${item.article.fileName}: ${item.article.bytes} bytes (${item.excessBytes} over)`);
  }
}

function logResult(io: CommandIo, r: MarkdownSubmitResult): void {
  const tag = r.classification.padEnd(8);
  const id = r.id ? `id=${r.id} ` : "";
  const err = r.error ? ` -- ${r.error}` : "";
  io.stderr(`[${r.index}/${r.total}] ${tag}${id}${r.sourceUrl} (${r.filePath})${err}`);
}

function logMoves(io: CommandIo, label: string, moves: ProcessedMove[]): void {
  for (const move of moves) {
    io.stderr(`  moved ${label}: ${move.fileName} -> ${move.destinationPath}`);
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

function printSummary(io: CommandIo, s: FinalSummary): void {
  io.stdout(JSON.stringify({
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
  }, null, 2));
}

export const importMarkdownCommand: CommandDefinition<ImportMarkdownDeps> = {
  group: "import",
  name: "markdown",
  summary: "Import a directory of local .md files via import-markdown",
  safety: "plan-first",
  helpText: `Plans by default: reads the directory and local index, prints the
file-selection and size plan, and touches nothing. --execute submits each
unseen file, records it in the local index, and moves it into processed/.

Options:
  --dir <path>          Directory containing .md files (required).
  --url <url>           Destination - full URL of the markdown import endpoint.
                        Default: READER_MARKDOWN_URL env, then
                        ${DEFAULT_DESTINATION_URL}.
  --token <token>       Bearer token (execute only). Default: READER_API_TOKEN
                        env, then .dev.vars READER_API_TOKEN. Never printed.
  --index <path>        Path to local index file.
                        Default: ./.import-markdown-index.json.
  --email               Accepted for compatibility; send-time import is always
                        silent even when this flag is set. Default: false.
  --execute             Submit, record, and move files.
  --help                Show this message.

Each file must have a Markdown source line like:
  **Source:** https://example.com/article

When multiple files share the same source URL, the largest Markdown file wins.
Submissions are serial and recorded in the local index after each successful
new/existing response, so interrupted runs are resumable.`,
  defaultDeps: (io: CommandIo): ImportMarkdownDeps => ({
    io,
    readMarkdownDir: async (dir) => {
      const { readMarkdownDir } = await import("../../import-markdown-lib/parse");
      return readMarkdownDir(dir);
    },
    loadIndex: async (path) => {
      const { loadIndex } = await import("../../import-bookmarks-lib/index-store");
      return loadIndex(path);
    },
    saveIndex: async (path, index) => {
      const { saveIndex } = await import("../../import-bookmarks-lib/index-store");
      await saveIndex(path, index);
    },
    moveArticlesToProcessed: async (articles, dir) => {
      const { moveArticlesToProcessed } = await import("../../import-markdown-lib/processed");
      return moveArticlesToProcessed(articles, dir);
    },
    submitAll: async (articles, opts) => {
      const { submitMarkdownAll } = await import("../../import-markdown-lib/submit");
      return submitMarkdownAll(articles, opts);
    },
    makeApi: (target) => readingApiFor({ ...target, fetch: globalThis.fetch }),
    resolveToken: (flag) =>
      flag ?? process.env.READER_API_TOKEN ?? loadDotVars(".dev.vars").READER_API_TOKEN ?? "",
    now: () => Date.now(),
  }),
  run: runImportMarkdown,
};
