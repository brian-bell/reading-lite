// `ops reading-list process` — submit the not-yet-processed entries of a
// reading-list JSON file (the output of `reading-list check`) to the reading
// API, then write the outcomes back into the file.
//
// Plan-first: a mode-less run prints the selected rows and intended target
// without prompting, POSTing, or writing; --execute submits (with the per-URL
// Y/n/q prompt unless --quick) and writes annotations back after each result.

import path from "node:path";
import { parseArgs } from "node:util";
import { loadDotVars } from "../../lib/dotvars";
import type { ReadingListEntry } from "../../check-corpus-lib/corpus";
import type { Prompter } from "../../import-bookmarks-lib/confirm";
import { createPrompter } from "../../import-bookmarks-lib/confirm";
import type { SubmitOpts, SubmitResult, SubmitSummary } from "../../import-bookmarks-lib/submit";
import { DEFAULT_API_BASE } from "../../corpus-lib/config";
import { apiBaseFromEndpoint, readingApiFor, type ReadingApi } from "../../lib/reading-api";
import { createResultSink } from "../../process-reading-list-lib/persist";
import { selectUnprocessed } from "../../process-reading-list-lib/select";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface ReadingListProcessDeps extends BaseDeps {
  readFile: (path: string) => Promise<string>;
  // Atomic write (tmp + rename), including mkdir of the parent.
  writeFileAtomic: (path: string, body: string) => Promise<void>;
  submitAll: (urls: string[], opts: SubmitOpts) => Promise<SubmitSummary>;
  createPrompter: () => Prompter;
  // Constructed only on the execute path (plan mode never touches the network).
  makeApi: (target: { base: string; token: string }) => ReadingApi;
  resolveToken: (flag?: string) => string;
  now: () => number;
}

const DEFAULT_DESTINATION_URL = `${DEFAULT_API_BASE}/api/readings`;

interface Args {
  file: string;
  out: string;
  destinationUrl: string;
  tokenFlag?: string;
  resubmit: boolean;
  execute: boolean;
  quick: boolean;
}

function parseProcessArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        file: { type: "string" },
        out: { type: "string" },
        url: { type: "string" },
        token: { type: "string" },
        resubmit: { type: "boolean", default: false },
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
    out: values.out ?? values.file,
    destinationUrl,
    tokenFlag: values.token,
    resubmit: values.resubmit === true,
    execute: values.execute === true,
    quick: values.quick === true,
  };
}

async function runReadingListProcess(argv: string[], deps: ReadingListProcessDeps): Promise<number> {
  const args = parseProcessArgs(argv);
  const { io } = deps;

  const raw = await deps.readFile(args.file);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new UsageError(`${args.file} must contain a JSON array of entries`);
  }
  const entries = parsed as ReadingListEntry[];
  const sel = selectUnprocessed(entries, { resubmit: args.resubmit });

  io.stderr(
    `File:             ${args.file}\n` +
      `Entries:          ${entries.length}\n` +
      `Already processed:${String(sel.alreadyProcessed).padStart(5)}\n` +
      `Already submitted:${String(sel.alreadySubmitted).padStart(5)}  (use --resubmit to retry)\n` +
      `No url:           ${String(sel.noUrl).padStart(4)}\n` +
      `Will submit:      ${sel.selected.length} to ${args.destinationUrl}\n`,
  );

  if (!args.execute) {
    for (const s of sel.selected) io.stderr(`  [plan] ${s.url}`);
    io.stderr("Rerun with --execute to submit and write back outcomes.");
    printSummary(io, { file: args.file, out: null, destination: args.destinationUrl,
      selected: sel.selected.length, confirmed: 0, queued: 0, errors: 0, skipped: 0, executed: false });
    return 0;
  }

  const token = deps.resolveToken(args.tokenFlag);
  if (!token) {
    throw new UsageError("missing token. pass --token, set READER_API_TOKEN, or add it to .dev.vars.");
  }

  if (sel.selected.length === 0) {
    printSummary(io, { file: args.file, out: args.out, destination: args.destinationUrl,
      selected: 0, confirmed: 0, queued: 0, errors: 0, skipped: 0, executed: true });
    return 0;
  }

  const urls = sel.selected.map((s) => s.url);
  const prompter = args.quick ? null : deps.createPrompter();
  const sink = createResultSink({
    entries,
    now: new Date(deps.now()).toISOString(),
    flush: (annotated) =>
      deps.writeFileAtomic(path.resolve(args.out), JSON.stringify(annotated, null, 2) + "\n"),
    onResultLog: (r) => logResult(io, r),
  });
  let errorsExit = 0;
  try {
    await deps.submitAll(urls, {
      api: deps.makeApi({ base: apiBaseFromEndpoint(args.destinationUrl), token }),
      beforeSubmit: prompter
        ? async (ctx) => {
            const decision = await prompter.ask(`[${ctx.index}/${ctx.total}] ${ctx.url}\n  submit? [Y/n/q]`);
            return decision === "yes" ? "submit" : decision === "no" ? "skip" : "quit";
          }
        : undefined,
      onResult: sink.onResult,
    });
  } finally {
    prompter?.close();
  }

  const summary = sink.summary();
  printSummary(io, { file: args.file, out: args.out, destination: args.destinationUrl,
    selected: sel.selected.length, confirmed: summary.confirmed, queued: summary.queued,
    errors: summary.errors, skipped: sink.skipped, executed: true });
  if (summary.errors > 0) errorsExit = 1;
  return errorsExit;
}

function logResult(io: CommandIo, r: SubmitResult): void {
  const tag = r.classification.padEnd(8);
  const id = r.id ? `id=${r.id} ` : "";
  const err = r.error ? ` — ${r.error}` : "";
  io.stderr(`[${r.index}/${r.total}] ${tag}${id}${r.url}${err}`);
}

interface FinalSummary {
  file: string;
  out: string | null;
  destination: string;
  selected: number;
  confirmed: number;
  queued: number;
  errors: number;
  skipped: number;
  executed: boolean;
}

function printSummary(io: CommandIo, s: FinalSummary): void {
  io.stdout(JSON.stringify({
    file: s.file,
    out: s.out,
    destination: s.destination,
    selected: s.selected,
    confirmed: s.confirmed,
    queued: s.queued,
    errors: s.errors,
    skipped: s.skipped,
    executed: s.executed,
  }, null, 2));
}

export const readingListProcessCommand: CommandDefinition<ReadingListProcessDeps> = {
  group: "reading-list",
  name: "process",
  summary: "Submit the not-yet-processed entries of a reading-list JSON file",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- reading-list process --file <path> [options]

Submits the not-yet-processed entries of a reading-list JSON file (the output
of \`reading-list check\`) to the reading-lite API, then writes the outcomes
back into the file. Pairs with \`reading-list check\`: that marks "processed",
this acts on the ones still false.

Selection: entries with processed !== true and a usable http(s) url. Entries
already marked submitted are skipped unless --resubmit.

Write-back per entry: a 200 (already in corpus) sets processed:true; a 202
(accepted, queued) sets submitted:true + reading_id (stays processed:false
until the queue finishes — re-run \`reading-list check\` to promote it); a
failure records submit_error.

Plan by default: prints the selected rows and target without prompting,
POSTing, or writing. --execute asks Y/n/q before each URL (Enter/'y' submit,
'n' skip, 'q' abort); --quick submits everything without prompting.

Options:
  --file <path>     Reading-list JSON array (required). Rewritten in place.
  --out <path>      Write annotated JSON here instead of in place.
  --url <url>       Readings endpoint. Default: READER_URL env, then
                    ${DEFAULT_DESTINATION_URL}.
  --token <token>   Bearer token (execute only). Default: READER_API_TOKEN
                    env, then .dev.vars READER_API_TOKEN. Never printed.
  --resubmit        Also re-submit entries already marked submitted.
  --quick           Submit everything without the per-URL prompt.
  --execute         Submit and write back outcomes.
  --help            Show this message.`,
  defaultDeps: (io: CommandIo): ReadingListProcessDeps => ({
    io,
    readFile: async (p) => {
      const { promises: fs } = await import("node:fs");
      return fs.readFile(p, "utf8");
    },
    writeFileAtomic: async (p, body) => {
      const { promises: fs } = await import("node:fs");
      const tmp = `${p}.${process.pid}.tmp`;
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(tmp, body, "utf8");
      await fs.rename(tmp, p);
    },
    submitAll: async (urls, opts) => (await import("../../import-bookmarks-lib/submit")).submitAll(urls, opts),
    createPrompter: () => createPrompter(),
    makeApi: (target) => readingApiFor({ ...target, fetch: globalThis.fetch }),
    resolveToken: (flag) =>
      flag ?? process.env.READER_API_TOKEN ?? loadDotVars(".dev.vars").READER_API_TOKEN ?? "",
    now: () => Date.now(),
  }),
  run: runReadingListProcess,
};
