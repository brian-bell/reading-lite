#!/usr/bin/env -S npx tsx
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadDotVars } from "./lib/dotvars";
import type { ReadingListEntry } from "./check-corpus-lib/corpus";
import { createPrompter } from "./import-bookmarks-lib/confirm";
import { submitAll, type SubmitResult } from "./import-bookmarks-lib/submit";
import { createResultSink } from "./process-reading-list-lib/persist";
import { selectUnprocessed } from "./process-reading-list-lib/select";

interface Args {
  file: string;
  out: string;
  destinationUrl: string;
  token: string;
  resubmit: boolean;
  dryRun: boolean;
  quick: boolean;
}

const DEFAULT_DESTINATION_URL = "https://reading-lite.bbell.dev/readings";

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      out: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
      resubmit: { type: "boolean", default: false },
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
  const destinationUrl = values.url ?? process.env.READER_URL ?? DEFAULT_DESTINATION_URL;
  if (!/^https?:\/\//i.test(destinationUrl)) {
    console.error(`--url must start with http:// or https:// (got ${destinationUrl})`);
    process.exit(2);
  }

  const token =
    values.token ?? process.env.READER_API_TOKEN ?? devVars.READER_API_TOKEN ?? "";
  if (!token && !values["dry-run"]) {
    console.error(
      "missing token. pass --token, set READER_API_TOKEN, or add it to .dev.vars (use --dry-run to skip).",
    );
    process.exit(2);
  }

  return {
    file: values.file,
    out: values.out ?? values.file,
    destinationUrl,
    token,
    resubmit: values.resubmit === true,
    dryRun: values["dry-run"] === true,
    quick: values.quick === true,
  };
}

function printUsage(): void {
  console.log(`Usage: npm run process-reading-list -- --file <path> [options]

Submits the not-yet-processed entries of a reading-list JSON file (the output
of check-reading-list) to the reading-lite API, then writes the outcomes back
into the file. Pairs with check-reading-list: that marks "processed", this acts
on the ones still false.

Selection: entries with processed !== true and a usable http(s) url. Entries
already marked submitted are skipped unless --resubmit.

Write-back per entry: a 200 (already in corpus) sets processed:true; a 202
(accepted, queued) sets submitted:true + reading_id (stays processed:false
until the queue finishes — re-run check-reading-list to promote it); a failure
records submit_error.

  --file <path>     Reading-list JSON array (required). Rewritten in place.
  --out <path>      Write annotated JSON here instead of in place.
  --url <url>       Readings endpoint. Default: READER_URL env, then
                    ${DEFAULT_DESTINATION_URL}.
  --token <token>   Bearer token. Default: READER_API_TOKEN env, then
                    .dev.vars READER_API_TOKEN.
  --resubmit        Also re-submit entries already marked submitted.
  --dry-run         Print the plan and counts; do not POST or write.
  --quick           Submit everything without the per-URL prompt.
  --help            Show this message.

Default flow asks Y/n/q before each URL: Enter/'y' submit, 'n' skip, 'q' abort.`);
}

async function readEntries(file: string): Promise<ReadingListEntry[]> {
  const raw = await fs.readFile(file, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON array of entries`);
  }
  return parsed as ReadingListEntry[];
}

async function writeEntries(out: string, entries: ReadingListEntry[]): Promise<void> {
  const body = JSON.stringify(entries, null, 2) + "\n";
  const tmp = `${out}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, out);
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const entries = await readEntries(args.file);
  const sel = selectUnprocessed(entries, { resubmit: args.resubmit });

  process.stderr.write(
    `File:             ${args.file}\n` +
      `Entries:          ${entries.length}\n` +
      `Already processed:${String(sel.alreadyProcessed).padStart(5)}\n` +
      `Already submitted:${String(sel.alreadySubmitted).padStart(5)}  (use --resubmit to retry)\n` +
      `No url:           ${String(sel.noUrl).padStart(4)}\n` +
      `Will submit:      ${sel.selected.length} to ${args.destinationUrl}\n\n`,
  );

  if (args.dryRun) {
    for (const s of sel.selected) process.stderr.write(`  [dry-run] ${s.url}\n`);
    printSummary({ file: args.file, out: null, destination: args.destinationUrl,
      selected: sel.selected.length, confirmed: 0, queued: 0, errors: 0, skipped: 0, dryRun: true });
    return;
  }

  if (sel.selected.length === 0) {
    printSummary({ file: args.file, out: args.out, destination: args.destinationUrl,
      selected: 0, confirmed: 0, queued: 0, errors: 0, skipped: 0, dryRun: false });
    return;
  }

  const urls = sel.selected.map((s) => s.url);
  const prompter = args.quick ? null : createPrompter();
  const sink = createResultSink({
    entries,
    now: new Date().toISOString(),
    flush: (annotated) => writeEntries(args.out, annotated),
    onResultLog: logResult,
  });
  try {
    await submitAll(urls, {
      fetch: globalThis.fetch,
      destinationUrl: args.destinationUrl,
      token: args.token,
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
  printSummary({ file: args.file, out: args.out, destination: args.destinationUrl,
    selected: sel.selected.length, confirmed: summary.confirmed, queued: summary.queued,
    errors: summary.errors, skipped: sink.skipped, dryRun: false });
  if (summary.errors > 0) process.exit(1);
}

function logResult(r: SubmitResult): void {
  const tag = r.classification.padEnd(8);
  const id = r.id ? `id=${r.id} ` : "";
  const err = r.error ? ` — ${r.error}` : "";
  process.stderr.write(`[${r.index}/${r.total}] ${tag}${id}${r.url}${err}\n`);
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
  dryRun: boolean;
}

function printSummary(s: FinalSummary): void {
  process.stdout.write(JSON.stringify({
    file: s.file,
    out: s.out,
    destination: s.destination,
    selected: s.selected,
    confirmed: s.confirmed,
    queued: s.queued,
    errors: s.errors,
    skipped: s.skipped,
    dry_run: s.dryRun,
  }, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
