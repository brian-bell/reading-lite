#!/usr/bin/env -S npx tsx
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  annotateEntries,
  buildCorpusUrlSet,
  parseListIndex,
  type ReadingListEntry,
} from "./check-corpus-lib/corpus";
import { fetchListIndex } from "./check-corpus-lib/fetch-index";

interface Args {
  file: string;
  out: string;
  bucket: string;
  statuses: string[];
  remote: boolean;
  dryRun: boolean;
}

const DEFAULT_BUCKET = "reading-lite";

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      out: { type: "string" },
      bucket: { type: "string" },
      status: { type: "string", multiple: true },
      "any-status": { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
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

  const statuses = values["any-status"]
    ? ["ready", "pending", "failed"]
    : values.status && values.status.length > 0
      ? values.status
      : ["ready"];

  return {
    file: values.file,
    out: values.out ?? values.file,
    bucket: values.bucket ?? process.env.READING_LITE_BUCKET ?? DEFAULT_BUCKET,
    statuses,
    remote: values.local !== true,
    dryRun: values["dry-run"] === true,
  };
}

function printUsage(): void {
  console.log(`Usage: npm run check-corpus -- --file <path> [options]

Reads index/list.json straight out of the reading-lite R2 bucket (via
wrangler), then stamps each entry of a reading-list JSON file with
"processed": true|false depending on whether its URL is already in the corpus.

Membership is exact-URL match against entries whose status is "ready" — the
same key the worker hashes for its by-url dedup pointer.

  --file <path>     Reading-list JSON: an array of { url, ... } entries (required).
  --out <path>      Where to write the annotated JSON. Default: in place (--file).
  --bucket <name>   R2 bucket. Default: READING_LITE_BUCKET env, then
                    "${DEFAULT_BUCKET}" (production). Staging: "reading-lite-staging".
  --status <s>      Status(es) that count as in-corpus. Repeatable.
                    Default: ready.
  --any-status      Shorthand for --status ready --status pending --status failed.
  --local           Read the local miniflare cache instead of remote R2.
  --dry-run         Print the summary; do not write the file.
  --help            Show this message.

Requires a Cloudflare session: run \`wrangler login\` (or set CLOUDFLARE_API_TOKEN).`);
}

async function readEntries(file: string): Promise<ReadingListEntry[]> {
  const raw = await fs.readFile(file, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON array of entries`);
  }
  return parsed as ReadingListEntry[];
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  const entries = await readEntries(args.file);
  const indexRaw = await fetchListIndex({ bucket: args.bucket, remote: args.remote });
  const corpus = buildCorpusUrlSet(parseListIndex(indexRaw), { statuses: args.statuses });
  const { entries: annotated, summary } = annotateEntries(entries, corpus);

  if (!args.dryRun) {
    const body = JSON.stringify(annotated, null, 2) + "\n";
    const tmp = `${args.out}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, args.out);
  }

  process.stdout.write(
    JSON.stringify(
      {
        file: args.file,
        out: args.dryRun ? null : args.out,
        bucket: args.bucket,
        match_statuses: args.statuses,
        corpus_urls: corpus.size,
        ...summary,
        dry_run: args.dryRun,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
