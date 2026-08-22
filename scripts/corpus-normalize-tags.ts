// corpus-normalize-tags — rewrite stored tags into canonical hyphenated form.
//
// Write-time normalization (src/modules/tags.ts) only fixes new readings. The
// existing corpus holds the same bucket under several spellings --
// `developer-tools` (99) beside `developer tools` (32) -- which splits the
// topical signal and halves `?tag=` and `q` search results.
//
// Like the similarity backfill, this writes exactly one manifest field. It is
// NOT a reprocess: it will not re-run the summarizer or touch the title,
// summary, keywords, or updated_at.
//
// Dry-run by default. Pass --execute to act.

import { normalizeTags } from "../src/modules/tags";
import { readListIndex, readManifest, writeListIndex, type R2Deps } from "./corpus-lib/wrangler-r2";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Opts {
  bucket: string;
  remote: boolean;
  execute: boolean;
  limit?: number;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    bucket: process.env.READING_LITE_BUCKET ?? "reading-lite",
    remote: true,
    execute: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log(`corpus-normalize-tags — rewrite stored tags into canonical hyphenated form.

Usage:
  tsx scripts/corpus-normalize-tags.ts [--limit N] [--bucket B] [--local] [--execute]

Writes only manifest.tags, leaving title, summary, keywords and updated_at
untouched. Readings whose tags are already canonical are skipped, so a run is
resumable and a second run is a no-op.

Default is a DRY RUN, printing every tag rewrite it would make.`);
      process.exit(0);
    } else if (a === "--execute") opts.execute = true;
    else if (a === "--local") opts.remote = false;
    else if (a === "--bucket") opts.bucket = argv[++i];
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

const runner = (cmd: string, args: string[]) =>
  new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });

async function putManifest(keyPrefix: string, body: unknown, deps: R2Deps): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "corpus-tags-"));
  const file = join(dir, "manifest.json");
  try {
    await writeFile(file, JSON.stringify(body), "utf8");
    const args = [
      "r2", "object", "put", `${deps.bucket}/${keyPrefix}/manifest.json`,
      "--file", file, "--content-type", "application/json",
    ];
    if (deps.remote !== false) args.push("--remote");
    const { code, stderr } = await runner("wrangler", args);
    if (code !== 0) throw new Error(`put manifest failed: ${stderr.trim()}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const same = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const deps: R2Deps = { bucket: opts.bucket, remote: opts.remote };
  const items = await readListIndex(deps);

  const changes = items
    .map((i) => {
      const tags = (i as { tags?: string[] }).tags;
      if (!tags || tags.length === 0) return null;
      const next = normalizeTags(tags);
      return same(tags, next) ? null : { item: i, from: tags, to: next };
    })
    .filter((c): c is { item: (typeof items)[number]; from: string[]; to: string[] } => c !== null);

  const targets = opts.limit === undefined ? changes : changes.slice(0, opts.limit);

  console.log(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
  console.log(`Corpus: ${items.length} readings`);
  console.log(`Readings with non-canonical tags: ${changes.length}`);
  console.log(`Mode: ${opts.execute ? "EXECUTE" : "DRY RUN"}\n`);

  if (targets.length === 0) {
    console.log("All tags already canonical — nothing to do.");
    return;
  }

  const vocabBefore = new Set(items.flatMap((i) => (i as { tags?: string[] }).tags ?? []));
  const rewritten = new Map<string, string[]>();
  let errored = 0;

  for (const c of targets) {
    const added = c.to.filter((t) => !c.from.includes(t));
    console.log(`  ${c.item.id}  [${c.from.join(", ")}] → [${c.to.join(", ")}]${added.length ? "" : "  (dedupe only)"}`);
    if (!opts.execute) {
      rewritten.set(c.item.id, c.to);
      continue;
    }
    const manifest = await readManifest(c.item.key_prefix, deps);
    if (manifest === null) {
      errored++;
      console.error(`  ! manifest unreadable for ${c.item.id}`);
      continue;
    }
    await putManifest(c.item.key_prefix, { ...manifest, tags: c.to }, deps);
    rewritten.set(c.item.id, c.to);
  }

  const vocabAfter = new Set(
    items.flatMap((i) => rewritten.get(i.id) ?? (i as { tags?: string[] }).tags ?? []),
  );
  console.log(
    `\nTag vocabulary: ${vocabBefore.size} → ${vocabAfter.size} distinct ` +
    `(${vocabBefore.size - vocabAfter.size} merged)`,
  );
  if (errored > 0) console.log(`Manifest read errors: ${errored}`);

  if (!opts.execute) {
    console.log("\nDRY RUN — nothing changed. Re-run with --execute to apply.");
    return;
  }

  const updated = items.map((i) => {
    const tags = rewritten.get(i.id);
    return tags === undefined ? i : { ...i, tags };
  });
  await writeListIndex(updated, deps);
  console.log("index/list.json rewritten.");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
