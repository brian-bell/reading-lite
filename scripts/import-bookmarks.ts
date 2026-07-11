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
  file: string;
  folder: string;
  destinationUrl: string;
  token: string;
  indexPath: string;
  dryRun: boolean;
  quick: boolean;
}

const DEFAULT_DESTINATION_URL = "http://127.0.0.1:8787/api/readings";

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      folder: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
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

  if (!values.file) {
    console.error("missing required --file <path>");
    printUsage();
    process.exit(2);
  }

  const devVars = loadDotVars(".dev.vars");
  const destinationUrl =
    values.url ?? process.env.READER_URL ?? DEFAULT_DESTINATION_URL;
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
    file: values.file,
    folder: values.folder ?? "Computing",
    destinationUrl,
    token,
    indexPath: values.index ?? "./.import-bookmarks-index.json",
    dryRun: values["dry-run"] === true,
    quick: values.quick === true,
  };
}

function printUsage(): void {
  console.log(`Usage: npm run import-bookmarks -- --file <path> [options]

  --file <path>         Chrome bookmark HTML export (required).
  --folder <path>       Folder path. Default: "Computing".
                        Use "/" for nested (e.g. "Computing/AI/MCP").
  --url <url>           Destination — full URL of the readings endpoint to
                        POST to. Default: READER_URL env, then
                        ${DEFAULT_DESTINATION_URL}.
  --token <token>       Bearer token. Default: READER_API_TOKEN env, then
                        .dev.vars READER_API_TOKEN.
  --index <path>        Path to local index file.
                        Default: ./.import-bookmarks-index.json.
  --dry-run             Print plan, don't prompt, don't POST.
  --quick               Skip the per-URL prompt and submit everything.
  --help                Show this message.

Submits each URL in the chosen folder to the destination, one at a time.
Skips URLs already recorded in the local index (per destination). On success,
records the URL in the index immediately so re-runs and resumes are no-ops.

Default flow asks Y/n/q before each URL: Enter or 'y' to submit, 'n' to skip,
'q' to abort. Use --quick to fire everything without prompting.`);
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  const raw = await fs.readFile(args.file, "utf8");
  const tree = parseBookmarksHtml(raw);
  const folder = selectFolder(tree, args.folder);
  if (!folder) {
    console.error(`folder not found: ${args.folder}`);
    console.error(`top-level folders: ${tree.folders.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }

  const allUrls = collectLinks(folder).map((l) => l.url);
  const index = await loadIndex(args.indexPath);
  const { unseen, seen } = filterUnseen(allUrls, index, args.destinationUrl);

  const mode = args.quick ? "quick" : "interactive";
  process.stderr.write(
    `Folder:       ${args.folder}\n` +
      `URLs found:   ${allUrls.length}\n` +
      `Already sent: ${seen.length}  (from ${args.indexPath})\n` +
      `Will submit:  ${unseen.length} to ${args.destinationUrl} (${mode})\n\n`,
  );

  if (args.dryRun) {
    if (unseen.length > 0) {
      process.stderr.write(`[dry-run] would submit:\n`);
      for (const url of unseen) process.stderr.write(`  ${url}\n`);
    }
    printSummary({ folder: args.folder, total: allUrls.length, indexed: seen.length, submitted: 0,
      new: 0, existing: 0, skipped: 0, errors: 0, indexPath: args.indexPath });
    return;
  }

  if (unseen.length === 0) {
    printSummary({ folder: args.folder, total: allUrls.length, indexed: seen.length, submitted: 0,
      new: 0, existing: 0, skipped: 0, errors: 0, indexPath: args.indexPath });
    return;
  }

  const prompter = args.quick ? null : createPrompter();
  let summary;
  try {
    summary = await submitAll(unseen, {
      fetch: globalThis.fetch,
      destinationUrl: args.destinationUrl,
      token: args.token,
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
          recordResult(index, args.destinationUrl, r.url, {
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
    folder: args.folder,
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

function logResult(r: SubmitResult): void {
  const tag = r.classification.padEnd(8);
  const id = r.id ? `id=${r.id} ` : "";
  const err = r.error ? ` — ${r.error}` : "";
  process.stderr.write(`[${r.index}/${r.total}] ${tag}${id}${r.url}${err}\n`);
}

interface FinalSummary {
  folder: string;
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
    folder: s.folder,
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
