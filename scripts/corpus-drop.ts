// corpus-drop — remove one or more readings from the corpus, by URL or by id.
//
// A thin, generic front-end over the corpus R2 helpers: resolve each selector
// (a `rd_…` id, or a URL) against index/list.json, delete every object under
// each target's id-scoped prefix, then rewrite index/list.json once.
//
// Non-ready only by design. A `ready` reading owns its index/by-url/{hash}
// pointer and a Vectorize embedding; deleting it here would dangle both. So an
// explicitly-named ready id is refused, and a URL keeps any ready copy while
// dropping only its non-ready duplicates.
//
// Dry-run by default. Pass --execute to act. Read-only otherwise.

import { resolveDropTargets, shouldRewriteIndex, type DropTarget } from "./corpus-lib/drop";
import {
  deleteObject,
  keysForReading,
  readListIndex,
  writeListIndex,
  type R2Deps,
} from "./corpus-lib/wrangler-r2";

interface Opts {
  selectors: string[];
  bucket: string;
  remote: boolean;
  execute: boolean;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    selectors: [],
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
    else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else opts.selectors.push(a);
  }
  return opts;
}

function printHelp(): void {
  console.log(`corpus-drop — remove readings from the corpus, by URL or id.

Usage:
  tsx scripts/corpus-drop.ts <selector...> [--bucket reading-lite] [--local] [--execute]

A selector is either a reading id (rd_…) or a URL. URLs resolve to every
non-ready copy of that URL in index/list.json; ids resolve to that one reading.

Non-ready only: a ready reading owns its by-url pointer + embedding, so a named
ready id is refused and a URL keeps its ready copy (dropping only duplicates).

Default is a DRY RUN — prints every object it would delete and the list.json
diff. Add --execute to perform the deletes and rewrite index/list.json.

Run when nothing is being submitted: the list.json rewrite is a plain put, not
a CAS write, so a concurrent queue write could be lost.

Examples:
  tsx scripts/corpus-drop.ts rd_ABC123
  tsx scripts/corpus-drop.ts https://example.com/dead-link --execute
  tsx scripts/corpus-drop.ts rd_ABC https://a.com https://b.com --execute`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selectors.length === 0) {
    console.error("no selectors given. Pass one or more reading ids or URLs (see --help).");
    process.exit(2);
  }

  const deps: R2Deps = { bucket: opts.bucket, remote: opts.remote };
  const items = await readListIndex(deps);

  const resolved = resolveDropTargets(items, opts.selectors);
  if (!resolved.ok) {
    for (const e of resolved.errors) console.error(`✗ ${e}`);
    process.exit(1);
  }
  const { targets, keptReady } = resolved;

  // Safety: every prefix must be id-scoped under readings/. Never touch a
  // prefix that doesn't carry its own reading id.
  for (const t of targets) {
    if (!t.id || !t.prefix || !t.prefix.startsWith("readings/") || !t.prefix.endsWith(t.id)) {
      console.error(`refusing to proceed: target failed prefix/id guard: ${JSON.stringify(t)}`);
      process.exit(1);
    }
  }

  console.log(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
  console.log(`Readings to drop: ${targets.length}`);
  console.log(`Mode: ${opts.execute ? "EXECUTE" : "DRY RUN"}\n`);
  for (const k of keptReady) console.log(`· keeping ready copy ${k.id}  ${k.url}`);
  if (keptReady.length) console.log();

  const targetIds = new Set(targets.map((t) => t.id));
  const before = items.length;
  const kept = items.filter((i) => !targetIds.has(i.id));

  let deleted = 0;
  let absent = 0;
  let errored = 0;

  for (const t of targets) {
    const keys = await keysForReading(t.id, t.prefix, deps);
    console.log(`• ${t.id}  ${t.url}`);
    for (const key of keys) {
      if (!opts.execute) {
        console.log(`    would delete  ${key}`);
        continue;
      }
      const res = await deleteObject(key, deps);
      if (res === "deleted") { deleted++; console.log(`    deleted   ${key}`); }
      else if (res === "absent") absent++;
      else { errored++; console.error(`    ! delete error  ${key}`); }
    }
  }

  console.log(
    `\nindex/list.json: ${before} items → ${kept.length} ` +
    `(removing ${before - kept.length} entr${before - kept.length === 1 ? "y" : "ies"})`,
  );

  if (!opts.execute) {
    console.log("\nDRY RUN — nothing changed. Re-run with --execute to apply.");
    return;
  }

  // Don't rewrite the index if any object delete failed: removing the reading
  // from index/list.json while its objects/pointers linger would hide a
  // half-deleted reading from future audits. Leave the list intact so the drop
  // stays visible and re-runnable.
  if (!shouldRewriteIndex(errored)) {
    console.error(
      `\n${errored} object delete(s) failed — leaving index/list.json unchanged ` +
      `so the partially-deleted reading stays visible. Re-run to retry.`,
    );
    console.error(`objects deleted: ${deleted}, absent (skipped): ${absent}, errors: ${errored}`);
    process.exitCode = 1;
    return;
  }

  await writeListIndex(kept, deps);
  console.log("\nindex/list.json rewritten.");
  console.log(`Done. objects deleted: ${deleted}, absent (skipped): ${absent}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

export { parseArgs, type DropTarget };
