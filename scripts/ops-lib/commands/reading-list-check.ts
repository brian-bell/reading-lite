// `ops reading-list check` — mark which entries of a reading-list JSON export
// are already in the corpus. Reads index/list.json straight out of the R2
// bucket (via wrangler) and stamps each entry with "processed": true|false.
//
// Plan-first: reading the corpus is fine in plan mode, but the annotated list
// is a durable local write — a mode-less run prints the summary only;
// --execute writes the annotated file.

import path from "node:path";
import { parseArgs } from "node:util";
import {
  annotateEntries,
  buildCorpusUrlSet,
  parseListIndex,
  type ReadingListEntry,
} from "../../check-corpus-lib/corpus";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface ReadingListCheckDeps extends BaseDeps {
  readFile: (path: string) => Promise<string>;
  // Atomic write (tmp + rename), including mkdir of the parent.
  writeFileAtomic: (path: string, body: string) => Promise<void>;
  fetchListIndex: (opts: { bucket: string; remote: boolean }) => Promise<string>;
}

const DEFAULT_BUCKET = "reading-lite";

interface Args {
  file: string;
  out: string;
  bucket: string;
  statuses: string[];
  remote: boolean;
  execute: boolean;
}

function parseCheckArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        file: { type: "string" },
        out: { type: "string" },
        bucket: { type: "string" },
        status: { type: "string", multiple: true },
        "any-status": { type: "boolean", default: false },
        local: { type: "boolean", default: false },
        execute: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (!values.file) throw new UsageError("missing required --file <path>");
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
    execute: values.execute === true,
  };
}

async function runReadingListCheck(argv: string[], deps: ReadingListCheckDeps): Promise<number> {
  const args = parseCheckArgs(argv);
  const { io } = deps;

  const raw = await deps.readFile(args.file);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new UsageError(`${args.file} must contain a JSON array of entries`);
  }
  const entries = parsed as ReadingListEntry[];

  const indexRaw = await deps.fetchListIndex({ bucket: args.bucket, remote: args.remote });
  const corpus = buildCorpusUrlSet(parseListIndex(indexRaw), { statuses: args.statuses });
  const { entries: annotated, summary } = annotateEntries(entries, corpus);

  if (args.execute) {
    await deps.writeFileAtomic(path.resolve(args.out), JSON.stringify(annotated, null, 2) + "\n");
  }

  io.stdout(
    JSON.stringify(
      {
        file: args.file,
        out: args.execute ? args.out : null,
        bucket: args.bucket,
        match_statuses: args.statuses,
        corpus_urls: corpus.size,
        ...summary,
        executed: args.execute,
      },
      null,
      2,
    ),
  );
  if (!args.execute) io.stderr("Plan only — rerun with --execute to write the annotated list.");
  return 0;
}

export const readingListCheckCommand: CommandDefinition<ReadingListCheckDeps> = {
  group: "reading-list",
  name: "check",
  summary: "Mark which reading-list entries are already in the corpus",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- reading-list check --file <path> [options]

Reads index/list.json straight out of the reading-lite R2 bucket (via
wrangler), then stamps each entry of a reading-list JSON file with
"processed": true|false depending on whether its URL is already in the corpus.

Membership is exact-URL match against entries whose status is "ready" — the
same key the worker hashes for its by-url dedup pointer.

Plan by default (summary only); --execute writes the annotated JSON.

Options:
  --file <path>     Reading-list JSON: an array of { url, ... } entries (required).
  --out <path>      Where to write the annotated JSON. Default: in place (--file).
  --bucket <name>   R2 bucket. Default: READING_LITE_BUCKET env, then
                    "${DEFAULT_BUCKET}" (production).
  --status <s>      Status(es) that count as in-corpus. Repeatable.
                    Default: ready.
  --any-status      Shorthand for --status ready --status pending --status failed.
  --local           Read the local miniflare cache instead of remote R2.
  --execute         Write the annotated file.
  --help            Show this message.

Requires a Cloudflare session: run \`wrangler login\` (or set CLOUDFLARE_API_TOKEN).`,
  defaultDeps: (io: CommandIo): ReadingListCheckDeps => ({
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
    fetchListIndex: async (opts) => (await import("../../check-corpus-lib/fetch-index")).fetchListIndex(opts),
  }),
  run: runReadingListCheck,
};
