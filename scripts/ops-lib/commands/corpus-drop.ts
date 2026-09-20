// `ops corpus drop` — remove one or more readings from the corpus, by URL or
// by id. Resolve each selector against the tenant's readings, delete the
// content each target captured in R2, then delete the row.
//
// Deleting the row is one statement where this used to be four: URL
// ownership, revisions, relationships, attempts and the embedding cascade, so
// there is no pointer to unlink, no Vectorize index to keep in step, and no
// index/list.json to rewrite.
//
// Objects first, row last, deliberately. The row is what makes a reading
// findable: deleting it first would strand its bytes with nothing left to name
// them, and a re-run could not retry. See shouldDeleteRow.
//
// Non-ready only by default. Nothing dangles now, but a ready reading is a
// live library entry, so dropping one stays an explicit staging path:
//   --allow-ready --bucket reading-lite-staging
//
// Plan-first: a mode-less run resolves targets and prints every object and row
// it would delete; --execute performs the deletes.

import { resolveDropTargets, shouldDeleteRow } from "../../corpus-lib/drop";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import {
  DATABASE_URL_ENV_HELP,
  operatorDatabaseUrl,
  withOperatorSql,
} from "../../pg-lib/operator-db";
import { operatorCorpusFor, type CorpusDropView } from "../../pg-lib/operator-corpus";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";
import type { OperatorTenant } from "../../corpus-lib/tenant";
import { READINGS_PREFIX } from "../../../src/modules/stores/layout";

export interface CorpusDropR2 {
  deleteObject: (key: string, deps: R2Deps) => Promise<"deleted" | "absent" | "error">;
}

export interface CorpusDropDeps extends BaseDeps {
  corpus: <T>(
    databaseUrlEnv: string,
    tenant: OperatorTenant,
    run: (corpus: CorpusDropView) => Promise<T>,
  ) => Promise<T>;
  r2: CorpusDropR2;
}

interface Opts {
  selectors: string[];
  bucket: string;
  tenant?: string;
  databaseUrlEnv: string;
  remote: boolean;
  execute: boolean;
  allowReady: boolean;
}

function parseDropArgs(argv: string[]): Opts {
  const opts: Opts = {
    selectors: [],
    bucket: process.env.READING_LITE_BUCKET ?? "reading-lite",
    databaseUrlEnv: "DATABASE_URL",
    remote: true,
    execute: false,
    allowReady: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--execute") opts.execute = true;
    else if (a === "--allow-ready") opts.allowReady = true;
    else if (a === "--local") opts.remote = false;
    else if (a === "--bucket") opts.bucket = requireValue(argv[++i], a);
    else if (a === "--tenant") opts.tenant = requireValue(argv[++i], a);
    else if (a === "--database-url-env") opts.databaseUrlEnv = requireValue(argv[++i], a);
    else if (a.startsWith("--")) throw new UsageError(`unknown flag: ${a}`);
    else opts.selectors.push(a);
  }
  return opts;
}

function requireValue(v: string | undefined, flag: string): string {
  if (v === undefined) throw new UsageError(`${flag} requires a value`);
  return v;
}

async function runCorpusDrop(argv: string[], deps: CorpusDropDeps): Promise<number> {
  const opts = parseDropArgs(argv);
  if (opts.selectors.length === 0) {
    throw new UsageError("no selectors given. Pass one or more reading ids or URLs.");
  }
  if (opts.allowReady && opts.bucket === "reading-lite") {
    throw new UsageError("refusing --allow-ready against production bucket reading-lite");
  }

  const tenant = requireOperatorTenant(opts.tenant);
  const r2Deps: R2Deps = { bucket: opts.bucket, keyRoot: tenant.keyRoot, remote: opts.remote };
  return deps.corpus(opts.databaseUrlEnv, tenant, (corpus) => dropResolved(opts, r2Deps, corpus, deps));
}

async function dropResolved(
  opts: Opts,
  r2Deps: R2Deps,
  corpus: CorpusDropView,
  deps: CorpusDropDeps,
): Promise<number> {
  const { io, r2 } = deps;
  const items = await corpus.listItems();

  const resolved = resolveDropTargets(items, opts.selectors, { allowReady: opts.allowReady });
  if (!resolved.ok) {
    for (const e of resolved.errors) io.stderr(`✗ ${e}`);
    return 1;
  }
  const { targets, keptReady } = resolved;

  // Safety: every prefix must be id-scoped under readings/. Never touch a
  // prefix that doesn't carry its own reading id.
  for (const t of targets) {
    if (
      !t.id || !t.prefix || typeof t.url !== "string" ||
      !t.prefix.startsWith(READINGS_PREFIX) || !t.prefix.endsWith(t.id)
    ) {
      io.stderr(`refusing to proceed: target failed prefix/id guard: ${JSON.stringify(t)}`);
      return 1;
    }
  }

  io.stdout(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
  io.stdout(`Readings to drop: ${targets.length}`);
  io.stdout(`Mode: ${opts.execute ? "EXECUTE" : "PLAN"}\n`);
  for (const k of keptReady) io.stdout(`· keeping ready copy ${k.id}  ${k.url}`);
  if (keptReady.length) io.stdout("");

  let deleted = 0;
  let absent = 0;
  let errored = 0;
  let rowsDropped = 0;
  let rowsHeld = 0;

  for (const t of targets) {
    const keys = await corpus.contentKeysForDrop(t.id);
    io.stdout(`• ${t.id}  ${t.url}`);
    let failedHere = 0;
    for (const key of keys) {
      if (!opts.execute) {
        io.stdout(`    would delete  ${key}`);
        continue;
      }
      const res = await r2.deleteObject(key, r2Deps);
      if (res === "deleted") { deleted++; io.stdout(`    deleted   ${key}`); }
      else if (res === "absent") absent++;
      else { errored++; failedHere++; io.stderr(`    ! delete error  ${key}`); }
    }

    if (!opts.execute) {
      io.stdout(`    would delete  row ${t.id} (cascades url, revisions, relationships, attempts, embedding)`);
      continue;
    }
    // Per reading, not per run: one reading's failed object delete must not
    // hold back another reading's row, but it must hold back its own.
    if (!shouldDeleteRow(failedHere)) {
      rowsHeld++;
      io.stderr(`    ! keeping row ${t.id}: ${failedHere} object delete(s) failed, so the drop stays re-runnable`);
      continue;
    }
    if (await corpus.deleteReading(t.id)) {
      rowsDropped++;
      io.stdout(`    deleted   row ${t.id}`);
    } else {
      // Someone else dropped it between the read and here. The objects are
      // gone either way, so this is a successful no-op, not a failure.
      io.stdout(`    already gone  row ${t.id}`);
    }
  }

  if (!opts.execute) {
    io.stdout(`\n${targets.length} row(s) would be removed from the library.`);
    io.stdout("\nPLAN — nothing changed. Re-run with --execute to apply.");
    return 0;
  }

  io.stdout(`\nrows dropped: ${rowsDropped}, objects deleted: ${deleted}, absent (skipped): ${absent}`);
  if (errored > 0) {
    io.stderr(
      `${errored} object delete(s) failed and ${rowsHeld} reading(s) kept their row so the drop stays ` +
      `visible and re-runnable. Re-run to retry.`,
    );
    return 1;
  }
  return 0;
}

export const corpusDropCommand: CommandDefinition<CorpusDropDeps> = {
  group: "corpus",
  name: "drop",
  summary: "Remove readings by URL or id (non-ready only by default)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus drop <selector...> [options]

A selector is either a reading id (rd_…) or a URL. URLs resolve to every
non-ready copy of that URL in the tenant's corpus; ids resolve to that one
reading.

Non-ready only by default: a ready reading is a live library entry, so a named
ready id is refused and a URL keeps its ready copy (dropping only duplicates).
Staging cleanup can opt into ready deletion with --allow-ready, which refuses
the production bucket name. It no longer needs a Vectorize index: the
embedding is a row and goes with its reading.

Plan by default — prints every object and row it would delete. Add --execute
to perform the deletes.

Each reading's captured content is deleted before its row, so a failed object
delete keeps that reading's row and the drop stays re-runnable. One reading's
failure does not hold back another's.

Options:
  --tenant <selector>  REQUIRED: tenant id (usr_…). 'global' has no PostgreSQL corpus.
  ${DATABASE_URL_ENV_HELP}
  --bucket <name>     R2 bucket holding captured content.
                      Default: READING_LITE_BUCKET / reading-lite.
  --allow-ready       Permit dropping ready readings (staging cleanup only).
  --local             Use the local miniflare bucket.
  --execute           Perform the deletes.
  --help              Show this message.`,
  defaultDeps: (io: CommandIo): CorpusDropDeps => ({
    io,
    corpus: (databaseUrlEnv, tenant, run) =>
      withOperatorSql(operatorDatabaseUrl(databaseUrlEnv), (sql) => run(operatorCorpusFor(sql, tenant))),
    r2: {
      deleteObject: async (key, d) => (await import("../../corpus-lib/wrangler-r2")).deleteObject(key, d),
    },
  }),
  run: runCorpusDrop,
};
