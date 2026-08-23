// `ops corpus delete-orphans` — remove orphan-dup pending readings flagged by
// the corpus audit (pending entries whose URL already has a ready copy), or an
// explicit --ids set, fully and consistently. See the deletion-plan rationale
// in scripts/corpus-lib/delete-plan.ts.
//
// Plan-first: a mode-less run prints every object it would delete and the
// list.json diff; --execute performs the deletes and rewrites index/list.json.

import { shouldRewriteIndex } from "../../corpus-lib/drop";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import type { ListItem } from "../../corpus-lib/types";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface CorpusDeleteOrphansR2 {
  // Lenient list read: null when index/list.json is absent or unreadable.
  readObject: (key: string, deps: R2Deps) => Promise<string | null>;
  // Ownership-aware deletable-key plan (by-url pointer only when owned).
  keysForReading: (id: string, prefix: string, url: string, deps: R2Deps) => Promise<string[]>;
  deleteObject: (key: string, deps: R2Deps) => Promise<"deleted" | "absent" | "error">;
  writeListIndex: (items: ListItem[], deps: R2Deps) => Promise<void>;
}

export interface CorpusDeleteOrphansDeps extends BaseDeps {
  r2: CorpusDeleteOrphansR2;
  readFile: (path: string) => Promise<string>;
}

interface Opts {
  indexPath: string;
  bucket: string;
  remote: boolean;
  execute: boolean;
  ids?: string[];
}

function parseOrphanArgs(argv: string[]): Opts {
  const opts: Opts = {
    indexPath: "index.json",
    bucket: process.env.READING_LITE_BUCKET ?? "reading-lite",
    remote: true,
    execute: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--execute") opts.execute = true;
    else if (a === "--local") opts.remote = false;
    else if (a === "--bucket") opts.bucket = requireValue(argv[++i], a);
    else if (a === "--index") opts.indexPath = requireValue(argv[++i], a);
    else if (a === "--ids") {
      opts.ids = requireValue(argv[++i], a).split(",").map((s) => s.trim()).filter(Boolean);
    } else throw new UsageError(`unknown arg: ${a}`);
  }
  return opts;
}

function requireValue(v: string | undefined, flag: string): string {
  if (v === undefined) throw new UsageError(`${flag} requires a value`);
  return v;
}

async function runCorpusDeleteOrphans(argv: string[], deps: CorpusDeleteOrphansDeps): Promise<number> {
  const opts = parseOrphanArgs(argv);
  const { io, r2 } = deps;
  const r2Deps: R2Deps = { bucket: opts.bucket, remote: opts.remote };

  // Read list.json up front: it's the authoritative source of key_prefix for
  // --ids mode, and the diff is shown even in plan mode.
  const listRaw = await r2.readObject("index/list.json", r2Deps);
  if (listRaw === null) {
    io.stderr("could not read index/list.json — aborting.");
    return 1;
  }
  const listObj = JSON.parse(listRaw);
  const listItems: ListItem[] = Array.isArray(listObj.items) ? listObj.items : [];
  const byId = new Map<string, ListItem>(listItems.map((i) => [i.id, i]));

  let targets: Array<{ id: string; prefix: string; url: string }>;
  let label: string;

  if (opts.ids && opts.ids.length > 0) {
    label = "readings (--ids)";
    targets = [];
    for (const id of opts.ids) {
      const it = byId.get(id);
      if (!it) {
        io.stderr(`refusing to proceed: id ${id} not found in index/list.json`);
        return 1;
      }
      if (it.status === "ready") {
        io.stderr(`refusing to proceed: ${id} is ready — deleting it would dangle its by-url pointer`);
        return 1;
      }
      targets.push({ id, prefix: it.key_prefix, url: it.url });
    }
  } else {
    let parsed: any;
    try {
      parsed = JSON.parse(await deps.readFile(opts.indexPath));
    } catch (e) {
      io.stderr(`could not read audit index at ${opts.indexPath}: ${(e as Error).message}`);
      io.stderr("run `npm run ops -- corpus audit --execute` first, or pass --index <path>.");
      return 1;
    }
    label = "orphan-dup readings";
    targets = (parsed.rows ?? [])
      .filter((r: any) => r.category === "pending" && r.class === "orphan-dup")
      .map((r: any) => ({ id: r.reading_id, prefix: r.key_prefix, url: r.url }));
  }

  if (targets.length === 0) {
    io.stdout("nothing to delete — empty target set.");
    return 0;
  }

  // Safety: every prefix must be id-scoped under readings/. Never touch a
  // prefix that doesn't carry its own reading id.
  for (const o of targets) {
    if (
      !o.id || !o.prefix || typeof o.url !== "string" ||
      !o.prefix.startsWith("readings/") || !o.prefix.endsWith(o.id)
    ) {
      io.stderr(`refusing to proceed: target failed prefix/id guard: ${JSON.stringify(o)}`);
      return 1;
    }
  }

  const targetIds = new Set(targets.map((o) => o.id));

  io.stdout(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
  io.stdout(`${label} to remove: ${targets.length}`);
  io.stdout(`Mode: ${opts.execute ? "EXECUTE" : "PLAN"}\n`);

  const beforeCount = listItems.length;
  const keptItems = listItems.filter((i) => !targetIds.has(i.id));
  const removedFromList = beforeCount - keptItems.length;

  let deleted = 0;
  let absent = 0;
  let errored = 0;

  for (const o of targets) {
    const keys = await r2.keysForReading(o.id, o.prefix, o.url, r2Deps);
    io.stdout(`• ${o.id}  ${o.url}`);
    for (const key of keys) {
      if (!opts.execute) {
        io.stdout(`    would delete  ${key}`);
        continue;
      }
      const res = await r2.deleteObject(key, r2Deps);
      if (res === "deleted") { deleted++; io.stdout(`    deleted   ${key}`); }
      else if (res === "absent") { absent++; }
      else errored++;
    }
  }

  io.stdout(
    `\nindex/list.json: ${beforeCount} items → ${keptItems.length} ` +
    `(removing ${removedFromList} entr${removedFromList === 1 ? "y" : "ies"})`,
  );
  if (removedFromList !== targets.length) {
    io.stderr(
      `  note: ${targets.length} targeted but ${removedFromList} matched in list.json ` +
      `(some may already be gone).`,
    );
  }

  if (!opts.execute) {
    io.stdout("\nPLAN — nothing changed. Re-run with --execute to apply.");
    return 0;
  }

  // Don't rewrite the index if any object delete failed: removing an orphan from
  // index/list.json while its objects/pointers (including a by-url ownership
  // pointer it owns) linger would hide a half-deleted reading from future audits.
  // Mirror corpus drop — leave the list intact so the cleanup stays visible and
  // re-runnable.
  if (!shouldRewriteIndex(errored)) {
    io.stderr(
      `\n${errored} object delete(s) failed — leaving index/list.json unchanged ` +
      `so the partially-deleted reading(s) stay visible. Re-run to retry.`,
    );
    io.stderr(`objects deleted: ${deleted}, absent (skipped): ${absent}, errors: ${errored}`);
    return 1;
  }

  await r2.writeListIndex(keptItems, r2Deps);
  io.stdout("\nindex/list.json rewritten.");
  io.stdout(`Done. objects deleted: ${deleted}, absent (skipped): ${absent}`);
  return 0;
}

export const corpusDeleteOrphansCommand: CommandDefinition<CorpusDeleteOrphansDeps> = {
  group: "corpus",
  name: "delete-orphans",
  summary: "Remove orphan-dup pending readings consistently",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus delete-orphans [options]

Default mode removes the orphan-dup pending readings flagged by the corpus
audit (read from --index). With --ids, removes exactly those reading ids
instead, resolving each key_prefix from index/list.json (so duplicate failed
copies of a URL that the deduped audit omits are still caught).

Plan by default: prints every object it would delete and the list.json diff.
Add --execute to perform the deletes and rewrite index/list.json.

For non-ready readings only. by-url pointers are eager URL ownership claims, so a
failed/pending reading may own its index/by-url/{hash} pointer — that pointer is
deleted only when it is actually owned by the dropped reading, never when it
belongs to a surviving ready copy of the same URL.

Run when nothing is being submitted: the list.json rewrite is a plain put, not a
CAS write, so a concurrent queue write could be lost.

Options:
  --index <path>   Audit index.json. Default: index.json.
  --ids <a,b,c>    Remove exactly these reading ids instead of the audit set.
  --bucket <name>  R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --local          Use the local miniflare bucket.
  --execute        Perform the deletes and rewrite index/list.json.
  --help           Show this message.`,
  defaultDeps: (io: CommandIo): CorpusDeleteOrphansDeps => ({
    io,
    r2: {
      readObject: async (key, d) => (await import("../../corpus-lib/wrangler-r2")).readObject(key, d),
      keysForReading: async (id, prefix, url, d) =>
        (await import("../../corpus-lib/wrangler-r2")).keysForReading(id, prefix, url, d),
      deleteObject: async (key, d) => (await import("../../corpus-lib/wrangler-r2")).deleteObject(key, d),
      writeListIndex: async (items, d) => (await import("../../corpus-lib/wrangler-r2")).writeListIndex(items, d),
    },
    readFile: async (p) => {
      const { promises: fs } = await import("node:fs");
      return fs.readFile(p, "utf8");
    },
  }),
  run: runCorpusDeleteOrphans,
};
