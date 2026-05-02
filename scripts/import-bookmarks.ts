#!/usr/bin/env -S npx tsx
import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import { loadDotVars } from "./lib/dotvars";
import { createPrompter } from "./import-bookmarks-lib/confirm";
import {
  filterUnseen,
  loadIndex,
  recordResult,
  saveIndex,
} from "./import-bookmarks-lib/index-store";
import { parseBookmarksHtml } from "./import-bookmarks-lib/parse";
import { collectLinks, selectFolder } from "./import-bookmarks-lib/select";
import { submitAll, type SubmitResult } from "./import-bookmarks-lib/submit";

interface Args {
  file?: string;
  url?: string;
  folder: string;
  base: string;
  token: string;
  concurrency: number;
  indexPath: string;
  dryRun: boolean;
  quick: boolean;
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      url: { type: "string" },
      folder: { type: "string" },
      base: { type: "string" },
      token: { type: "string" },
      concurrency: { type: "string" },
      index: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      quick: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  if (!values.file && !values.url) {
    console.error("missing required input: pass --file <path> or --url <url>");
    printUsage();
    process.exit(2);
  }
  if (values.file && values.url) {
    console.error("--file and --url are mutually exclusive");
    process.exit(2);
  }
  if (values.url && !/^https?:\/\//i.test(values.url)) {
    console.error(`--url must start with http:// or https:// (got ${values.url})`);
    process.exit(2);
  }

  const devVars = loadDotVars(".dev.vars");
  const base =
    values.base ?? process.env.READER_BASE_URL ?? "http://127.0.0.1:8787";
  const token =
    values.token ?? process.env.READER_API_TOKEN ?? devVars.READER_API_TOKEN ?? "";
  if (!token && !values["dry-run"]) {
    console.error(
      "missing token. pass --token, set READER_API_TOKEN in env, or add it to .dev.vars (use --dry-run to skip).",
    );
    process.exit(2);
  }

  const concurrency = Number(values.concurrency ?? 4);
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    console.error(`invalid --concurrency ${values.concurrency}`);
    process.exit(2);
  }

  return {
    file: values.file,
    url: values.url,
    folder: values.folder ?? "Computing",
    base: base.replace(/\/+$/, ""),
    token,
    concurrency,
    indexPath: values.index ?? "./.import-bookmarks-index.json",
    dryRun: values["dry-run"] === true,
    quick: values.quick === true,
  };
}

function printUsage(): void {
  console.log(`Usage: npm run import-bookmarks -- (--file <path> | --url <url>) [options]

  --file <path>         Chrome bookmark HTML export. Mutually exclusive with --url.
  --url <url>           Submit a single URL. Mutually exclusive with --file.
  --folder <path>       Folder path (only with --file). Default: "Computing".
                        Use "/" for nested (e.g. "Computing/AI/MCP").
  --base <url>          Reader base URL. Default: READER_BASE_URL env, then
                        http://127.0.0.1:8787.
  --token <token>       Bearer token. Default: READER_API_TOKEN env, then
                        .dev.vars READER_API_TOKEN.
  --concurrency <n>     Parallel POSTs in --quick mode. Default: 4.
                        (Ignored otherwise — interactive prompts force serial.)
  --index <path>        Path to local index file.
                        Default: ./.import-bookmarks-index.json.
  --dry-run             Print plan, don't prompt, don't POST.
  --quick               Skip the per-URL prompt and submit everything (uses
                        the configured concurrency).
  --help                Show this message.

Submits each URL to POST /readings. Skips URLs that are already recorded in
the local index (per base URL). On success, records the URL in the index
immediately so re-runs and resumes are no-ops.

Default flow asks Y/n/q before each URL: Enter or 'y' to submit, 'n' to skip,
'q' to abort. Use --quick to fire everything without prompting.`);
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  const { allUrls, source } = await collectInputUrls(args);
  const index = await loadIndex(args.indexPath);
  const { unseen, seen } = filterUnseen(allUrls, index, args.base);

  const mode = args.quick ? `quick, concurrency ${args.concurrency}` : "interactive";
  process.stderr.write(
    `Source:       ${source}\n` +
      `URLs found:   ${allUrls.length}\n` +
      `Already sent: ${seen.length}  (from ${args.indexPath})\n` +
      `Will submit:  ${unseen.length} to ${args.base} (${mode})\n\n`,
  );

  if (args.dryRun) {
    if (unseen.length > 0) {
      process.stderr.write(`[dry-run] would submit:\n`);
      for (const url of unseen) process.stderr.write(`  ${url}\n`);
    }
    printSummary({ source, total: allUrls.length, indexed: seen.length, submitted: 0,
      new: 0, existing: 0, skipped: 0, errors: 0, indexPath: args.indexPath });
    return;
  }

  if (unseen.length === 0) {
    printSummary({ source, total: allUrls.length, indexed: seen.length, submitted: 0,
      new: 0, existing: 0, skipped: 0, errors: 0, indexPath: args.indexPath });
    return;
  }

  const prompter = args.quick ? null : createPrompter();
  let summary;
  try {
    summary = await submitAll(unseen, {
      fetch: globalThis.fetch,
      base: args.base,
      token: args.token,
      concurrency: args.concurrency,
      beforeSubmit: prompter
        ? async (ctx) => {
            const decision = await prompter.ask(
              `[${ctx.index}/${ctx.total}] ${ctx.url}\n  submit? [Y/n/q]`,
            );
            if (decision === "yes") return "submit";
            if (decision === "no") return "skip";
            return "quit";
          }
        : undefined,
      onResult: async (r) => {
        logResult(r);
        if (r.classification === "new" || r.classification === "existing") {
          recordResult(index, args.base, r.url, {
            id: r.id ?? "",
            submitted_at: new Date().toISOString(),
            classification: r.classification,
          });
          await saveIndex(args.indexPath, index);
        }
      },
    });
  } finally {
    prompter?.close();
  }

  printSummary({
    source,
    total: allUrls.length,
    indexed: seen.length,
    submitted: summary.new + summary.existing + summary.skipped + summary.errors,
    new: summary.new,
    existing: summary.existing,
    skipped: summary.skipped,
    errors: summary.errors,
    indexPath: args.indexPath,
  });
  if (summary.errors > 0) process.exit(1);
}

async function collectInputUrls(args: Args): Promise<{ allUrls: string[]; source: string }> {
  if (args.url) {
    return { allUrls: [args.url], source: args.url };
  }
  if (!args.file) {
    // unreachable: parseCliArgs enforces one of file/url
    throw new Error("no input source");
  }
  const raw = await fs.readFile(args.file, "utf8");
  const tree = parseBookmarksHtml(raw);
  const folder = selectFolder(tree, args.folder);
  if (!folder) {
    console.error(`folder not found: ${args.folder}`);
    console.error(`top-level folders: ${tree.folders.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }
  return { allUrls: collectLinks(folder).map((l) => l.url), source: args.folder };
}

function logResult(r: SubmitResult): void {
  const tag = r.classification.padEnd(8);
  const id = r.id ? `id=${r.id} ` : "";
  const err = r.error ? ` — ${r.error}` : "";
  process.stderr.write(`[${r.index}/${r.total}] ${tag}${id}${r.url}${err}\n`);
}

interface FinalSummary {
  source: string;
  total: number;
  indexed: number;
  submitted: number;
  new: number;
  existing: number;
  skipped: number;
  errors: number;
  indexPath: string;
}

function printSummary(s: FinalSummary): void {
  process.stdout.write(JSON.stringify({
    source: s.source,
    total: s.total,
    indexed: s.indexed,
    submitted: s.submitted,
    new: s.new,
    existing: s.existing,
    skipped: s.skipped,
    errors: s.errors,
    index_path: s.indexPath,
  }, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
