// `ops corpus sweep` — find readings that are the same resource under
// different URL spellings, keep the best copy, and drop the rest (vectors
// included). See scripts/corpus-lib/sweep.ts for the ranking and safety
// rationale. Plan-first: a mode-less run reports each group, the keeper and
// why, and every object it would delete; --execute applies the sweep.

import {
  invalidatedByDrop,
  planExplicitPair,
  planSweep,
  type SweepItem,
} from "../../corpus-lib/sweep";
import { shouldRewriteIndex } from "../../corpus-lib/drop";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";
import { operatorTenantSelector, type OperatorTenant } from "../../corpus-lib/tenant";
import { READINGS_PREFIX } from "../../../src/modules/stores/layout";

export interface CorpusSweepR2 {
  readListIndex: (deps: R2Deps) => Promise<unknown[]>;
  readManifest: (keyPrefix: string, deps: R2Deps) => Promise<any | null>;
  keysForReading: (id: string, prefix: string, url: string, deps: R2Deps) => Promise<string[]>;
  deleteObject: (key: string, deps: R2Deps) => Promise<"deleted" | "absent" | "error">;
  deleteVector: (index: string, id: string) => Promise<"deleted" | "error">;
  vectorExists: (index: string, id: string) => Promise<boolean>;
  writeListIndex: (items: unknown[], deps: R2Deps) => Promise<void>;
}

export interface CorpusSweepDeps extends BaseDeps {
  r2: CorpusSweepR2;
}

interface Opts {
  tenant?: string;
  only: string[];
  keep: string[];
  drop?: string;
  bucket: string;
  vectorizeIndex?: string;
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
    else if (a === "--vectorize") opts.vectorizeIndex = requireValue(argv[++i], a);
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
  const vectorizeIndex = opts.vectorizeIndex ?? opts.bucket;
  const tenant = requireOperatorTenant(opts.tenant);
  const r2Deps: R2Deps = { bucket: opts.bucket, keyRoot: tenant.keyRoot, remote: opts.remote };

  // --drop is the operator-asserted pair mode: two readings that carry the same
  // material but are genuinely different resources, so no canonicalization rule
  // pairs them. It takes exactly one --keep and no positional selectors, so the
  // assertion stays unambiguous.
  if (opts.drop !== undefined && (opts.keep.length !== 1 || opts.only.length > 0)) {
    throw new UsageError("--drop takes exactly one --keep <rd_ID> and no other selectors");
  }

  const items = (await r2.readListIndex(r2Deps)) as SweepItem[];

  const plan = opts.drop !== undefined
    ? planExplicitPair(items, { drop: opts.drop, keep: opts.keep[0]! })
    : planSweep(items, { only: opts.only, keep: opts.keep });

  if (plan.errors.length > 0) {
    for (const e of plan.errors) io.stderr(`✗ ${e}`);
    return 1;
  }

  io.stdout(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
  io.stdout(`Vectorize: ${vectorizeIndex}`);
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
  // Drops the index actually held a vector for, so the post-sweep warning can
  // be exact instead of guessing from status. created_at rides along so a
  // snapshot computed before a copy existed can rule that copy out.
  const vectoredDrops: { id: string; created_at?: string }[] = [];

  for (const t of targets) {
    const keys = await r2.keysForReading(t.id, t.key_prefix, t.url, r2Deps);
    io.stdout(`• dropping ${t.id}  ${t.url}`);
    // Ask the index whether a vector exists rather than inferring it from
    // status — every status-based rule was wrong in some direction (see
    // corpus-lib/wrangler-r2.vectorExists). The probe is read-only, so the plan
    // reports exactly what an execute would delete.
    //
    // Skipped under --local: Vectorize has no local emulator, so these commands
    // always target the real index while --local scopes R2 only. A local corpus
    // seeded from production shares reading ids, so touching Vectorize here
    // would mutate PRODUCTION during an operation presented as local.
    let hasVector = false;
    if (!opts.remote) {
      io.stdout(`    skipping vector (--local: Vectorize has no local store)`);
    } else {
      hasVector = await r2.vectorExists(vectorizeIndex, t.id);
      if (hasVector) vectoredDrops.push({ id: t.id, created_at: t.created_at });
      else io.stdout(`    no vector indexed for ${t.id}`);
    }
    if (hasVector) {
      if (!opts.execute) {
        io.stdout(`    would delete vector  ${vectorizeIndex}/${t.id}`);
      } else {
        const res = await r2.deleteVector(vectorizeIndex, t.id);
        if (res === "deleted") {
          deleted++;
          io.stdout(`    deleted   vector:${vectorizeIndex}/${t.id}`);
        } else {
          // Skip the objects too: leaving the reading intact keeps the corpus
          // consistent and the sweep re-runnable, where a half-drop would
          // strand a vector pointing at a reading that no longer exists.
          errored++;
          io.stderr(`    ! delete error  vector:${vectorizeIndex}/${t.id} — skipping its objects`);
          continue;
        }
      }
    }
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
        io.stderr(`    ! delete error  ${key}`);
      }
    }
  }

  const kept = items.filter((i) => !dropIds.has(i.id));
  io.stdout(
    `\nindex/list.json: ${items.length} items → ${kept.length} ` +
    `(removing ${items.length - kept.length} entr${items.length - kept.length === 1 ? "y" : "ies"})`,
  );

  if (!opts.execute) {
    io.stdout("\nPLAN — nothing changed. Re-run with --execute to apply.");
    return 0;
  }

  if (!shouldRewriteIndex(errored)) {
    io.stderr(
      `\n${errored} delete(s) failed — leaving index/list.json unchanged so the ` +
      `partially-deleted reading stays visible. Re-run to retry.`,
    );
    io.stderr(`deleted: ${deleted}, absent (skipped): ${absent}, errors: ${errored}`);
    return 1;
  }

  await r2.writeListIndex(kept, r2Deps);
  io.stdout("\nindex/list.json rewritten.");
  io.stdout(`Done. deleted: ${deleted}, absent (skipped): ${absent}`);

  // The sweep has already deleted objects and rewritten the index by now, so
  // the report is strictly informational: never let it fail the command.
  try {
    await reportInvalidatedKeepers(io, r2, plan.groups, dropIds, vectoredDrops, r2Deps, tenant);
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
  r2: CorpusSweepR2,
  groups: { keeper: { id: string; key_prefix: string; url: string } }[],
  droppedIds: Set<string>,
  vectoredDrops: { id: string; created_at?: string }[],
  r2Deps: R2Deps,
  tenant: OperatorTenant,
): Promise<void> {
  const flagged = [];
  for (const g of groups) {
    const manifest = await r2.readManifest(g.keeper.key_prefix, r2Deps).catch(() => null);
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
  io.stdout(
    `\nRefresh the measured score without an LLM call (no re-summarization, no tag churn):\n` +
    `  npm run ops -- corpus backfill-similarity --tenant ${operatorTenantSelector(tenant)} ${flagged.map((f) => f.id).join(" ")} --rescore --execute\n` +
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
drop is only ever proposed alongside a surviving keeper and the reading's
Vectorize vector is deleted with it. --vectorize defaults to the bucket name
(the two match in every environment).

Plan by default — prints each group, the keeper and why, and every object it
would delete. Add --execute to apply.

Run when nothing is being submitted: the list.json rewrite is a plain put, not
a CAS write, so a concurrent queue write could be lost.

Options:
  --keep <rd_ID>      Force the keeper for the group containing this id.
  --drop <rd_ID>      Operator-asserted pair mode (with exactly one --keep).
  --bucket <name>     R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --tenant <selector>  REQUIRED: tenant id (usr_…) or 'global' for the pre-tenant layout.
  --vectorize <idx>   Vectorize index. Default: the bucket name.
  --local             Use the local miniflare bucket (Vectorize is skipped).
  --execute           Apply the sweep.
  --help              Show this message.`,
  defaultDeps: (io: CommandIo): CorpusSweepDeps => ({
    io,
    r2: {
      readListIndex: async (d) => (await import("../../corpus-lib/wrangler-r2")).readListIndex(d),
      readManifest: async (kp, d) => (await import("../../corpus-lib/wrangler-r2")).readManifest(kp, d),
      keysForReading: async (id, prefix, url, d) =>
        (await import("../../corpus-lib/wrangler-r2")).keysForReading(id, prefix, url, d),
      deleteObject: async (key, d) => (await import("../../corpus-lib/wrangler-r2")).deleteObject(key, d),
      deleteVector: async (index, id) => (await import("../../corpus-lib/wrangler-r2")).deleteVector(index, id),
      vectorExists: async (index, id) => (await import("../../corpus-lib/wrangler-r2")).vectorExists(index, id),
      writeListIndex: async (items, d) =>
        (await import("../../corpus-lib/wrangler-r2")).writeListIndex(items as never, d),
    },
  }),
  run: runCorpusSweep,
};
