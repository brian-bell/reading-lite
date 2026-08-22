// corpus-sweep — find readings that are the same resource under different URL
// spellings, keep the best copy, and drop the rest (vectors included).
//
// The gap it fills: by-url ownership is keyed on the exact submitted URL, so
// `https://youtu.be/X` and `https://www.youtube.com/watch?v=X` claim separate
// slots and both reach `ready`. `corpus-drop` matches selectors by exact URL
// equality and refuses ready readings on production, so it cannot reconcile
// them. Sweep canonicalizes URLs to group the copies, ranks them, and deletes
// the losers — including each one's Vectorize vector, which is what makes
// dropping a ready reading safe here (see scripts/corpus-lib/sweep.ts).
//
// Dry-run by default. Pass --execute to act. Read-only otherwise.

import { invalidatedByDrop, planExplicitPair, planSweep, type SweepItem } from "./corpus-lib/sweep";
import { shouldRewriteIndex } from "./corpus-lib/drop";
import { readManifest } from "./corpus-lib/wrangler-r2";
import {
  deleteObject,
  deleteVector,
  keysForReading,
  readListIndex,
  writeListIndex,
  type R2Deps,
} from "./corpus-lib/wrangler-r2";

interface Opts {
  only: string[];
  keep: string[];
  drop?: string;
  bucket: string;
  vectorizeIndex?: string;
  remote: boolean;
  execute: boolean;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    only: [],
    keep: [],
    bucket: process.env.READING_LITE_BUCKET ?? "reading-lite",
    remote: true,
    execute: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--execute") opts.execute = true;
    else if (a === "--local") opts.remote = false;
    else if (a === "--bucket") opts.bucket = argv[++i];
    else if (a === "--vectorize") opts.vectorizeIndex = argv[++i];
    else if (a === "--keep") opts.keep.push(argv[++i]);
    else if (a === "--drop") opts.drop = argv[++i];
    else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else opts.only.push(a);
  }
  return opts;
}

function printHelp(): void {
  console.log(`corpus-sweep — reconcile duplicate readings of the same resource.

Usage:
  tsx scripts/corpus-sweep.ts [selector...] [--keep rd_ID]... [--bucket B] [--vectorize IDX] [--local] [--execute]

With no selector it scans the whole corpus and reports every duplicate group.
A selector (a reading id, or any URL spelling of the resource) narrows the
sweep to the groups it touches — the safe way to fix one known duplicate.

Keeper ranking, best first: ready beats non-ready, then the richer summary,
then the newer copy. Override per group with --keep <rd_ID>.

For two readings that carry the same material but are genuinely different
resources (a video and the tweet arguing the same thing), no URL rule can pair
them -- assert it with --drop <rd_ID> --keep <rd_ID>. The keeper must be ready.

Unlike corpus-drop, this WILL drop a ready reading on production, because a
drop is only ever proposed alongside a surviving keeper and the reading's
Vectorize vector is deleted with it. --vectorize defaults to the bucket name
(the two match in every environment).

Default is a DRY RUN — prints each group, the keeper and why, and every object
it would delete. Add --execute to apply.

Run when nothing is being submitted: the list.json rewrite is a plain put, not
a CAS write, so a concurrent queue write could be lost.

Examples:
  tsx scripts/corpus-sweep.ts                                   # report all duplicates
  tsx scripts/corpus-sweep.ts rd_PQ132K3HK5                     # plan one group
  tsx scripts/corpus-sweep.ts https://youtu.be/0oXOOlqVu5M --execute
  tsx scripts/corpus-sweep.ts rd_A --keep rd_B --execute
  tsx scripts/corpus-sweep.ts --drop rd_TWEET --keep rd_VIDEO --execute`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const vectorizeIndex = opts.vectorizeIndex ?? opts.bucket;
  const deps: R2Deps = { bucket: opts.bucket, remote: opts.remote };

  const items = (await readListIndex(deps)) as unknown as SweepItem[];

  // --drop is the operator-asserted pair mode: two readings that carry the same
  // material but are genuinely different resources, so no canonicalization rule
  // pairs them. It takes exactly one --keep and no positional selectors, so the
  // assertion stays unambiguous.
  if (opts.drop !== undefined && (opts.keep.length !== 1 || opts.only.length > 0)) {
    console.error("--drop takes exactly one --keep <rd_ID> and no other selectors");
    process.exit(2);
  }
  const plan = opts.drop !== undefined
    ? planExplicitPair(items, { drop: opts.drop, keep: opts.keep[0] })
    : planSweep(items, { only: opts.only, keep: opts.keep });

  if (plan.errors.length > 0) {
    for (const e of plan.errors) console.error(`✗ ${e}`);
    process.exit(1);
  }

  console.log(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
  console.log(`Vectorize: ${vectorizeIndex}`);
  console.log(`Corpus: ${items.length} readings`);
  console.log(`Duplicate groups: ${plan.groups.length}`);
  console.log(`Mode: ${opts.execute ? "EXECUTE" : "DRY RUN"}\n`);

  if (plan.groups.length === 0) {
    console.log("No duplicate groups found — nothing to sweep.");
    return;
  }

  const targets = plan.groups.flatMap((g) => g.drops);

  // Safety: every prefix must be id-scoped under readings/. Never touch a
  // prefix that doesn't carry its own reading id.
  for (const t of targets) {
    if (
      !t.id || !t.key_prefix || typeof t.url !== "string" ||
      !t.key_prefix.startsWith("readings/") || !t.key_prefix.endsWith(t.id)
    ) {
      console.error(`refusing to proceed: target failed prefix/id guard: ${JSON.stringify(t)}`);
      process.exit(1);
    }
  }

  // The invariant that lets sweep touch ready readings at all: each group keeps
  // exactly one survivor, and that survivor is never in the drop set.
  const dropIds = new Set(targets.map((t) => t.id));
  for (const g of plan.groups) {
    if (dropIds.has(g.keeper.id) || g.drops.length !== g.items.length - 1) {
      console.error(`refusing to proceed: group ${g.key} would not keep exactly one survivor`);
      process.exit(1);
    }
  }

  for (const g of plan.groups) {
    console.log(`▸ ${g.key}`);
    console.log(`    keep  ${g.keeper.id}  [${g.keeper.status}]  ${g.keeper.url}  (${g.reason})`);
    for (const d of g.drops) console.log(`    drop  ${d.id}  [${d.status}]  ${d.url}`);
    console.log();
  }

  let deleted = 0;
  let absent = 0;
  let errored = 0;

  for (const t of targets) {
    const keys = await keysForReading(t.id, t.key_prefix, t.url, deps);
    console.log(`• dropping ${t.id}  ${t.url}`);
    if (t.status === "ready") {
      if (!opts.execute) {
        console.log(`    would delete vector  ${vectorizeIndex}/${t.id}`);
      } else {
        const res = await deleteVector(vectorizeIndex, t.id);
        if (res === "deleted") {
          deleted++;
          console.log(`    deleted   vector:${vectorizeIndex}/${t.id}`);
        } else {
          // Skip the objects too: leaving the reading intact keeps the corpus
          // consistent and the sweep re-runnable, where a half-drop would
          // strand a vector pointing at a reading that no longer exists.
          errored++;
          console.error(`    ! delete error  vector:${vectorizeIndex}/${t.id} — skipping its objects`);
          continue;
        }
      }
    }
    for (const key of keys) {
      if (!opts.execute) {
        console.log(`    would delete  ${key}`);
        continue;
      }
      const res = await deleteObject(key, deps);
      if (res === "deleted") {
        deleted++;
        console.log(`    deleted   ${key}`);
      } else if (res === "absent") absent++;
      else {
        errored++;
        console.error(`    ! delete error  ${key}`);
      }
    }
  }

  const kept = items.filter((i) => !dropIds.has(i.id));
  console.log(
    `\nindex/list.json: ${items.length} items → ${kept.length} ` +
    `(removing ${items.length - kept.length} entr${items.length - kept.length === 1 ? "y" : "ies"})`,
  );

  if (!opts.execute) {
    console.log("\nDRY RUN — nothing changed. Re-run with --execute to apply.");
    return;
  }

  if (!shouldRewriteIndex(errored)) {
    console.error(
      `\n${errored} delete(s) failed — leaving index/list.json unchanged so the ` +
      `partially-deleted reading stays visible. Re-run to retry.`,
    );
    console.error(`deleted: ${deleted}, absent (skipped): ${absent}, errors: ${errored}`);
    process.exitCode = 1;
    return;
  }

  await writeListIndex(kept as any, deps);
  console.log("\nindex/list.json rewritten.");
  console.log(`Done. deleted: ${deleted}, absent (skipped): ${absent}`);

  await reportInvalidatedKeepers(plan.groups, dropIds, deps);
}

// A sweep changes the corpus around each keeper, so the keeper's frozen
// novelty_verdict and similarity snapshot can be wrong the moment it finishes.
// Nothing recomputes them, so at minimum say so.
async function reportInvalidatedKeepers(
  groups: { keeper: { id: string; key_prefix: string; url: string } }[],
  dropIds: Set<string>,
  deps: R2Deps,
): Promise<void> {
  const flagged = [];
  for (const g of groups) {
    const manifest = await readManifest(g.keeper.key_prefix, deps).catch(() => null);
    const v = invalidatedByDrop(g.keeper.id, manifest, dropIds);
    if (v.invalidated) flagged.push({ ...v, url: g.keeper.url });
  }
  if (flagged.length === 0) return;

  console.log(`\n${flagged.length} keeper(s) now carry a stale relationship claim:`);
  for (const f of flagged) {
    const bits = [];
    if (f.verdict) bits.push(`verdict "${f.verdict}"`);
    if (f.staleConnections.length > 0) bits.push(`cites dropped ${f.staleConnections.join(", ")}`);
    if (f.staleSimilarity) bits.push("similarity measured against a dropped neighbour");
    console.log(`  ${f.id}  ${bits.join("; ")}`);
    console.log(`      ${f.url}`);
  }
  console.log(
    `\nRefresh the measured score without an LLM call (no re-summarization, no tag churn):\n` +
    `  npm run corpus-backfill-similarity -- ${flagged.map((f) => f.id).join(" ")} --rescore --execute\n` +
    `The novelty_verdict itself only refreshes on a reprocess, which DOES re-roll\n` +
    `title and tags -- so weigh that before reprocessing purely to fix a label.`,
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

export { parseArgs };
