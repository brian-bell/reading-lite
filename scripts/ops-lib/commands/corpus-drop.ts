// `ops corpus drop` — remove one or more readings from the corpus, by URL or
// by id. A thin front-end over the corpus R2 helpers: resolve each selector
// against index/list.json, delete every object under each target's id-scoped
// prefix, then rewrite index/list.json once.
//
// Non-ready only by default. A ready reading also owns a Vectorize embedding,
// so ready deletion is an explicit staging-cleanup path:
//   --allow-ready --bucket reading-lite-staging --vectorize reading-lite-staging
//
// Plan-first: a mode-less run resolves targets and prints every object it
// would delete plus the list.json diff; --execute performs the deletes.

import { resolveDropTargets, shouldRewriteIndex } from "../../corpus-lib/drop";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import type { ListItem } from "../../corpus-lib/types";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { READINGS_PREFIX } from "../../../src/modules/stores/layout";

export interface CorpusDropR2 {
  readListIndex: (deps: R2Deps) => Promise<ListItem[]>;
  keysForReading: (id: string, prefix: string, url: string, deps: R2Deps) => Promise<string[]>;
  deleteObject: (key: string, deps: R2Deps) => Promise<"deleted" | "absent" | "error">;
  deleteVector: (index: string, id: string) => Promise<"deleted" | "error">;
  writeListIndex: (items: ListItem[], deps: R2Deps) => Promise<void>;
}

export interface CorpusDropDeps extends BaseDeps {
  r2: CorpusDropR2;
}

interface Opts {
  selectors: string[];
  bucket: string;
  remote: boolean;
  execute: boolean;
  allowReady: boolean;
  vectorizeIndex?: string;
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
    else if (a === "--vectorize") opts.vectorizeIndex = requireValue(argv[++i], a);
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
  if (opts.allowReady && !opts.vectorizeIndex) {
    throw new UsageError("--allow-ready requires --vectorize <index> so ready embeddings are removed");
  }

  const r2Deps: R2Deps = { bucket: opts.bucket, remote: opts.remote };
  const items = await r2.readListIndex(r2Deps);

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
  if (opts.vectorizeIndex) io.stdout(`Vectorize: ${opts.vectorizeIndex}`);
  io.stdout(`Readings to drop: ${targets.length}`);
  io.stdout(`Mode: ${opts.execute ? "EXECUTE" : "PLAN"}\n`);
  for (const k of keptReady) io.stdout(`· keeping ready copy ${k.id}  ${k.url}`);
  if (keptReady.length) io.stdout("");

  const targetIds = new Set(targets.map((t) => t.id));
  const before = items.length;
  const kept = items.filter((i) => !targetIds.has(i.id));

  let deleted = 0;
  let absent = 0;
  let errored = 0;

  for (const t of targets) {
    const keys = await r2.keysForReading(t.id, t.prefix, t.url, r2Deps);
    io.stdout(`• ${t.id}  ${t.url}`);
    if (t.status === "ready" && opts.vectorizeIndex) {
      if (!opts.execute) {
        io.stdout(`    would delete vector  ${opts.vectorizeIndex}/${t.id}`);
      } else {
        const res = await r2.deleteVector(opts.vectorizeIndex, t.id);
        if (res === "deleted") { deleted++; io.stdout(`    deleted   vector:${opts.vectorizeIndex}/${t.id}`); }
        else { errored++; io.stderr(`    ! delete error  vector:${opts.vectorizeIndex}/${t.id}`); continue; }
      }
    }
    for (const key of keys) {
      if (!opts.execute) {
        io.stdout(`    would delete  ${key}`);
        continue;
      }
      const res = await r2.deleteObject(key, r2Deps);
      if (res === "deleted") { deleted++; io.stdout(`    deleted   ${key}`); }
      else if (res === "absent") absent++;
      else { errored++; io.stderr(`    ! delete error  ${key}`); }
    }
  }

  io.stdout(
    `\nindex/list.json: ${before} items → ${kept.length} ` +
    `(removing ${before - kept.length} entr${before - kept.length === 1 ? "y" : "ies"})`,
  );

  if (!opts.execute) {
    io.stdout("\nPLAN — nothing changed. Re-run with --execute to apply.");
    return 0;
  }

  // Don't rewrite the index if any object delete failed: removing the reading
  // from index/list.json while its objects/pointers linger would hide a
  // half-deleted reading from future audits. Leave the list intact so the drop
  // stays visible and re-runnable.
  if (!shouldRewriteIndex(errored)) {
    io.stderr(
      `\n${errored} object delete(s) failed — leaving index/list.json unchanged ` +
      `so the partially-deleted reading stays visible. Re-run to retry.`,
    );
    io.stderr(`objects deleted: ${deleted}, absent (skipped): ${absent}, errors: ${errored}`);
    return 1;
  }

  await r2.writeListIndex(kept, r2Deps);
  io.stdout("\nindex/list.json rewritten.");
  io.stdout(`Done. objects deleted: ${deleted}, absent (skipped): ${absent}`);
  return 0;
}

export const corpusDropCommand: CommandDefinition<CorpusDropDeps> = {
  group: "corpus",
  name: "drop",
  summary: "Remove readings by URL or id (non-ready only by default)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus drop <selector...> [options]

A selector is either a reading id (rd_…) or a URL. URLs resolve to every
non-ready copy of that URL in index/list.json; ids resolve to that one reading.

Non-ready only by default: a ready reading owns an embedding, so a named ready
id is refused and a URL keeps its ready copy (dropping only duplicates).
Staging cleanup can opt into ready deletion with --allow-ready, which requires
--vectorize and refuses the production bucket name.

Plan by default — prints every object it would delete and the list.json diff.
Add --execute to perform the deletes and rewrite index/list.json.

Run when nothing is being submitted: the list.json rewrite is a plain put, not
a CAS write, so a concurrent queue write could be lost.

Options:
  --bucket <name>     R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --vectorize <idx>   Vectorize index for ready-vector deletes (--allow-ready).
  --allow-ready       Permit dropping ready readings (staging cleanup only).
  --local             Use the local miniflare bucket.
  --execute           Perform the deletes and rewrite index/list.json.
  --help              Show this message.`,
  defaultDeps: (io: CommandIo): CorpusDropDeps => ({
    io,
    r2: {
      readListIndex: async (d) => (await import("../../corpus-lib/wrangler-r2")).readListIndex(d),
      keysForReading: async (id, prefix, url, d) =>
        (await import("../../corpus-lib/wrangler-r2")).keysForReading(id, prefix, url, d),
      deleteObject: async (key, d) => (await import("../../corpus-lib/wrangler-r2")).deleteObject(key, d),
      deleteVector: async (index, id) => (await import("../../corpus-lib/wrangler-r2")).deleteVector(index, id),
      writeListIndex: async (items, d) => (await import("../../corpus-lib/wrangler-r2")).writeListIndex(items, d),
    },
  }),
  run: runCorpusDrop,
};
