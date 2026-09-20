// `ops reading-list check` — mark which entries of a reading-list JSON export
// are already in the corpus, stamping each with "processed": true|false.
//
// Membership is now a query of the tenant's readings (ADR 0005). This used to
// read index/list.json through wrangler, which is why the command gained a
// required --tenant: the old list index was one document per key root, and a
// query has to be told whose corpus it is asking about.
//
// Getting this wrong is not a quiet failure. An unported check would find no
// corpus at all, mark every entry unprocessed, and `reading-list process`
// would resubmit the whole library.
//
// Plan-first: reading the corpus is fine in plan mode, but the annotated list
// is a durable local write — a mode-less run prints the summary only;
// --execute writes the annotated file.

import path from "node:path";
import { parseArgs } from "node:util";
import {
  annotateEntries,
  buildCorpusUrlSet,
  type ReadingListEntry,
} from "../../check-corpus-lib/corpus";
import {
  DATABASE_URL_ENV_HELP,
  DATABASE_URL_ENV_OPTION,
  operatorDatabaseUrl,
  withOperatorSql,
} from "../../pg-lib/operator-db";
import { assertPgTenant, operatorCorpusFor, type CorpusInventory } from "../../pg-lib/operator-corpus";
import type { OperatorTenant } from "../../corpus-lib/tenant";
import { requireOperatorTenant } from "../tenant-flag";
import { operatorTenantSelector } from "../../corpus-lib/tenant";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface ReadingListCheckDeps extends BaseDeps {
  readFile: (path: string) => Promise<string>;
  // Atomic write (tmp + rename), including mkdir of the parent.
  writeFileAtomic: (path: string, body: string) => Promise<void>;
  corpus: <T>(
    databaseUrlEnv: string,
    tenant: OperatorTenant,
    run: (corpus: Pick<CorpusInventory, "listItems">) => Promise<T>,
  ) => Promise<T>;
}

interface Args {
  file: string;
  out: string;
  tenant?: string;
  databaseUrlEnv: string;
  statuses: string[];
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
        tenant: { type: "string" },
        "database-url-env": DATABASE_URL_ENV_OPTION,
        status: { type: "string", multiple: true },
        "any-status": { type: "boolean", default: false },
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
    ...(values.tenant === undefined ? {} : { tenant: values.tenant }),
    databaseUrlEnv: values["database-url-env"]!,
    statuses,
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

  const tenant = requireOperatorTenant(args.tenant);
  // Before any connection: a 'global' selector must say so, not report a
  // missing connection string.
  assertPgTenant(tenant);
  const corpus = await deps.corpus(args.databaseUrlEnv, tenant, async (view) =>
    buildCorpusUrlSet(await view.listItems(), { statuses: args.statuses }),
  );
  const { entries: annotated, summary } = annotateEntries(entries, corpus);

  if (args.execute) {
    await deps.writeFileAtomic(path.resolve(args.out), JSON.stringify(annotated, null, 2) + "\n");
  }

  io.stdout(
    JSON.stringify(
      {
        file: args.file,
        out: args.execute ? args.out : null,
        tenant: operatorTenantSelector(tenant),
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

Queries the tenant's readings, then stamps each entry of a reading-list JSON
file with "processed": true|false depending on whether its URL is already in
the corpus.

Membership is exact-URL match against entries whose status is "ready" — the
same URL the worker hashes for its per-tenant ownership row.

Plan by default (summary only); --execute writes the annotated JSON.

Options:
  --file <path>     Reading-list JSON: an array of { url, ... } entries (required).
  --out <path>      Where to write the annotated JSON. Default: in place (--file).
  --tenant <selector>  REQUIRED: tenant id (usr_…). 'global' has no PostgreSQL corpus.
  ${DATABASE_URL_ENV_HELP}
  --status <s>      Status(es) that count as in-corpus. Repeatable.
                    Default: ready.
  --any-status      Shorthand for --status ready --status pending --status failed.
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
    corpus: (databaseUrlEnv, tenant, run) =>
      withOperatorSql(operatorDatabaseUrl(databaseUrlEnv), (sql) => run(operatorCorpusFor(sql, tenant))),
  }),
  run: runReadingListCheck,
};
