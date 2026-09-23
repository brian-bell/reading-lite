// `ops reading-list check` — mark which entries of a reading-list JSON export
// are already in the corpus, by resolving each exported URL against the
// tenant's URL claims (`reading_urls`) in PostgreSQL.
//
// This is the command whose silence was most expensive. It used to read
// `index/list.json`, which nothing has written since the storage migration's
// slice 1b: every saved URL came back unprocessed, and `reading-list process`
// would then resubmit the entire library — paying to re-summarize a corpus
// that was already complete.
//
// Plan-first: reading the corpus is fine in plan mode, but the annotated list
// is a durable local write — a mode-less run prints the summary only;
// --execute writes the annotated file.

import path from "node:path";
import { parseArgs } from "node:util";
import {
  annotateEntries,
  buildCorpusUrlSet,
  type CorpusItem,
  type ReadingListEntry,
} from "../../check-corpus-lib/corpus";
import { resolveBucket } from "../../corpus-lib/config";
import { DATABASE_URL_ENV_FLAG_HELP, openOperatorSql, type OpenOperatorSql } from "../../pg-lib/operator-db";
import { withOperatorCorpus } from "../../pg-lib/operator-corpus";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";

export interface ReadingListCheckDeps extends BaseDeps {
  readFile: (path: string) => Promise<string>;
  // Atomic write (tmp + rename), including mkdir of the parent.
  writeFileAtomic: (path: string, body: string) => Promise<void>;
  openSql: OpenOperatorSql;
  env: Record<string, string | undefined>;
}

interface Args {
  file: string;
  out: string;
  bucket: string;
  tenant?: string;
  databaseUrlEnv?: string;
  statuses: string[];
  local: boolean;
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
        tenant: { type: "string" },
        "database-url-env": { type: "string" },
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
    bucket: resolveBucket(values.bucket),
    ...(values.tenant === undefined ? {} : { tenant: values.tenant }),
    ...(values["database-url-env"] === undefined
      ? {}
      : { databaseUrlEnv: values["database-url-env"] }),
    statuses,
    local: values.local === true,
    execute: values.execute === true,
  };
}

async function runReadingListCheck(argv: string[], deps: ReadingListCheckDeps): Promise<number> {
  const args = parseCheckArgs(argv);
  const { io } = deps;
  const selector = requireOperatorTenant(args.tenant);

  const raw = await deps.readFile(args.file);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new UsageError(`${args.file} must contain a JSON array of entries`);
  }
  const entries = parsed as ReadingListEntry[];
  const urls = entries
    .map((entry) => entry.url)
    .filter((url): url is string => typeof url === "string" && url.length > 0);

  return withOperatorCorpus(
    { bucket: args.bucket, tenant: selector, local: args.local, databaseUrlEnv: args.databaseUrlEnv },
    deps.env,
    deps.openSql,
    async ({ sql, tenantId, store }) => {
      // Only the exported URLs are looked up, not the whole corpus: an export
      // is a few hundred rows and the corpus is not.
      const owners = await store.ownersByUrls(urls);
      const items: CorpusItem[] = [...owners].map(([url, owner]) => ({ url, status: owner.status }));
      const corpus = buildCorpusUrlSet(items, { statuses: args.statuses });
      const { entries: annotated, summary } = annotateEntries(entries, corpus);
      // The corpus size, not the matched count. Only the exported URLs are
      // looked up, so a "how many did we match" number would equal `processed`
      // and tell the operator nothing; what they need to sanity-check is that
      // they are pointed at a tenant that has readings at all.
      const [{ total }] = await sql.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM readings WHERE tenant_id = $1",
        [tenantId],
      );

      if (args.execute) {
        await deps.writeFileAtomic(path.resolve(args.out), JSON.stringify(annotated, null, 2) + "\n");
      }

      io.stdout(
        JSON.stringify(
          {
            file: args.file,
            out: args.execute ? args.out : null,
            bucket: args.bucket,
            tenant: tenantId,
            match_statuses: args.statuses,
            tenant_readings: total,
            ...summary,
            executed: args.execute,
          },
          null,
          2,
        ),
      );
      if (!args.execute) io.stderr("Plan only — rerun with --execute to write the annotated list.");
      return 0;
    },
  );
}

export const readingListCheckCommand: CommandDefinition<ReadingListCheckDeps> = {
  group: "reading-list",
  name: "check",
  summary: "Mark which reading-list entries are already in the corpus",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- reading-list check --file <path> --tenant <usr_…> [options]

Resolves each entry's URL against the tenant's URL claims in PostgreSQL, then
stamps each entry of a reading-list JSON file with "processed": true|false.

Membership is exact-URL match against entries whose status is "ready" — the
same claim the worker writes when it takes ownership of a URL.

Plan by default (summary only); --execute writes the annotated JSON.

Options:
  --file <path>     Reading-list JSON: an array of { url, ... } entries (required).
  --out <path>      Where to write the annotated JSON. Default: in place (--file).
  --tenant <usr_…>  REQUIRED: the tenant whose corpus counts as "processed".
  --bucket <name>   Data bucket, which selects the database. Default:
                    READING_LITE_BUCKET env, then reading-lite (production).
${DATABASE_URL_ENV_FLAG_HELP}
  --status <s>      Status(es) that count as in-corpus. Repeatable.
                    Default: ready.
  --any-status      Shorthand for --status ready --status pending --status failed.
  --local           Read this checkout's local database.
  --execute         Write the annotated file.
  --help            Show this message.`,
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
    openSql: openOperatorSql,
    env: process.env,
  }),
  run: runReadingListCheck,
};
