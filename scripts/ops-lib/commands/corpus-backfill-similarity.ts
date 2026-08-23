// `ops corpus backfill-similarity` — fill in the similarity snapshot for
// readings written before the field existed.
//
// Costs no OpenAI spend: each reading is scored by querying Vectorize with the
// vector it already owns (`--vector-id`), so there is no re-embedding and no
// chance of a fresh embedding drifting from the indexed one. Writes exactly
// one manifest field. Plan-first: a mode-less run reads and scores (read-only
// Vectorize queries) but writes nothing; --execute writes the manifests and
// flushes the list index.

import {
  planBackfill,
  snapshotFor,
  validateBackfillWrite,
} from "../../corpus-lib/backfill-similarity";
import { SIMILAR_TOP_K } from "../../../src/modules/stores/similarity-store";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import type { ListItem } from "../../corpus-lib/types";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface CorpusBackfillR2 {
  readListIndex: (deps: R2Deps) => Promise<ListItem[]>;
  readManifest: (keyPrefix: string, deps: R2Deps) => Promise<any | null>;
  queryByVectorId: (index: string, id: string, topK: number) => Promise<{ id: string; score: number }[] | null>;
  putManifest: (keyPrefix: string, body: unknown, deps: R2Deps) => Promise<void>;
  writeListIndex: (items: ListItem[], deps: R2Deps) => Promise<void>;
}

export interface CorpusBackfillDeps extends BaseDeps {
  r2: CorpusBackfillR2;
  now: () => number;
}

interface Opts {
  only: string[];
  bucket: string;
  vectorizeIndex?: string;
  remote: boolean;
  execute: boolean;
  limit?: number;
  rescore: boolean;
}

function parseBackfillArgs(argv: string[]): Opts {
  const opts: Opts = {
    only: [],
    bucket: process.env.READING_LITE_BUCKET ?? "reading-lite",
    remote: true,
    execute: false,
    rescore: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--execute") opts.execute = true;
    else if (a === "--local") opts.remote = false;
    else if (a === "--bucket") opts.bucket = requireValue(argv[++i], a);
    else if (a === "--vectorize") opts.vectorizeIndex = requireValue(argv[++i], a);
    else if (a === "--limit") opts.limit = parsePositiveInt(requireValue(argv[++i], a));
    else if (a === "--rescore") opts.rescore = true;
    else if (a.startsWith("--")) throw new UsageError(`unknown flag: ${a}`);
    else opts.only.push(a);
  }
  return opts;
}

function requireValue(v: string | undefined, flag: string): string {
  if (v === undefined) throw new UsageError(`${flag} requires a value`);
  return v;
}

function parsePositiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--limit "${raw}" is not a positive integer`);
  return n;
}

async function runCorpusBackfill(argv: string[], deps: CorpusBackfillDeps): Promise<number> {
  const opts = parseBackfillArgs(argv);
  const { io, r2 } = deps;
  const vectorizeIndex = opts.vectorizeIndex ?? opts.bucket;
  const r2Deps: R2Deps = { bucket: opts.bucket, remote: opts.remote };

  const items = await r2.readListIndex(r2Deps);
  const plan = planBackfill(items as never, { only: opts.only, rescore: opts.rescore });
  const targets = opts.limit === undefined ? plan.targets : plan.targets.slice(0, opts.limit);

  io.stdout(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
  io.stdout(`Vectorize: ${vectorizeIndex}`);
  io.stdout(`Corpus: ${items.length} readings`);
  io.stdout(`Already scored (skipped): ${plan.alreadyScored}`);
  io.stdout(`Not ready (skipped, own no vector): ${plan.skippedNotReady}`);
  io.stdout(`To score: ${plan.targets.length}${opts.limit === undefined ? "" : ` (limited to ${targets.length})`}`);
  io.stdout(`Mode: ${opts.execute ? "EXECUTE" : "PLAN"}\n`);

  if (targets.length === 0) {
    io.stdout("Nothing to backfill.");
    return 0;
  }

  const now = new Date(deps.now()).toISOString();
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

  // Flush the list index for whatever was written, on every exit path — see the
  // original rationale: manifest writes are per reading, so deferring the index
  // to a clean finish would strand written scores if the pass throws.
  const flushIndex = async (): Promise<void> => {
    if (!opts.execute || scored.size === 0) return;
    const updated = items.map((i) => {
      const snap = scored.get(i.id);
      return snap === undefined ? i : { ...i, similarity: snap };
    });
    await r2.writeListIndex(updated, r2Deps);
    io.stdout(`index/list.json rewritten (${scored.size} row(s) updated).`);
  };

  try {
    for (const t of targets) {
      // Over-fetch by one: the reading's own vector always comes back first.
      const matches = await r2.queryByVectorId(vectorizeIndex, t.id, SIMILAR_TOP_K + 1);
      if (matches === null) {
        noVector++;
        io.stderr(`  ! no vector indexed for ${t.id}  ${t.url}`);
        continue;
      }
      const snap = snapshotFor(t.id, matches, now);
      measured++;
      const score = snap.max === undefined ? "none" : snap.max.toFixed(3);
      io.stdout(`  ${t.id}  neighbours=${snap.count} nearest=${score}  ${t.url}`);

      if (!opts.execute) continue;

      // readManifest JSON.parses without a guard, so malformed stored JSON throws
      // here. Catch it per reading: one bad object should cost that reading, not
      // abort a pass that has already written others.
      let manifest: unknown;
      try {
        manifest = await r2.readManifest(t.key_prefix, r2Deps);
      } catch (e) {
        errored++;
        io.stderr(`  ! manifest unparseable for ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (manifest === null) {
        errored++;
        io.stderr(`  ! manifest unreadable for ${t.id}`);
        continue;
      }
      // Stored schema can drift. Writing an invalid manifest back would add a
      // score to an object the Worker rejects at read time and mark its row
      // scored, hiding it from later repair -- so skip and report it instead.
      const check = validateBackfillWrite(manifest, snap);
      if (!check.ok) {
        invalid++;
        io.stderr(`  ! manifest fails ManifestSchema for ${t.id}: ${check.error}`);
        continue;
      }
      try {
        await r2.putManifest(t.key_prefix, check.manifest, r2Deps);
      } catch (e) {
        errored++;
        io.stderr(`  ! manifest write failed for ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      // Only now is the score durable enough to record in the index.
      scored.set(t.id, snap);
    }
  } finally {
    await flushIndex();
  }

  io.stdout(`\nMeasured: ${measured}${opts.execute ? `, written: ${scored.size}` : ""}`);
  if (noVector > 0) {
    io.stdout(
      `No vector indexed: ${noVector} — these are ready readings whose vector was ` +
      `never written or has been removed. They cannot be scored without re-embedding.`,
    );
  }
  if (errored > 0) {
    io.stdout(`Manifest read/write failures: ${errored} — these readings were not scored.`);
  }
  if (invalid > 0) {
    io.stdout(
      `Manifests failing ManifestSchema: ${invalid} — skipped rather than rewritten, ` +
      `so they stay visible to a later repair.`,
    );
  }

  // One rule for the exit status: a reading this run attempted and did not
  // score means the run did not do its job, whatever the cause (see the exit
  // rationale in the module header of corpus-lib/backfill-similarity.ts).
  // A --limit run is not a failure: those targets were never attempted.
  const unscored = noVector + errored + invalid;
  if (opts.execute && unscored > 0) {
    io.stderr(
      `\n${unscored} of ${targets.length} attempted reading(s) were not scored — run incomplete.`,
    );
    return 1;
  }

  if (!opts.execute) {
    io.stdout("\nPLAN — nothing changed. Re-run with --execute to apply.");
  }
  return 0;
}

export const corpusBackfillSimilarityCommand: CommandDefinition<CorpusBackfillDeps> = {
  group: "corpus",
  name: "backfill-similarity",
  summary: "Score readings written before manifest.similarity existed (no embedding calls)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus backfill-similarity [rd_ID...] [options]

Scores each ready reading by querying Vectorize with the vector it already owns,
so this costs no embedding calls. Writes only manifest.similarity, leaving the
rest of the manifest — title, tags, summary, updated_at — untouched. It is NOT a
reprocess and will not re-roll a summary.

Resumable: readings that already carry a score are skipped, so a run interrupted
part-way can simply be repeated. --limit caps how many are scored in one pass.

--rescore recomputes readings that already carry a score. Use it after a
corpus sweep, which changes the corpus around each keeper and leaves its stored
snapshot measured against a neighbour that no longer exists.

Plan by default. Add --execute to write.

Run when nothing is being submitted: the list.json rewrite is a plain put, not a
CAS write, so a concurrent queue write could be lost.

Options:
  --limit <n>         Cap how many readings are scored this pass.
  --rescore           Recompute readings that already carry a score.
  --bucket <name>     R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --vectorize <idx>   Vectorize index. Default: the bucket name.
  --local             Use the local miniflare bucket.
  --execute           Write manifests and flush the list index.
  --help              Show this message.`,
  defaultDeps: (io: CommandIo): CorpusBackfillDeps => ({
    io,
    r2: {
      readListIndex: async (d) => (await import("../../corpus-lib/wrangler-r2")).readListIndex(d),
      readManifest: async (kp, d) => (await import("../../corpus-lib/wrangler-r2")).readManifest(kp, d),
      queryByVectorId: async (index, id, topK) =>
        (await import("../../corpus-lib/wrangler-r2")).queryByVectorId(index, id, topK),
      putManifest: async (kp, body, d) => (await import("../../corpus-lib/wrangler-put")).putManifest(kp, body, d),
      writeListIndex: async (items, d) => (await import("../../corpus-lib/wrangler-r2")).writeListIndex(items, d),
    },
    now: () => Date.now(),
  }),
  run: runCorpusBackfill,
};
