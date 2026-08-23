// `ops import bookmarks` — submit every URL in a Chrome bookmark-export folder
// to the reading API, one at a time, resumably.
//
// Plan-first: a mode-less run parses the export, applies the local resume
// index, and prints the would-submit list without prompting, POSTing, or
// writing the index. --execute performs the current serial submission with the
// per-URL Y/n/q prompt (or --quick), recording each success immediately.

import { parseArgs } from "node:util";
import { loadDotVars } from "../../lib/dotvars";
import {
  filterUnseen,
  recordResult,
  type Index,
} from "../../import-bookmarks-lib/index-store";
import { parseBookmarksHtml } from "../../import-bookmarks-lib/parse";
import { collectLinks, selectFolder } from "../../import-bookmarks-lib/select";
import type { SubmitOpts, SubmitResult, SubmitSummary } from "../../import-bookmarks-lib/submit";
import { createPrompter, type Prompter } from "../../import-bookmarks-lib/confirm";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface ImportBookmarksDeps extends BaseDeps {
  readFile: (path: string) => Promise<string>;
  loadIndex: (path: string) => Promise<Index>;
  saveIndex: (path: string, index: Index) => Promise<void>;
  submitAll: (urls: string[], opts: SubmitOpts) => Promise<SubmitSummary>;
  // Interactive per-URL confirmation — constructed only on the execute path.
  createPrompter: () => Prompter;
  fetch: typeof fetch;
  resolveToken: (flag?: string) => string;
  now: () => number;
}

const DEFAULT_DESTINATION_URL = "http://127.0.0.1:8787/api/readings";

interface Args {
  file: string;
  folder: string;
  destinationUrl: string;
  tokenFlag?: string;
  indexPath: string;
  execute: boolean;
  quick: boolean;
}

function parseBookmarkArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        file: { type: "string" },
        folder: { type: "string" },
        url: { type: "string" },
        token: { type: "string" },
        index: { type: "string" },
        execute: { type: "boolean", default: false },
        quick: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (!values.file) throw new UsageError("missing required --file <path>");
  const destinationUrl = values.url ?? process.env.READER_URL ?? DEFAULT_DESTINATION_URL;
  if (!/^https?:\/\//i.test(destinationUrl)) {
    throw new UsageError(`--url must start with http:// or https:// (got ${destinationUrl})`);
  }
  return {
    file: values.file,
    folder: values.folder ?? "Computing",
    destinationUrl,
    tokenFlag: values.token,
    indexPath: values.index ?? "./.import-bookmarks-index.json",
    execute: values.execute === true,
    quick: values.quick === true,
  };
}

async function runImportBookmarks(argv: string[], deps: ImportBookmarksDeps): Promise<number> {
  const args = parseBookmarkArgs(argv);
  const { io } = deps;

  const raw = await deps.readFile(args.file);
  const tree = parseBookmarksHtml(raw);
  const folder = selectFolder(tree, args.folder);
  if (!folder) {
    io.stderr(`folder not found: ${args.folder}`);
    io.stderr(`top-level folders: ${tree.folders.map((f) => f.name).join(", ")}`);
    return 1;
  }

  const allUrls = collectLinks(folder).map((l) => l.url);
  const index = await deps.loadIndex(args.indexPath);
  const { unseen, seen } = filterUnseen(allUrls, index, args.destinationUrl);

  const mode = args.quick ? "quick" : "interactive";
  io.stderr(
    `Folder:       ${args.folder}\n` +
      `URLs found:   ${allUrls.length}\n` +
      `Already sent: ${seen.length}  (from ${args.indexPath})\n` +
      `Will submit:  ${unseen.length} to ${args.destinationUrl} (${mode})\n`,
  );

  if (!args.execute) {
    if (unseen.length > 0) {
      io.stderr(`[plan] would submit:`);
      for (const url of unseen) io.stderr(`  ${url}`);
    }
    io.stderr("Rerun with --execute to submit.");
    printSummary(io, { folder: args.folder, total: allUrls.length, indexed: seen.length, submitted: 0,
      new: 0, existing: 0, skipped: 0, errors: 0, indexPath: args.indexPath });
    return 0;
  }

  const token = deps.resolveToken(args.tokenFlag);
  if (!token) {
    throw new UsageError("missing token. pass --token, set READER_API_TOKEN in env, or add it to .dev.vars.");
  }

  if (unseen.length === 0) {
    printSummary(io, { folder: args.folder, total: allUrls.length, indexed: seen.length, submitted: 0,
      new: 0, existing: 0, skipped: 0, errors: 0, indexPath: args.indexPath });
    return 0;
  }

  const prompter = args.quick ? null : deps.createPrompter();
  let summary;
  try {
    summary = await deps.submitAll(unseen, {
      fetch: deps.fetch,
      destinationUrl: args.destinationUrl,
      token,
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
        logResult(io, r);
        if (r.classification === "new" || r.classification === "existing") {
          recordResult(index, args.destinationUrl, r.url, {
            id: r.id ?? "",
            submitted_at: new Date(deps.now()).toISOString(),
            classification: r.classification,
          });
          await deps.saveIndex(args.indexPath, index);
        }
      },
    });
  } finally {
    prompter?.close();
  }

  printSummary(io, {
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
  return summary.errors > 0 ? 1 : 0;
}

function logResult(io: CommandIo, r: SubmitResult): void {
  const tag = r.classification.padEnd(8);
  const id = r.id ? `id=${r.id} ` : "";
  const err = r.error ? ` — ${r.error}` : "";
  io.stderr(`[${r.index}/${r.total}] ${tag}${id}${r.url}${err}`);
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

function printSummary(io: CommandIo, s: FinalSummary): void {
  io.stdout(JSON.stringify({
    folder: s.folder,
    total: s.total,
    indexed: s.indexed,
    submitted: s.submitted,
    new: s.new,
    existing: s.existing,
    skipped: s.skipped,
    errors: s.errors,
    index_path: s.indexPath,
  }, null, 2));
}

export const importBookmarksCommand: CommandDefinition<ImportBookmarksDeps> = {
  group: "import",
  name: "bookmarks",
  summary: "Submit a Chrome bookmark-export folder to the reading API",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- import bookmarks --file <path> [options]

Submits each URL in the chosen folder to the destination, one at a time.
Skips URLs already recorded in the local index (per destination). On success,
records the URL in the index immediately so re-runs and resumes are no-ops.

Plan by default: prints the would-submit list without prompting or POSTing.
--execute asks Y/n/q before each URL: Enter or 'y' to submit, 'n' to skip,
'q' to abort. Use --quick to fire everything without prompting.

Options:
  --file <path>         Chrome bookmark HTML export (required).
  --folder <path>       Folder path. Default: "Computing".
                        Use "/" for nested (e.g. "Computing/AI/MCP").
  --url <url>           Destination — full URL of the readings endpoint to
                        POST to. Default: READER_URL env, then
                        ${DEFAULT_DESTINATION_URL}.
  --token <token>       Bearer token (execute only). Default: READER_API_TOKEN
                        env, then .dev.vars READER_API_TOKEN. Never printed.
  --index <path>        Path to local index file.
                        Default: ./.import-bookmarks-index.json.
  --quick               Skip the per-URL prompt and submit everything.
  --execute             Prompt (unless --quick) and submit.
  --help                Show this message.`,
  defaultDeps: (io: CommandIo): ImportBookmarksDeps => ({
    io,
    readFile: async (p) => {
      const { promises: fs } = await import("node:fs");
      return fs.readFile(p, "utf8");
    },
    loadIndex: async (p) => (await import("../../import-bookmarks-lib/index-store")).loadIndex(p),
    saveIndex: async (p, index) => (await import("../../import-bookmarks-lib/index-store")).saveIndex(p, index),
    submitAll: async (urls, opts) => (await import("../../import-bookmarks-lib/submit")).submitAll(urls, opts),
    createPrompter: () => createPrompter(),
    fetch: globalThis.fetch,
    resolveToken: (flag) =>
      flag ?? process.env.READER_API_TOKEN ?? loadDotVars(".dev.vars").READER_API_TOKEN ?? "",
    now: () => Date.now(),
  }),
  run: runImportBookmarks,
};
