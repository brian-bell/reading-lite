// corpus-backfill-similarity — fill in the similarity snapshot for readings
// written before the field existed.
//
// Costs no OpenAI spend: each reading is scored by querying Vectorize with the
// vector it already owns (`--vector-id`), so there is no re-embedding and no
// chance of a fresh embedding drifting from the indexed one.
//
// Writes exactly one manifest field and leaves everything else byte-identical.
// This is deliberately NOT a reprocess: reprocessing re-runs the summarizer and
// rewrites the title and re-rolls the tags on unchanged source text.
//
// Dry-run by default. Pass --execute to act. Read-only otherwise.

import { planBackfill, snapshotFor, withSimilarity } from "./corpus-lib/backfill-similarity";
import { SIMILAR_TOP_K } from "../src/modules/stores/similarity-store";
import {
  queryByVectorId,
  readListIndex,
  readManifest,
  writeListIndex,
  type R2Deps,
} from "./corpus-lib/wrangler-r2";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Opts {
  only: string[];
  bucket: string;
  vectorizeIndex?: string;
  remote: boolean;
  execute: boolean;
  limit?: number;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    only: [],
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
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else opts.only.push(a);
  }
  return opts;
}

function printHelp(): void {
  console.log(`corpus-backfill-similarity — score readings written before the field existed.

Usage:
  tsx scripts/corpus-backfill-similarity.ts [rd_ID...] [--limit N] [--bucket B] [--vectorize IDX] [--local] [--execute]

Scores each ready reading by querying Vectorize with the vector it already owns,
so this costs no embedding calls. Writes only manifest.similarity, leaving the
rest of the manifest — title, tags, summary, updated_at — untouched. It is NOT a
reprocess and will not re-roll a summary.

Resumable: readings that already carry a score are skipped, so a run interrupted
part-way can simply be repeated. --limit caps how many are scored in one pass.

Default is a DRY RUN. Add --execute to write.

Run when nothing is being submitted: the list.json rewrite is a plain put, not a
CAS write, so a concurrent queue write could be lost.`);
}

const runner = (cmd: string, args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

async function writeManifest(keyPrefix: string, body: unknown, deps: R2Deps): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "corpus-backfill-"));
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const vectorizeIndex = opts.vectorizeIndex ?? opts.bucket;
  const deps: R2Deps = { bucket: opts.bucket, remote: opts.remote };

  const items = await readListIndex(deps);
  const plan = planBackfill(items as never, { only: opts.only });
  const targets = opts.limit === undefined ? plan.targets : plan.targets.slice(0, opts.limit);

  console.log(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
  console.log(`Vectorize: ${vectorizeIndex}`);
  console.log(`Corpus: ${items.length} readings`);
  console.log(`Already scored (skipped): ${plan.alreadyScored}`);
  console.log(`Not ready (skipped, own no vector): ${plan.skippedNotReady}`);
  console.log(`To score: ${plan.targets.length}${opts.limit === undefined ? "" : ` (limited to ${targets.length})`}`);
  console.log(`Mode: ${opts.execute ? "EXECUTE" : "DRY RUN"}\n`);

  if (targets.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  const now = new Date().toISOString();
  const scored = new Map<string, ReturnType<typeof snapshotFor>>();
  let noVector = 0;
  let errored = 0;

  for (const t of targets) {
    // Over-fetch by one: the reading's own vector always comes back first.
    const matches = await queryByVectorId(vectorizeIndex, t.id, SIMILAR_TOP_K + 1);
    if (matches === null) {
      noVector++;
      console.error(`  ! no vector indexed for ${t.id}  ${t.url}`);
      continue;
    }
    const snap = snapshotFor(t.id, matches, now);
    scored.set(t.id, snap);
    const score = snap.max === undefined ? "none" : snap.max.toFixed(3);
    console.log(`  ${t.id}  neighbours=${snap.count} nearest=${score}  ${t.url}`);

    if (!opts.execute) continue;

    const manifest = await readManifest(t.key_prefix, deps);
    if (manifest === null) {
      errored++;
      console.error(`  ! manifest unreadable for ${t.id}`);
      scored.delete(t.id);
      continue;
    }
    await writeManifest(t.key_prefix, withSimilarity(manifest, snap), deps);
  }

  console.log(`\nScored: ${scored.size}`);
  if (noVector > 0) {
    console.log(
      `No vector indexed: ${noVector} — these are ready readings whose vector was ` +
      `never written or has been removed. They cannot be scored without re-embedding.`,
    );
  }
  if (errored > 0) console.log(`Manifest read errors: ${errored}`);

  if (!opts.execute) {
    console.log("\nDRY RUN — nothing changed. Re-run with --execute to apply.");
    return;
  }

  // Mirror the scores onto the list rows so the SPA sees them without a
  // per-reading manifest fetch.
  const updated = items.map((i) => {
    const snap = scored.get(i.id);
    return snap === undefined ? i : { ...i, similarity: snap };
  });
  await writeListIndex(updated, deps);
  console.log("index/list.json rewritten.");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

export { parseArgs };
