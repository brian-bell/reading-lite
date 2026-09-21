// `ops corpus sweep` — find readings that are the same resource under
// different URL spellings, keep the best copy, and drop the rest. See
// scripts/corpus-lib/sweep.ts for the ranking and safety rationale.
//
// The URL claim is unique per tenant, which catches a repeat of the same
// spelling; it cannot catch two spellings of one resource, so this command
// survives the move to PostgreSQL (reading-lite-gh347.4.7). Groups are built
// over `readings.url`, and a drop is the row plus its captured content — the
// embedding cascades, so there is no Vectorize probe and no `--vectorize`.
//
// Plan-first: a mode-less run reports each group, the keeper and why, and
// every row and object it would delete; --execute applies the sweep.

import {
  invalidatedByDrop,
  planExplicitPair,
  planSweep,
  type SweepItem,
} from "../../corpus-lib/sweep";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";
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
  hasEmbedding,
  listItems,
  operatorReadings,
  partitionKeysByPrefix,
  requireTenantRows,
} from "../../pg-lib/operator-corpus";
import type { PgReadingStore } from "../../../src/modules/stores/postgres/reading-store";
import { READINGS_PREFIX } from "../../../src/modules/stores/layout";

export interface CorpusSweepR2 {
  deleteObject: (key: string, deps: R2Deps) => Promise<"deleted" | "absent" | "error">;
}

export interface CorpusSweepDeps extends BaseDeps {
  r2: CorpusSweepR2;
  openSql: OpenOperatorSql;
  env: Record<string, string | undefined>;
}

interface Opts {
  tenant?: string;
  databaseUrlEnv?: string;
  only: string[];
  keep: string[];
  drop?: string;
  bucket: string;
  remote: boolean;
  execute: boolean;
}

function parseSweepArgs(argv: string[]): Opts {
  const opts: Opts = {
    only: [],
    keep: [],
    bucket: process.env.READING_LITE_BUCKET ?? "reading-lite",
    remote: true,
    execute: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--execute") opts.execute = true;
    else if (a === "--local") opts.remote = false;
    else if (a === "--bucket") opts.bucket = requireValue(argv[++i], a);
    else if (a === "--tenant") opts.tenant = requireValue(argv[++i], a);
    else if (a === "--database-url-env") opts.databaseUrlEnv = requireValue(argv[++i], a);
    else if (a === "--keep") opts.keep.push(requireValue(argv[++i], a));
    else if (a === "--drop") opts.drop = requireValue(argv[++i], a);
    else if (a.startsWith("--")) throw new UsageError(`unknown flag: ${a}`);
    else opts.only.push(a);
  }
  return opts;
}

function requireValue(v: string | undefined, flag: string): string {
  if (v === undefined) throw new UsageError(`${flag} requires a value`);
  return v;
}

async function runCorpusSweep(argv: string[], deps: CorpusSweepDeps): Promise<number> {
  const opts = parseSweepArgs(argv);
  const { io, r2 } = deps;
  const selector = requireOperatorTenant(opts.tenant);
  const tenant = requireTenantRows(selector);
  const tenantId = String(tenant.tenantId);
  const r2Deps: R2Deps = { bucket: opts.bucket, keyRoot: selector.keyRoot, remote: opts.remote };

  // --drop is the operator-asserted pair mode: two readings that carry the same
  // material but are genuinely different resources, so no canonicalization rule
  // pairs them. It takes exactly one --keep and no positional selectors, so the
  // assertion stays unambiguous.
  if (opts.drop !== undefined && (opts.keep.length !== 1 || opts.only.length > 0)) {
    throw new UsageError("--drop takes exactly one --keep <rd_ID> and no other selectors");
  }

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
      const items = (await listItems(store)) as SweepItem[];

      const plan = opts.drop !== undefined
        ? planExplicitPair(items, { drop: opts.drop, keep: opts.keep[0]! })
        : planSweep(items, { only: opts.only, keep: opts.keep });

      if (plan.errors.length > 0) {
        for (const e of plan.errors) io.stderr(`✗ ${e}`);
        return 1;
      }

      io.stdout(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
      io.stdout(`Tenant: ${tenantId}`);
      io.stdout(`Corpus: ${items.length} readings`);
      io.stdout(`Duplicate groups: ${plan.groups.length}`);
      io.stdout(`Mode: ${opts.execute ? "EXECUTE" : "PLAN"}\n`);

      if (plan.groups.length === 0) {
        io.stdout("No duplicate groups found — nothing to sweep.");
        return 0;
      }

      const targets = plan.groups.flatMap((g) => g.drops);

      // Safety: every prefix must be id-scoped under readings/. Never touch a
      // prefix that doesn't carry its own reading id.
      for (const t of targets) {
        if (
          !t.id || !t.key_prefix || typeof t.url !== "string" ||
          !t.key_prefix.startsWith(READINGS_PREFIX) || !t.key_prefix.endsWith(t.id)
        ) {
          io.stderr(`refusing to proceed: target failed prefix/id guard: ${JSON.stringify(t)}`);
          return 1;
        }
      }

      // The invariant that lets sweep delete ready readings at all, on
      // production, without an --allow-ready gate: each group keeps exactly one
      // survivor, and that survivor is never in the drop set. This is the
      // equivalent of drop's production refusal — a sweep is only ever
      // proposed alongside a keeper, so it can never empty a group.
      const dropIds = new Set(targets.map((t) => t.id));
      for (const g of plan.groups) {
        if (
          dropIds.has(g.keeper.id) ||
          g.drops.length !== g.items.length - 1 ||
          g.items.length < 2
        ) {
          io.stderr(`refusing to proceed: group ${g.key} would not keep exactly one survivor`);
          return 1;
        }
      }

      for (const g of plan.groups) {
        io.stdout(`▸ ${g.key}`);
        io.stdout(`    keep  ${g.keeper.id}  [${g.keeper.status}]  ${g.keeper.url}  (${g.reason})`);
        for (const d of g.drops) io.stdout(`    drop  ${d.id}  [${d.status}]  ${d.url}`);
        io.stdout("");
      }

      let rowsDeleted = 0;
      let deleted = 0;
      let absent = 0;
      let errored = 0;
      // Drops the corpus actually held an embedding for, so the post-sweep
      // warning can be exact instead of guessing from status.
      // created_at rides along so a snapshot computed before a copy existed can
      // rule that copy out.
      const vectoredDrops: { id: string; created_at?: string }[] = [];

      for (const t of targets) {
        const resolved = await contentKeysFor(sql, store, tenantId, t.id);
        // Same bound as corpus drop, and it matters more here: sweep deletes
        // ready readings on production without an --allow-ready gate, so the
        // only thing standing between a corrupt stored key and an arbitrary
        // delete is this check.
        const { within: keys, foreign } = partitionKeysByPrefix(resolved, t.key_prefix);
        io.stdout(`• dropping ${t.id}  ${t.url}`);
        if (foreign.length > 0) {
          io.stderr(
            `    ! refusing ${t.id}: ${foreign.length} stored content key(s) fall outside ` +
              `${t.key_prefix}/ — ${foreign.join(", ")}`,
          );
          errored += foreign.length;
          continue;
        }
        // Asked, not inferred from status. A ready reading normally has an
        // embedding, but nothing in the schema requires one, and the code this
        // replaced probed the index for exactly that reason ("every
        // status-based rule was wrong in some direction").
        const embedded = await hasEmbedding(sql, tenantId, t.id);
        const vectored = { id: t.id, ...(t.created_at === undefined ? {} : { created_at: t.created_at }) };
        if (!opts.execute) {
          if (embedded) vectoredDrops.push(vectored);
          for (const key of keys) io.stdout(`    would delete  ${key}`);
          io.stdout(`    would delete row  ${t.id} (and its cascade, embedding included)`);
          continue;
        }

        // Bytes first, row last — see corpus-drop: a failed object delete must
        // leave the reading visible rather than strand its content.
        let failedHere = 0;
        for (const key of keys) {
          const res = await r2.deleteObject(key, r2Deps);
          if (res === "deleted") { deleted++; io.stdout(`    deleted   ${key}`); }
          else if (res === "absent") absent++;
          else { failedHere++; errored++; io.stderr(`    ! delete error  ${key}`); }
        }
        if (failedHere > 0) {
          io.stderr(`    ! keeping row ${t.id} so this sweep stays visible and re-runnable`);
          continue;
        }
        const removed = await deleteReading(sql, tenantId, t.id);
        rowsDeleted += removed;
        // Only a row that actually went takes its embedding with it, so the
        // invalidated-keeper report must not claim a neighbour lost a vector
        // that is still there.
        if (embedded && removed > 0) vectoredDrops.push(vectored);
        io.stdout(
          removed > 0
            ? `    deleted   row ${t.id} (and its cascade, embedding included)`
            : `    row ${t.id} was already gone`,
        );
      }

      if (!opts.execute) {
        io.stdout("\nPLAN — nothing changed. Re-run with --execute to apply.");
        return 0;
      }

      io.stdout(`\nrows deleted: ${rowsDeleted}`);
      if (errored > 0) {
        io.stderr(
          `\n${errored} object delete(s) failed — their readings were left in place so they ` +
          `stay visible. Re-run to retry.`,
        );
        io.stderr(`deleted: ${deleted}, absent (skipped): ${absent}, errors: ${errored}`);
        return 1;
      }
      io.stdout(`Done. objects deleted: ${deleted}, absent (skipped): ${absent}`);

      // The sweep has already deleted rows and objects by now, so the report is
      // strictly informational: never let it fail the command.
      try {
        await reportInvalidatedKeepers(io, store, plan.groups, dropIds, vectoredDrops);
      } catch (e) {
        io.stderr(
          `\ncould not report invalidated keepers: ${e instanceof Error ? e.message : String(e)}\n` +
          `The sweep itself succeeded; re-read the keepers if you need that report.`,
        );
      }
      return 0;
    },
    deps.openSql,
  );
}

// A sweep changes the corpus around each keeper, so the keeper's frozen
// novelty_verdict and similarity snapshot can be wrong the moment it finishes.
// Nothing recomputes them, so at minimum say so.
async function reportInvalidatedKeepers(
  io: CommandIo,
  store: PgReadingStore,
  groups: { keeper: { id: string; key_prefix: string; url: string } }[],
  droppedIds: Set<string>,
  vectoredDrops: { id: string; created_at?: string }[],
): Promise<void> {
  const flagged = [];
  for (const g of groups) {
    const loaded = await store.loadReadingById(g.keeper.id).catch(() => null);
    const v = invalidatedByDrop(g.keeper.id, loaded?.manifest ?? null, droppedIds, vectoredDrops);
    if (v.invalidated) flagged.push({ ...v, url: g.keeper.url });
  }
  if (flagged.length === 0) return;

  io.stdout(`\n${flagged.length} keeper(s) now carry a stale relationship claim:`);
  for (const f of flagged) {
    const bits = [];
    if (f.verdict) bits.push(`verdict "${f.verdict}"`);
    if (f.staleConnections.length > 0) bits.push(`cites dropped ${f.staleConnections.join(", ")}`);
    if (f.staleSimilarity) bits.push("similarity measured against a dropped neighbour");
    io.stdout(`  ${f.id}  ${bits.join("; ")}`);
    io.stdout(`      ${f.url}`);
  }
  // `corpus backfill-similarity` used to be the cheap repair here. It was
  // retired in reading-lite-gh347.4.6 — it backfilled a field the importer now
  // carries over — and nothing replaced it, so say what is true rather than
  // naming a command that no longer exists.
  io.stdout(
    `\nNothing recomputes these automatically. The measured similarity refreshes on the\n` +
    `next relationship refresh pass; the novelty_verdict only refreshes on a reprocess,\n` +
    `which DOES re-roll title and tags -- so weigh that before reprocessing purely to\n` +
    `fix a label.`,
  );
}

export const corpusSweepCommand: CommandDefinition<CorpusSweepDeps> = {
  group: "corpus",
  name: "sweep",
  summary: "Reconcile duplicate readings of the same resource across URL spellings",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus sweep [selector...] [options]

With no selector it scans the whole corpus and reports every duplicate group.
A selector (a reading id, or any URL spelling of the resource) narrows the
sweep to the groups it touches — the safe way to fix one known duplicate.

Keeper ranking, best first: ready beats non-ready, then the richer summary,
then the newer copy. Override per group with --keep <rd_ID>.

For two readings that carry the same material but are genuinely different
resources (a video and the tweet arguing the same thing), no URL rule can pair
them -- assert it with --drop <rd_ID> --keep <rd_ID>. The keeper must be ready.

Unlike corpus drop, this WILL drop a ready reading on production, because a
drop is only ever proposed alongside a surviving keeper, and the dropped
reading's embedding is deleted with its row.

Inbound citations do NOT cascade: other readings keep connection and tension
rows naming a dropped copy as their target. After a sweep, clean each dropped
id up with:
  npm run ops -- corpus purge-connections --tenant <usr_…> --id <dropped-id>

Plan by default — prints each group, the keeper and why, and every row and
object it would delete. Add --execute to apply.

Options:
  --keep <rd_ID>      Force the keeper for the group containing this id.
  --drop <rd_ID>      Operator-asserted pair mode (with exactly one --keep).
  --bucket <name>     Data bucket, which selects the database. Default:
                      READING_LITE_BUCKET / reading-lite.
  --tenant <selector>  REQUIRED: the tenant id (usr_…) whose corpus to sweep.
${DATABASE_URL_ENV_FLAG_HELP}
  --local             Use this checkout's local database and R2 cache.
  --execute           Apply the sweep.
  --help              Show this message.`,
  defaultDeps: (io: CommandIo): CorpusSweepDeps => ({
    io,
    r2: {
      deleteObject: async (key, d) => (await import("../../corpus-lib/wrangler-r2")).deleteObject(key, d),
    },
    openSql: openOperatorSql,
    env: process.env,
  }),
  run: runCorpusSweep,
};
