// `ops corpus sweep` — find readings that are the same resource under
// different URL spellings, keep the best copy, and drop the rest. See
// scripts/corpus-lib/sweep.ts for the ranking and safety rationale.
// Plan-first: a mode-less run reports each group, the keeper and why, and
// every object it would delete; --execute applies the sweep.
//
// The sweep lost its hardest problem when embeddings became rows. It used to
// probe Vectorize per drop, delete the vector first, and skip the reading's
// objects if that delete failed, because a vector outliving its reading was
// the one inconsistency it could create. Now the embedding is deleted by the
// same cascade as the reading, in the same transaction, and cannot be left
// behind. What remains is R2 content, deleted before the row for the same
// reason as `corpus drop`.

import {
  invalidatedByDrop,
  planExplicitPair,
  planSweep,
  type SweepItem,
} from "../../corpus-lib/sweep";
import { shouldDeleteRow } from "../../corpus-lib/drop";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import {
  assertBucketAndDatabaseAgree,
  DATABASE_URL_ENV_DEFAULT,
  DATABASE_URL_ENV_HELP,
  operatorDatabaseUrl,
  requireLocalDatabase,
  requireNamedDatabase,
  withOperatorSql,
} from "../../pg-lib/operator-db";
import { CONTROL_PLANE_BY_BUCKET } from "../../account-lib/control-plane";
import { assertPgTenant, operatorCorpusFor, type CorpusDropView, type CorpusLookup } from "../../pg-lib/operator-corpus";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";
import type { OperatorTenant } from "../../corpus-lib/tenant";
import { READINGS_PREFIX } from "../../../src/modules/stores/layout";

export type CorpusSweepView = CorpusDropView & Pick<CorpusLookup, "manifest">;

export interface CorpusSweepR2 {
  deleteObject: (key: string, deps: R2Deps) => Promise<"deleted" | "absent" | "error">;
}

export interface CorpusSweepDeps extends BaseDeps {
  corpus: <T>(
    databaseUrlEnv: string,
    tenant: OperatorTenant,
    run: (corpus: CorpusSweepView) => Promise<T>,
    opts?: { requireLocal?: boolean },
  ) => Promise<T>;
  r2: CorpusSweepR2;
}

interface Opts {
  tenant?: string;
  only: string[];
  keep: string[];
  drop?: string;
  bucket: string;
  databaseUrlEnv: string;
  remote: boolean;
  execute: boolean;
}

function parseSweepArgs(argv: string[]): Opts {
  const opts: Opts = {
    only: [],
    keep: [],
    bucket: process.env.READING_LITE_BUCKET ?? "reading-lite",
    databaseUrlEnv: DATABASE_URL_ENV_DEFAULT,
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
  const tenant = requireOperatorTenant(opts.tenant);
  // Before any connection: a 'global' selector must say so, not report a
  // missing connection string.
  assertPgTenant(tenant);
  const r2Deps: R2Deps = { bucket: opts.bucket, keyRoot: tenant.keyRoot, remote: opts.remote };

  // --drop is the operator-asserted pair mode: two readings that carry the same
  // material but are genuinely different resources, so no canonicalization rule
  // pairs them. It takes exactly one --keep and no positional selectors, so the
  // assertion stays unambiguous.
  if (opts.drop !== undefined && (opts.keep.length !== 1 || opts.only.length > 0)) {
    throw new UsageError("--drop takes exactly one --keep <rd_ID> and no other selectors");
  }
  // Sweep drops ready readings by design, and on production by design, which
  // makes it strictly more destructive than `corpus drop --allow-ready`. It
  // gets at least the same guards: the bucket and the database must agree, and
  // because that check is inert on an unmapped variable — the DATABASE_URL
  // default is unmapped — an execute has to name the database it means.
  assertBucketAndDatabaseAgree(opts.bucket, opts.databaseUrlEnv, CONTROL_PLANE_BY_BUCKET);
  if (opts.execute) {
    requireNamedDatabase(opts.databaseUrlEnv, CONTROL_PLANE_BY_BUCKET, {
      local: !opts.remote,
      because: "corpus sweep deletes ready readings",
    });
  }

  // --local names the miniflare bucket; the row deletes go wherever
  // --database-url-env points, so the two must agree before anything is
  // deleted. See requireLocalDatabase.
  return deps.corpus(
    opts.databaseUrlEnv,
    tenant,
    (corpus) => sweepResolved(opts, r2Deps, corpus, deps),
    { requireLocal: !opts.remote },
  );
}

async function sweepResolved(
  opts: Opts,
  r2Deps: R2Deps,
  corpus: CorpusSweepView,
  deps: CorpusSweepDeps,
): Promise<number> {
  const { io, r2 } = deps;
  // No cast: ListItem must structurally satisfy SweepItem, so dropping a
  // field the ranking reads is a type error rather than a silent behaviour
  // change (it was one, and cost the "richest summary" tiebreaker).
  const items: SweepItem[] = await corpus.listItems();

  const plan = opts.drop !== undefined
    ? planExplicitPair(items, { drop: opts.drop, keep: opts.keep[0]! })
    : planSweep(items, { only: opts.only, keep: opts.keep });

  if (plan.errors.length > 0) {
    for (const e of plan.errors) io.stderr(`✗ ${e}`);
    return 1;
  }

  io.stdout(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
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

  // The invariant that lets sweep touch ready readings at all: each group keeps
  // exactly one survivor, and that survivor is never in the drop set.
  const dropIds = new Set(targets.map((t) => t.id));
  for (const g of plan.groups) {
    if (dropIds.has(g.keeper.id) || g.drops.length !== g.items.length - 1) {
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

  let deleted = 0;
  let absent = 0;
  let errored = 0;
  let rowsDropped = 0;
  // Drops that carried an embedding, so the post-sweep warning can be exact.
  // Status is now a reliable answer to that question: publication writes the
  // reading and its embedding in one transaction, and the embedding cascades
  // with the reading, so a ready reading has one and a non-ready reading does
  // not. It took a Vectorize probe to know this before, because the two stores
  // could disagree. created_at rides along so a snapshot computed before a
  // copy existed can rule that copy out.
  //
  // Only drops that actually went. A target whose object deletes failed keeps
  // its row, so warning that a keeper's snapshot is stale because of it would
  // point the operator at a drop the same run just told them was held back.
  const vectoredDrops: { id: string; created_at?: string }[] = [];
  // Likewise: the ids the invalidation diff should treat as gone.
  const droppedIds = new Set<string>();

  for (const t of targets) {
    const keys = await corpus.contentKeysForDrop(t.id);
    io.stdout(`• dropping ${t.id}  ${t.url}`);

    let failedHere = 0;
    for (const key of keys) {
      if (!opts.execute) {
        io.stdout(`    would delete  ${key}`);
        continue;
      }
      const res = await r2.deleteObject(key, r2Deps);
      if (res === "deleted") {
        deleted++;
        io.stdout(`    deleted   ${key}`);
      } else if (res === "absent") absent++;
      else {
        errored++;
        failedHere++;
        io.stderr(`    ! delete error  ${key}`);
      }
    }

    if (!opts.execute) {
      io.stdout(`    would delete  row ${t.id} (cascades url, revisions, relationships, embedding)`);
      continue;
    }
    if (!shouldDeleteRow(failedHere)) {
      io.stderr(`    ! keeping row ${t.id}: ${failedHere} object delete(s) failed, so the sweep stays re-runnable`);
      continue;
    }
    if (await corpus.deleteReading(t.id)) {
      rowsDropped++;
      io.stdout(`    deleted   row ${t.id}`);
    } else {
      io.stdout(`    already gone  row ${t.id}`);
    }
    droppedIds.add(t.id);
    if (t.status === "ready") vectoredDrops.push({ id: t.id, created_at: t.created_at });
  }

  if (!opts.execute) {
    io.stdout(`\n${targets.length} row(s) would be removed from the library.`);
    io.stdout("\nPLAN — nothing changed. Re-run with --execute to apply.");
    return 0;
  }

  io.stdout(`\nrows dropped: ${rowsDropped}, objects deleted: ${deleted}, absent (skipped): ${absent}`);
  if (errored > 0) {
    io.stderr(
      `${errored} object delete(s) failed — the affected readings kept their rows so the sweep ` +
      `stays visible and re-runnable. Re-run to retry.`,
    );
    return 1;
  }

  // The sweep has already deleted objects and rewritten the index by now, so
  // the report is strictly informational: never let it fail the command.
  try {
    await reportInvalidatedKeepers(io, corpus, plan.groups, droppedIds, vectoredDrops);
  } catch (e) {
    io.stderr(
      `\ncould not report invalidated keepers: ${e instanceof Error ? e.message : String(e)}\n` +
      `The sweep itself succeeded; re-read the keepers' manifests if you need that report.`,
    );
  }
  return 0;
}

// A sweep changes the corpus around each keeper, so the keeper's frozen
// novelty_verdict and similarity snapshot can be wrong the moment it finishes.
// Nothing recomputes them, so at minimum say so.
async function reportInvalidatedKeepers(
  io: CommandIo,
  corpus: CorpusSweepView,
  groups: { keeper: { id: string; key_prefix: string; url: string } }[],
  droppedIds: Set<string>,
  vectoredDrops: { id: string; created_at?: string }[],
): Promise<void> {
  const flagged = [];
  for (const g of groups) {
    const manifest = await corpus.manifest(g.keeper.id).catch(() => null);
    const v = invalidatedByDrop(g.keeper.id, manifest, droppedIds, vectoredDrops);
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
  // Deliberately not naming a command. `corpus refresh-neighbours` was the
  // answer and is not ported yet: it still reads index/list.json and writes
  // manifests, which nothing has read since slice 1b, so running it would
  // leave readings.similarity untouched while reporting success. Saying
  // nothing is better than sending the operator at a no-op they would believe.
  io.stdout(
    `\nThese snapshots are stale, and re-measuring them needs no LLM call.\n` +
    `corpus refresh-neighbours is NOT yet ported to PostgreSQL (reading-lite-gh347.4.1):\n` +
    `running it now would rewrite objects nothing reads and leave the stored\n` +
    `snapshots unchanged. Until it lands, treat the ids above as known-stale.\n` +
    `The novelty_verdict itself only refreshes on a reprocess, which DOES re-roll\n` +
    `title and tags -- so weigh that before reprocessing purely to fix a label.`,
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
reading's embedding and relationships go with it in the same transaction.

Plan by default — prints each group, the keeper and why, and every object it
would delete. Add --execute to apply.

Each dropped reading's content is deleted before its row, so a failed object
delete keeps that reading and the sweep stays re-runnable.

Options:
  --keep <rd_ID>      Force the keeper for the group containing this id.
  --drop <rd_ID>      Operator-asserted pair mode (with exactly one --keep).
  --tenant <selector>  REQUIRED: tenant id (usr_…). 'global' has no PostgreSQL corpus.
  ${DATABASE_URL_ENV_HELP}
  --bucket <name>     R2 bucket holding captured content.
                      Default: READING_LITE_BUCKET / reading-lite.
  --local             Use the local miniflare bucket.
  --execute           Apply the sweep.
  --help              Show this message.`,
  defaultDeps: (io: CommandIo): CorpusSweepDeps => ({
    io,
    corpus: (databaseUrlEnv, tenant, run, opts) => {
      const url = operatorDatabaseUrl(databaseUrlEnv);
      if (opts?.requireLocal) requireLocalDatabase(url, databaseUrlEnv);
      return withOperatorSql(url, (sql) => run(operatorCorpusFor(sql, tenant)));
    },
    r2: {
      deleteObject: async (key, d) => (await import("../../corpus-lib/wrangler-r2")).deleteObject(key, d),
    },
  }),
  run: runCorpusSweep,
};
