#!/usr/bin/env -S npx tsx
import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import { loadDotVars } from "./lib/dotvars";
import { confirm } from "./import-bookmarks-lib/confirm";
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
  base: string;
  token: string;
  concurrency: number;
  indexPath: string;
  dryRun: boolean;
  yes: boolean;
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      folder: { type: "string" },
      base: { type: "string" },
      token: { type: "string" },
      concurrency: { type: "string" },
      index: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  if (!values.file) {
    console.error("missing required --file");
    printUsage();
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
    folder: values.folder ?? "Computing",
    base: base.replace(/\/+$/, ""),
    token,
    concurrency,
    indexPath: values.index ?? "./.import-bookmarks-index.json",
    dryRun: values["dry-run"] === true,
    yes: values.yes === true,
  };
}

function printUsage(): void {
  console.log(`Usage: npm run import-bookmarks -- --file <path> [options]

  --file <path>         Chrome bookmark HTML export (required)
  --folder <path>       Folder path. Default: "Computing".
                        Use "/" for nested (e.g. "Computing/AI/MCP").
  --base <url>          Reader base URL. Default: READER_BASE_URL env, then
                        http://127.0.0.1:8787.
  --token <token>       Bearer token. Default: READER_API_TOKEN env, then
                        .dev.vars READER_API_TOKEN.
  --concurrency <n>     Parallel POSTs. Default: 4.
  --index <path>        Path to local index file.
                        Default: ./.import-bookmarks-index.json.
  --dry-run             Print plan, don't prompt, don't POST.
  --yes                 Skip the y/N confirmation prompt (for CI / scripts).
  --help                Show this message.

Submits each URL in the chosen folder to POST /readings. Skips URLs that are
already recorded in the local index (per base URL). On success, records the
URL in the index immediately so re-runs and resumes are no-ops.`);
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
  const { unseen, seen } = filterUnseen(allUrls, index, args.base);

  process.stderr.write(
    `Folder:       ${args.folder}\n` +
      `URLs found:   ${allUrls.length}\n` +
      `Already sent: ${seen.length}  (from ${args.indexPath})\n` +
      `Will submit:  ${unseen.length} to ${args.base} (concurrency ${args.concurrency})\n\n`,
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

  const ok = await confirm("Continue? [y/N]", { yes: args.yes });
  if (!ok) {
    process.stderr.write("aborted.\n");
    process.exit(1);
  }

  const summary = await submitAll(unseen, {
    fetch: globalThis.fetch,
    base: args.base,
    token: args.token,
    concurrency: args.concurrency,
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

  printSummary({
    folder: args.folder,
    total: allUrls.length,
    indexed: seen.length,
    submitted: unseen.length,
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
