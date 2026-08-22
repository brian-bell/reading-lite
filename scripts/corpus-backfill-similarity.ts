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

import {
  planBackfill,
  snapshotFor,
  validateBackfillWrite,
} from "./corpus-lib/backfill-similarity";
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
  rescore: boolean;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    only: [],
    bucket: process.env.READING_LITE_BUCKET ?? "reading-lite",
    remote: true,
    execute: false,
    rescore: false,
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
    else if (a === "--rescore") opts.rescore = true;
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

--rescore recomputes readings that already carry a score. Use it after a
corpus-sweep, which changes the corpus around each keeper and leaves its stored
snapshot measured against a neighbour that no longer exists.

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
  const plan = planBackfill(items as never, { only: opts.only, rescore: opts.rescore });
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
  // Confirmed-written only. A reading enters this map after its manifest write
  // succeeds, never before: the flush below turns it into a list row, and
  // planBackfill treats that row as the resumability marker. Recording a score
  // whose manifest write failed would skip the reading permanently on every
  // later run -- the same manifest/index divergence this flush exists to
  // prevent, but in the direction that does not self-heal.
  const scored = new Map<string, ReturnType<typeof snapshotFor>>();
  let measured = 0;
  let noVector = 0;
  let errored = 0;
  let invalid = 0;

  // Flush the list index for whatever was written, on every exit path. Manifest
  // writes happen per reading, so deferring the index to a clean finish would
  // leave the manifests carrying a score while every list row still lacked one
  // if the pass threw or was interrupted.
  //
  // Not a per-row write: that would be one non-CAS put of the whole ~570KB
  // index per reading, widening the concurrent-write window it is meant to
  // protect. A flush on the way out costs one put and closes everything except
  // a hard kill -- and even that self-heals, because planBackfill decides what
  // to score from the list row, so anything missing from the index is simply
  // rescored on the next run.
  const flushIndex = async (): Promise<void> => {
    if (!opts.execute || scored.size === 0) return;
    const updated = items.map((i) => {
      const snap = scored.get(i.id);
      return snap === undefined ? i : { ...i, similarity: snap };
    });
    await writeListIndex(updated, deps);
    console.log(`index/list.json rewritten (${scored.size} row(s) updated).`);
  };

  try {
  for (const t of targets) {
    // Over-fetch by one: the reading's own vector always comes back first.
    const matches = await queryByVectorId(vectorizeIndex, t.id, SIMILAR_TOP_K + 1);
    if (matches === null) {
      noVector++;
      console.error(`  ! no vector indexed for ${t.id}  ${t.url}`);
      continue;
    }
    const snap = snapshotFor(t.id, matches, now);
    measured++;
    const score = snap.max === undefined ? "none" : snap.max.toFixed(3);
    console.log(`  ${t.id}  neighbours=${snap.count} nearest=${score}  ${t.url}`);

    if (!opts.execute) continue;

    // readManifest JSON.parses without a guard, so malformed stored JSON throws
    // here. Catch it per reading: one bad object should cost that reading, not
    // abort a pass that has already written others.
    let manifest: unknown;
    try {
      manifest = await readManifest(t.key_prefix, deps);
    } catch (e) {
      errored++;
      console.error(`  ! manifest unparseable for ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (manifest === null) {
      errored++;
      console.error(`  ! manifest unreadable for ${t.id}`);
      continue;
    }
    // Stored schema can drift. Writing an invalid manifest back would add a
    // score to an object the Worker rejects at read time and mark its row
    // scored, hiding it from later repair -- so skip and report it instead.
    const check = validateBackfillWrite(manifest, snap);
    if (!check.ok) {
      invalid++;
      console.error(`  ! manifest fails ManifestSchema for ${t.id}: ${check.error}`);
      continue;
    }
    try {
      await writeManifest(t.key_prefix, check.manifest, deps);
    } catch (e) {
      errored++;
      console.error(`  ! manifest write failed for ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    // Only now is the score durable enough to record in the index.
    scored.set(t.id, snap);
  }
  } finally {
    await flushIndex();
  }

  console.log(`\nMeasured: ${measured}${opts.execute ? `, written: ${scored.size}` : ""}`);
  if (noVector > 0) {
    console.log(
      `No vector indexed: ${noVector} — these are ready readings whose vector was ` +
      `never written or has been removed. They cannot be scored without re-embedding.`,
    );
  }
  if (errored > 0) {
    console.log(`Manifest read/write failures: ${errored} — these readings were not scored.`);
  }
  if (invalid > 0) {
    console.log(
      `Manifests failing ManifestSchema: ${invalid} — skipped rather than rewritten, ` +
      `so they stay visible to a later repair.`,
    );
  }

  // One rule for the exit status: a reading this run attempted and did not
  // score means the run did not do its job, whatever the cause. Per-reading
  // catches keep one bad object from aborting a pass that has already written
  // others, but they must not turn a partial run into a successful exit --
  // automation would read that as "backfill complete", and every unscored row
  // stays eligible and is retried on every future run.
  //
  // A --limit run is not a failure: those targets were never attempted.
  //
  // This does mean the command keeps exiting nonzero while the corpus holds
  // readings with no vector, which is the current steady state. That is
  // intended. It is the same reason those are reported rather than recorded as
  // an empty neighbourhood: a gap the tool cannot close should stay visible.
  const unscored = noVector + errored + invalid;
  if (opts.execute && unscored > 0) {
    console.error(
      `\n${unscored} of ${targets.length} attempted reading(s) were not scored — run incomplete.`,
    );
    process.exitCode = 1;
  }

  if (!opts.execute) {
    console.log("\nDRY RUN — nothing changed. Re-run with --execute to apply.");
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

export { parseArgs };
