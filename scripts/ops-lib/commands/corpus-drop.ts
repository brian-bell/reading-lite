// `ops corpus drop` — remove one or more readings from the corpus, by URL or
// by id.
//
// A drop is now one DELETE plus its bytes: the `readings` row goes, and
// `reading_urls`, `reading_revisions`, `reading_attempts`,
// `reading_relationships` and `reading_embeddings` cascade with it. There is
// no by-url pointer to reason about, no list index to rewrite, and no separate
// Vectorize delete — which is why `--vectorize` is gone.
//
// What does NOT cascade is the captured content in R2, and resolving it is the
// subtle part. `contentKeys` answers in three tiers — the current revision's
// keys, the latest capturing attempt's keys for a reading that was never
// published, and the legacy spelling under the stored `key_prefix` for an
// imported reading no attempt has touched — and every earlier revision and
// attempt contributes its own keys on top. All of them are read BEFORE the row
// is deleted, because afterwards there is nothing left to resolve them from.
//
// What is NOT deleted: a reading created before the storage migration may also
// still have its pre-migration `manifest.json`, `attempts/*.json`, `index/by-id`
// and `index/by-url` objects in the bucket. Nothing reads them any more — the
// row is the record — so they dangle nothing, but a drop does not sweep them
// and they will show as residue under the tenant root. Accepted, in the same
// spirit as the orphaned attempt JSONs the manifest-era deletion plan accepted;
// a bucket-wide sweep of the retired layout belongs to reading-lite-gh351, not
// to a per-reading delete that would have to guess at key spellings.
//
// Non-ready only by default. A ready reading owns an embedding and is the live
// owner of its URL, so ready deletion stays an explicit staging-cleanup path:
//   --allow-ready --bucket reading-lite-staging
//
// Plan-first: a mode-less run resolves targets and prints every row and object
// it would delete; --execute performs the deletes.

import { resolveDropTargets } from "../../corpus-lib/drop";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import type { ListItem } from "../../corpus-lib/types";
import {
  DATABASE_URL_ENV_FLAG_HELP,
  openOperatorSql,
  resolveOperatorDatabaseUrl,
  withOperatorSql,
  type OpenOperatorSql,
} from "../../pg-lib/operator-db";
import {
  contentKeysFor,
  deleteReading,
  listItems,
  operatorReadings,
  partitionKeysByPrefix,
  requireTenantRows,
} from "../../pg-lib/operator-corpus";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";
import { READINGS_PREFIX } from "../../../src/modules/stores/layout";

export interface CorpusDropR2 {
  deleteObject: (key: string, deps: R2Deps) => Promise<"deleted" | "absent" | "error">;
}

export interface CorpusDropDeps extends BaseDeps {
  r2: CorpusDropR2;
  openSql: OpenOperatorSql;
  env: Record<string, string | undefined>;
}

interface Opts {
  selectors: string[];
  bucket: string;
  tenant?: string;
  databaseUrlEnv?: string;
  remote: boolean;
  execute: boolean;
  allowReady: boolean;
}

function parseDropArgs(argv: string[]): Opts {
  const opts: Opts = {
    selectors: [],
    bucket: process.env.READING_LITE_BUCKET ?? "reading-lite",
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
  const { io, r2 } = deps;
  if (opts.selectors.length === 0) {
    throw new UsageError("no selectors given. Pass one or more reading ids or URLs.");
  }
  if (opts.allowReady && opts.bucket === "reading-lite") {
    throw new UsageError("refusing --allow-ready against production bucket reading-lite");
  }

  const selector = requireOperatorTenant(opts.tenant);
  const tenant = requireTenantRows(selector);
  const tenantId = String(tenant.tenantId);
  const r2Deps: R2Deps = { bucket: opts.bucket, keyRoot: selector.keyRoot, remote: opts.remote };
  const { url } = resolveOperatorDatabaseUrl({
    bucket: opts.bucket,
    ...(opts.databaseUrlEnv === undefined ? {} : { databaseUrlEnv: opts.databaseUrlEnv }),
    local: !opts.remote,
    env: deps.env,
  });

  return withOperatorSql(
    url,
    async (sql) => {
      const store = operatorReadings(sql, tenant);
      const items = (await listItems(store)) as ListItem[];

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
      io.stdout(`Tenant: ${tenantId}`);
      io.stdout(`Readings to drop: ${targets.length}`);
      io.stdout(`Mode: ${opts.execute ? "EXECUTE" : "PLAN"}\n`);
      for (const k of keptReady) io.stdout(`· keeping ready copy ${k.id}  ${k.url}`);
      if (keptReady.length) io.stdout("");

      let rowsDeleted = 0;
      let deleted = 0;
      let absent = 0;
      let errored = 0;
      // Objects that survived the row that referenced them. Counted apart from
      // refusals, which leave the reading whole.
      let residual = 0;

      for (const t of targets) {
        // Resolved before anything is deleted: the third tier is derived from
        // the reading's stored key_prefix, which the row delete takes with it.
        const resolved = await contentKeysFor(sql, store, tenantId, t.id);
        // The prefix/id guard above bounds the ROW. These keys come from the
        // database rather than from the layout, so they need the same bound
        // before anything is deleted with them.
        const { within: keys, foreign } = partitionKeysByPrefix(resolved, t.prefix);
        io.stdout(`• ${t.id}  ${t.url}`);
        if (foreign.length > 0) {
          io.stderr(
            `    ! refusing ${t.id}: ${foreign.length} stored content key(s) fall outside ` +
              `${t.prefix}/ — ${foreign.join(", ")}`,
          );
          errored += foreign.length;
          continue;
        }
        if (!opts.execute) {
          for (const key of keys) io.stdout(`    would delete  ${key}`);
          io.stdout(`    would delete row  ${t.id} (and its cascade)`);
          continue;
        }

        // Row first, objects second — the ordering purgeReading already holds
        // (src/reading-purge.ts) and the one the deletion rules state. The row
        // delete is one transaction, so the reading stops being listed,
        // readable, searchable and the owner of its URL at a single instant.
        // The reverse order is what must not happen here: bytes deleted, then
        // a dropped connection failing the DELETE, leaving a live reading
        // whose content 404s. This way the worst case is unreferenced residue,
        // which no API path can reach and which the tenant's account wipe
        // removes with its prefix.
        const removed = await deleteReading(sql, tenantId, t.id);
        rowsDeleted += removed;
        // deleteReading returns 0 when a sibling already removed the row. This
        // line is what the operator reads back as proof, so it must not claim
        // a delete that did not happen.
        io.stdout(
          removed > 0
            ? `    deleted   row ${t.id} (and its cascade)`
            : `    row ${t.id} was already gone`,
        );

        let failedHere = 0;
        for (const key of keys) {
          const res = await r2.deleteObject(key, r2Deps);
          if (res === "deleted") { deleted++; io.stdout(`    deleted   ${key}`); }
          else if (res === "absent") absent++;
          else { failedHere++; errored++; residual++; io.stderr(`    ! delete error  ${key}`); }
        }
        // Say it plainly: re-running will not retry these, because the id no
        // longer resolves to a row. The keys above are the operator's handle.
        if (failedHere > 0) {
          io.stderr(
            `    ! ${t.id} is gone from the database but ${failedHere} object(s) outlived it — ` +
              `unreachable residue. Re-running will not find the row; delete them by key.`,
          );
        }
      }

      if (!opts.execute) {
        io.stdout("\nPLAN — nothing changed. Re-run with --execute to apply.");
        return 0;
      }

      io.stdout(`\nrows deleted: ${rowsDeleted}`);
      if (errored > 0) {
        if (errored > residual) {
          io.stderr(`\n${errored - residual} reading(s) were refused and left whole. Re-run to retry.`);
        }
        if (residual > 0) {
          io.stderr(
            `\n${residual} object(s) outlived the row that referenced them. They are unreachable ` +
              `residue: re-running finds no row, and an account wipe removes them with the prefix.`,
          );
        }
        io.stderr(`objects deleted: ${deleted}, absent (skipped): ${absent}, errors: ${errored}`);
        return 1;
      }
      io.stdout(`Done. objects deleted: ${deleted}, absent (skipped): ${absent}`);
      return 0;
    },
    deps.openSql,
  );
}

export const corpusDropCommand: CommandDefinition<CorpusDropDeps> = {
  group: "corpus",
  name: "drop",
  summary: "Remove readings by URL or id (non-ready only by default)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus drop <selector...> [options]

A selector is either a reading id (rd_…) or a URL. URLs resolve to every
non-ready copy of that URL; ids resolve to that one reading.

Non-ready only by default: a ready reading owns an embedding and its URL
claim, so a named ready id is refused and a URL keeps its ready copy (dropping
only duplicates). Staging cleanup can opt into ready deletion with
--allow-ready, which refuses the production bucket name.

Deleting the row cascades to the URL claim, revisions, attempts, the reading's
own outbound relationships, and the embedding. Its captured content in R2 is
deleted alongside it, resolved from the reading itself rather than guessed from
the key layout.

Inbound citations do NOT cascade: reading_relationships has a foreign key on
the source only, so other readings keep connection and tension rows naming this
one as their target. Clean those up with:
  npm run ops -- corpus purge-connections --tenant <usr_…> --id <dropped-id>

Plan by default — prints every row and object it would delete. Add --execute
to perform the deletes.

Options:
  --bucket <name>     Data bucket, which selects the database. Default:
                      READING_LITE_BUCKET / reading-lite.
  --tenant <selector>  REQUIRED: the tenant id (usr_…) whose corpus to act on.
${DATABASE_URL_ENV_FLAG_HELP}
  --allow-ready       Permit dropping ready readings (staging cleanup only).
  --local             Use this checkout's local database and R2 cache.
  --execute           Perform the deletes.
  --help              Show this message.`,
  defaultDeps: (io: CommandIo): CorpusDropDeps => ({
    io,
    r2: {
      deleteObject: async (key, d) => (await import("../../corpus-lib/wrangler-r2")).deleteObject(key, d),
    },
    openSql: openOperatorSql,
    env: process.env,
  }),
  run: runCorpusDrop,
};
