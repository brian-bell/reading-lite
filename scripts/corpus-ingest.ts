#!/usr/bin/env -S npx tsx
import path from "node:path";
import { parseArgs } from "node:util";
import { ManifestSchema, ByUrlPointerSchema, type Manifest, type ByUrlPointer } from "../src/schemas/manifest";
import { mintReadingId, sha256Hex } from "../src/services";
import { resolveBatchConfig } from "./corpus-lib/config";
import { MARKDOWN_IMPORT_MAX_BYTES, readMarkdownDir } from "./import-markdown-lib/parse";
import { planFreshMarkdownIngest, type IngestPlan } from "./corpus-lib/batch/ingest-plan";
import { makeListCandidatesResolver } from "./corpus-lib/batch/list-candidates";
import { runFreshMarkdownBatch } from "./corpus-lib/batch/run-fresh-markdown";
import { clearSidecar, loadSidecar, saveSidecar } from "./corpus-lib/batch/sidecar";
import { makeR2Client, makeVectorizeClient, type R2Client } from "./lib/cf-clients";
import { makeAnthropicBatchClient, makeOpenAIEmbedClient } from "./corpus-lib/batch/clients";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Args {
  dir: string;
  execute: boolean;
  limit: number;
  bucket?: string;
  sidecar: string;
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      execute: { type: "boolean", default: false },
      limit: { type: "string" },
      bucket: { type: "string" },
      sidecar: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    printUsage();
    process.exit(0);
  }
  if (!values.dir) {
    console.error("missing required --dir <path>");
    printUsage();
    process.exit(2);
  }
  return {
    dir: values.dir,
    execute: values.execute === true,
    limit: parseLimit(values.limit),
    ...(values.bucket === undefined ? {} : { bucket: values.bucket }),
    sidecar: values.sidecar ?? path.join(values.dir, ".corpus-ingest.batch.json"),
  };
}

// A malformed --limit must not silently disable the cap: Number("abc") is NaN,
// which downstream treats as unbounded and could submit an entire (paid) backlog.
// Reject anything that isn't a positive integer before any batch is created.
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return Infinity;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--limit must be a positive integer (got ${raw})`);
    process.exit(2);
  }
  return n;
}

function printUsage(): void {
  console.log(`Usage: npm run corpus-ingest -- --dir <path> [options]

Bulk-ingests a directory of fresh markdown files into the corpus, summarizing
via the Anthropic Message Batch API (~50% cheaper, async, no rate-limit retries)
instead of the realtime queue. The markdown is the article — no URL is fetched.

  --dir <path>      Directory of .md files (required). Each needs a source line:
                      **Source:** https://example.com/article
                    Duplicates (same source) collapse to the largest file.
  --execute         Actually submit + write (otherwise prints the plan only).
  --limit <n>       Cap how many readings to submit. Applied AFTER the
                    idempotency check, so already-ready/pending owners don't
                    consume a slot — re-runs chunk through the remaining files.
  --bucket <name>   R2 bucket override. Default: CORPUS_R2_BUCKET / reading-lite.
  --sidecar <path>  Batch sidecar path (resume marker).
                    Default: <dir>/.corpus-ingest.batch.json.
  --help            Show this message.

Dry-run by default. Idempotent: re-running skips ready owners (by-url pointer OR
a pointerless legacy reading in index/list.json) and re-ingests failed (and
stranded-pending, past the worker's PENDING_TTL) owners in place; never
duplicates an already-ready URL. A by-url pointer written just before its pending
manifest (the worker's claim window) is honored as in-flight, not clobbered.
Crash-safe via the sidecar — a re-run resumes the in-flight batch, not re-bills.

Needs R2 + Vectorize creds (.corpus.vars) and ANTHROPIC/OPENAI keys, the same
credential world as 'corpus-recover --batch' (not the HTTP bearer token).

CAVEAT: write-phase only claims the by-url slot on success, so the URL stays
unclaimed during the in-flight batch window. A concurrent realtime submit of the
same URL could create a duplicate. Run this as the sole writer for the URLs.
Source URLs are normalized (via new URL().toString()) before hashing, so a
trailing-slash variant of a URL imported through the realtime HTTP route may not
dedup against it; this tool is self-consistent for re-runs.
A target that terminally fails (batch errored/expired/bad tool input) is written
as an addressable failed reading (by-id pointer) — recover it with reprocess.
Re-running the directory would mint a new id for it, since the by-url slot is
only claimed on success.`);
}

// R2-backed idempotency reader for prepareFreshMarkdown.
function idempotencyDeps(r2: R2Client) {
  return {
    readByUrlPointer: async (urlHash: string): Promise<ByUrlPointer | null> => {
      const raw = await r2.get(`index/by-url/${urlHash}`);
      return raw ? ByUrlPointerSchema.parse(JSON.parse(raw)) : null;
    },
    readManifest: async (keyPrefix: string): Promise<Manifest | null> => {
      const raw = await r2.get(`${keyPrefix}/manifest.json`);
      return raw ? ManifestSchema.parse(JSON.parse(raw)) : null;
    },
    findListCandidates: makeListCandidatesResolver(r2),
    mintId: mintReadingId,
    now: () => new Date().toISOString(),
    sha256: sha256Hex,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  // Load the sidecar FIRST. A live sidecar means an already-created (and billed)
  // batch; honoring it before any fresh directory read or idempotency planning is
  // what keeps resume crash-safe — a changed/removed source tree or a transient R2
  // error during planning must not strand a billed batch. runFreshMarkdownBatch
  // resumes straight from the sidecar (it carries the targets pollAndWrite needs)
  // without consulting this run's plan.
  const existing = await loadSidecar(args.sidecar);

  // Corpus creds are required by BOTH paths (a resume polls/writes; a fresh run
  // also submits), so resolve them independently of the directory read. A failure
  // is fatal on --execute (we can't reach R2/Anthropic at all); a dry run just
  // downgrades to skipping the idempotency preview.
  let cfg: ReturnType<typeof resolveBatchConfig> | null = null;
  try {
    cfg = resolveBatchConfig({ ...(args.bucket === undefined ? {} : { bucket: args.bucket }) });
  } catch (e) {
    if (args.execute) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
    process.stderr.write(
      `  ! could not resolve corpus creds — skipping the ready/pending idempotency preview\n` +
        `    (${e instanceof Error ? e.message : String(e)})\n`,
    );
  }

  // The fresh ingest plan (directory read + idempotency check) only feeds the
  // preview and a fresh submit; a resume ignores it entirely. So a dir/R2 failure
  // here is fatal only for a fresh --execute (no sidecar to fall back on) — never
  // for a resume, whose batch is already created and billed.
  let plan: IngestPlan | null = null;
  if (cfg) {
    try {
      const articles = await readMarkdownDir(args.dir);
      const r2 = makeR2Client(cfg.r2, globalThis.fetch);
      plan = await planFreshMarkdownIngest(articles, args.limit, idempotencyDeps(r2));
    } catch (e) {
      if (args.execute && !existing) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(2);
      }
      process.stderr.write(
        `  ! could not build the ingest plan — skipping the ready/pending idempotency preview\n` +
          `    (${e instanceof Error ? e.message : String(e)})\n`,
      );
    }
  }

  logPlan(args, plan, existing !== null);

  if (!args.execute) {
    printSummary({
      executed: false,
      resumed: existing !== null,
      ready: 0,
      failed: 0,
      skipped: plan?.prep.skipped.length ?? 0,
      wouldSubmit: plan?.prep.targets.length ?? 0,
    });
    return;
  }

  // execute: creds are always required (the cfg catch exits on --execute). A fresh
  // submit also needs the plan; a resume does not — runFreshMarkdownBatch honors
  // the sidecar before ever touching the targets we pass.
  if (!cfg || (!existing && !plan)) {
    console.error("internal: missing resolved config/plan on the execute path");
    process.exit(2);
  }
  const fetchFn = globalThis.fetch;
  const result = await runFreshMarkdownBatch(plan?.prep.targets ?? [], {
    r2: makeR2Client(cfg.r2, fetchFn),
    vectorize: makeVectorizeClient(cfg.vectorize, fetchFn),
    batch: makeAnthropicBatchClient({ fetch: fetchFn, apiKey: cfg.anthropicApiKey }),
    embed: makeOpenAIEmbedClient({ fetch: fetchFn, apiKey: cfg.openaiApiKey }),
    model: cfg.anthropicModel,
    now: () => new Date().toISOString(),
    sleep: (ms: number) => sleep(ms).then(() => undefined),
    loadSidecar: () => loadSidecar(args.sidecar),
    saveSidecar: (s) => saveSidecar(args.sidecar, s),
    log: (line) => process.stderr.write(line + "\n"),
  });

  // The batch finished and results are written — the sidecar is no longer needed.
  await clearSidecar(args.sidecar);

  const ready = result.report.filter((r) => r.status === "ready").length;
  const failed = result.report.filter((r) => r.status === "failed").length;
  process.stdout.write(
    JSON.stringify(
      {
        executed: true,
        resumed: result.resumed,
        batch_id: result.batchId,
        ready,
        failed,
        // On a resume the work came from the old sidecar, not this run's plan, so
        // the freshly-computed skip count would be misleading — report it only for
        // a fresh run (where the plan is guaranteed present).
        skipped: result.resumed ? 0 : (plan?.prep.skipped.length ?? 0),
      },
      null,
      2,
    ) + "\n",
  );
  if (failed > 0) process.exit(1);
}

function logPlan(args: Args, plan: IngestPlan | null, resuming: boolean): void {
  if (resuming) {
    process.stderr.write(`Sidecar:          ${args.sidecar} (would RESUME in-flight batch)\n`);
  }
  if (!plan) {
    process.stderr.write(`Directory:        ${args.dir}\n  (idempotency unresolved — no corpus creds)\n\n`);
    return;
  }

  process.stderr.write(
    `Directory:        ${args.dir}\n` +
      `Files found:      ${plan.fileCount}\n` +
      `Unique sources:   ${plan.uniqueSources}\n` +
      `Duplicate groups: ${plan.duplicateGroups.length}\n` +
      `Missing source:   ${plan.missingSource.length}\n` +
      `Oversized:        ${plan.oversized.length}  (> ${MARKDOWN_IMPORT_MAX_BYTES} bytes)\n`,
  );
  for (const group of plan.duplicateGroups) {
    process.stderr.write(`duplicate ${group.sourceUrl} -> ${group.selected.fileName} (${group.selected.bytes} bytes)\n`);
  }
  for (const file of plan.missingSource) {
    process.stderr.write(`  missing source: ${file.fileName}\n`);
  }
  for (const o of plan.oversized) {
    process.stderr.write(`  oversized: ${o.article.fileName} (${o.article.bytes} bytes, ${o.excessBytes} over)\n`);
  }

  const ready = plan.prep.skipped.filter((s) => s.reason === "already-ready").length;
  const pending = plan.prep.skipped.filter((s) => s.reason === "pending-in-flight").length;
  process.stderr.write(
    `Already ready:    ${ready}  (skipped)\n` +
      `Pending in-flight:${pending}  (skipped)\n` +
      `Would submit:     ${plan.prep.targets.length}\n\n`,
  );
  for (const s of plan.prep.skipped) {
    process.stderr.write(`  skip ${s.reason}: ${s.url}\n`);
  }
}

function printSummary(s: {
  executed: boolean;
  resumed: boolean;
  ready: number;
  failed: number;
  skipped: number;
  wouldSubmit: number;
}): void {
  process.stdout.write(
    JSON.stringify(
      {
        executed: s.executed,
        resumed: s.resumed,
        would_submit: s.wouldSubmit,
        ready: s.ready,
        failed: s.failed,
        skipped: s.skipped,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
