#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { resolveBatchConfig } from "./corpus-lib/config";
import { MARKDOWN_IMPORT_MAX_BYTES, readMarkdownDir } from "./import-markdown-lib/parse";
import { selectEligibleArticles } from "./corpus-lib/ingest-eligible";
import { makeR2Client, makeVectorizeClient } from "./lib/cf-clients";
import { makeAnthropicBatchClient, makeOpenAIEmbedClient } from "./corpus-lib/batch/clients";
import { clearSidecar, loadSidecar, saveSidecar } from "./corpus-lib/batch/sidecar";
import { prepareFreshMarkdown, tallyDispositions } from "./corpus-lib/batch/prepare-fresh-markdown";
import { r2ReadDeps } from "./corpus-lib/batch/r2-reads";
import { runFreshMarkdownBatch } from "./corpus-lib/batch/run-fresh-markdown";
import { enforceSoleWriter } from "./corpus-lib/sole-writer";
import { mintReadingId } from "../src/services";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_SIDECAR = "./corpus-ingest.batch.json";

interface Args {
  dir: string;
  execute: boolean;
  soleWriter: boolean;
  limit: number;
  bucket?: string;
  sidecar: string;
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      execute: { type: "boolean", default: false },
      "sole-writer": { type: "boolean", default: false },
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
    soleWriter: values["sole-writer"] === true,
    limit: parsePositiveInt(values.limit),
    ...(values.bucket === undefined ? {} : { bucket: values.bucket }),
    sidecar: values.sidecar ?? DEFAULT_SIDECAR,
  };
}

// A malformed --limit must not silently disable the cap. Reject it loudly rather
// than fall back to "ingest everything" on an operator typo.
function parsePositiveInt(raw: string | undefined): number {
  if (raw === undefined) return Infinity;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--limit "${raw}" is not a positive integer`);
    process.exit(2);
  }
  return n;
}

function printUsage(): void {
  console.log(`Usage: npm run corpus-ingest -- --dir <path> [options]

Bulk-imports a directory of fresh markdown files into the corpus, summarizing via
the Anthropic Message Batch API (~50% cheaper, async, no rate-limit retries)
instead of the realtime /readings queue. Dry-run (plan only) by default.

Each file needs a source URL on a "**Source:** <url>" line (the import-markdown-dir
skill's normalize-source.sh stages exports that use **URL:**/**Link:**). Files are
deduped by source URL (largest wins) and any over ${Math.round(
    MARKDOWN_IMPORT_MAX_BYTES / 1000,
  )} KB are skipped.

  --dir <path>     Directory of .md files to ingest (required).
  --execute        Actually submit + write (otherwise prints the plan).
  --sole-writer    Required with --execute: assert the realtime writer is
                   paused/drained. This batch leaves each by-url slot unclaimed
                   for the in-flight window, so a live writer would race it
                   (duplicate compute/emails, pointer thrash). Run refuses without it.
  --limit <n>      Cap how many readings to *submit*, applied after the ownership
                   check so skipped ready/pending owners don't consume the budget.
  --bucket <name>  R2 bucket to write to. Default: CORPUS_R2_BUCKET / reading-lite.
  --sidecar <path> In-flight batch marker. Default: ${DEFAULT_SIDECAR}.
  --help           Show this message.

Idempotency: by-url ownership is read client-side — ready owners are skipped,
pending owners are skipped (a realtime submit may be in flight), failed owners
re-ingest in place, and unclaimed URLs mint a new reading. Fresh ingest eagerly
claims activated by-url slots before batch creation; --sole-writer remains
required because recover parity and failure-release follow-ups are still
outstanding.

Credentials (env or .corpus.vars/.dev.vars/.prd.vars): CORPUS_R2_* + CORPUS_CF_API_TOKEN
for R2/Vectorize, ANTHROPIC_API_KEY + OPENAI_API_KEY for summarize/embed. --execute
needs all of them; dry-run uses them to resolve ownership but degrades to the local
plan (no ready/pending skips shown) when they're absent.`);
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  // Sole-writer preflight (issue #68): refuse a real submit unless the operator
  // asserts the realtime writer is paused/drained. Runs before any dir/cred/batch
  // work so an unacknowledged --execute fails loudly and immediately. A resume
  // (live sidecar) is gated too. Fresh ingest now eagerly claims activated slots,
  // but recover parity and failure-release follow-ups are still outstanding.
  enforceSoleWriter(
    { execute: args.execute, acknowledged: args.soleWriter, tool: "corpus-ingest" },
    { write: (s) => void process.stderr.write(s), exit: (c) => process.exit(c) },
  );

  const fetchFn = globalThis.fetch;

  // Load the in-flight batch marker BEFORE touching --dir. The sidecar already
  // carries every target needed to poll + write, so a resume must not depend on
  // the source markdown directory: a dir moved or cleaned up during the (possibly
  // multi-hour) batch window would otherwise crash readMarkdownDir and block the
  // cost-safe resume — tempting the operator into a second, double-billed batch.
  // (runFreshMarkdownBatch's `produce` closure is skipped on resume, so the empty
  // `articles`/`eligible` below are never read.)
  const existing = await loadSidecar(args.sidecar);

  const articles = existing ? [] : await readMarkdownDir(args.dir);
  const { plan, oversized, eligible } = selectEligibleArticles(articles);

  if (!existing) {
    process.stderr.write(
      `Plan from ${args.dir}:\n` +
        `  files:          ${articles.length}\n` +
        `  selected:       ${plan.selected.length} (after de-dup by source URL)\n` +
        `  duplicate sets: ${plan.duplicateGroups.length}\n` +
        `  oversized:      ${oversized.length} (>${Math.round(MARKDOWN_IMPORT_MAX_BYTES / 1000)} KB, skipped)\n` +
        `  missing source: ${plan.missingSource.length} (skipped)\n` +
        `  eligible:       ${eligible.length}${
          Number.isFinite(args.limit) ? ` (submit capped to ${args.limit} by --limit)` : ""
        }\n\n`,
    );
  }

  // Creds are needed to read by-url ownership (dry-run) and to write (execute).
  // In dry-run we degrade gracefully without them so the local plan is still
  // previewable offline; execute requires them.
  let cfg;
  try {
    cfg = resolveBatchConfig(args.bucket === undefined ? {} : { bucket: args.bucket });
  } catch (e) {
    if (args.execute) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
    process.stderr.write(
      existing
        ? `  [dry-run] would RESUME in-flight batch ${existing.batchId} (${existing.targets.length} readings) from ${args.sidecar}\n` +
            `  [dry-run] resume needs creds to poll + write — ${e instanceof Error ? e.message : String(e)}\n`
        : `  [dry-run] ownership check skipped — ${e instanceof Error ? e.message : String(e)}\n` +
            `  [dry-run] up to ${eligible.length} eligible reading(s) would be checked + submitted with creds\n`,
    );
    printSummary({ executed: false });
    return;
  }
  const r2 = makeR2Client(cfg.r2, fetchFn);

  if (!args.execute) {
    if (existing) {
      process.stderr.write(
        `  [dry-run] would RESUME in-flight batch ${existing.batchId} (${existing.targets.length} readings) from ${args.sidecar}\n`,
      );
      printSummary({ executed: false });
      return;
    }
    const dryPlan = await prepareFreshMarkdown(eligible, {
      ...r2ReadDeps(r2),
      newId: mintReadingId,
      now: () => new Date().toISOString(),
    });
    const tally = tallyDispositions(dryPlan.dispositions);
    const wouldSubmit = Number.isFinite(args.limit) ? Math.min(tally.toIngest, args.limit) : tally.toIngest;
    process.stderr.write(
      `  [dry-run] ownership check:\n` +
        `    already-ready (skip):    ${tally.skipReady}\n` +
        `    pending owner (skip):    ${tally.skipPending}\n` +
        `    initializing (skip):     ${tally.skipInitializing}\n` +
        `    occupied repair (skip):  ${tally.skipOccupiedNeedsRepair}\n` +
        `    failed owner (reingest): ${tally.ingestFailed}\n` +
        `    new (mint id):           ${tally.ingestNew}\n` +
        `  [dry-run] would submit ${wouldSubmit} reading(s) in one Message Batch\n`,
    );
    printSummary({
      executed: false,
      skipped_ready: tally.skipReady,
      skipped_pending: tally.skipPending,
      skipped_occupied_repair: tally.skipOccupiedNeedsRepair,
    });
    return;
  }

  const result = await runFreshMarkdownBatch(eligible, {
    ...(Number.isFinite(args.limit) ? { limit: args.limit } : {}),
    r2,
    vectorize: makeVectorizeClient(cfg.vectorize, fetchFn),
    batch: makeAnthropicBatchClient({ fetch: fetchFn, apiKey: cfg.anthropicApiKey }),
    embed: makeOpenAIEmbedClient({ fetch: fetchFn, apiKey: cfg.openaiApiKey }),
    // The fresh-markdown path never fetches a URL; this is only here to satisfy
    // the shared BatchRunDeps shape and must never be called.
    extract: () => {
      throw new Error("corpus-ingest must not fetch URLs — markdown is in hand");
    },
    model: cfg.anthropicModel,
    newId: mintReadingId,
    now: () => new Date().toISOString(),
    sleep: (ms: number) => sleep(ms).then(() => undefined),
    loadSidecar: () => loadSidecar(args.sidecar),
    saveSidecar: (s) => saveSidecar(args.sidecar, s),
    clearSidecar: () => clearSidecar(args.sidecar),
    log: (line) => process.stderr.write(line + "\n"),
  });

  // The batch finished and results are written — the sidecar is no longer needed.
  await clearSidecar(args.sidecar);

  const ready = result.report.filter((r) => r.status === "ready").length;
  const failed = result.report.filter((r) => r.status === "failed").length;
  const skipped = result.report.filter((r) => r.status === "skipped").length;
  const tally = tallyDispositions(result.dispositions);
  printSummary({
    executed: true,
    resumed: result.resumed,
    ...(result.batchId === undefined ? {} : { batch_id: result.batchId }),
    ready,
    failed,
    skipped,
    skipped_ready: tally.skipReady,
    skipped_pending: tally.skipPending,
    skipped_occupied_repair: tally.skipOccupiedNeedsRepair,
  });
  if (failed > 0) process.exit(1);
}

// One JSON summary shape across dry-run and execute so the same field names mean
// the same thing in both. `skipped` = write-phase skips (missing batch result);
// `skipped_ready`/`skipped_pending`/`skipped_occupied_repair` = ownership skips.
interface Summary {
  executed: boolean;
  resumed?: boolean;
  batch_id?: string;
  ready: number;
  failed: number;
  skipped: number;
  skipped_ready: number;
  skipped_pending: number;
  skipped_occupied_repair: number;
}

function printSummary(s: Partial<Summary> & { executed: boolean }): void {
  const full: Summary = {
    ready: 0,
    failed: 0,
    skipped: 0,
    skipped_ready: 0,
    skipped_pending: 0,
    skipped_occupied_repair: 0,
    ...s,
  };
  process.stdout.write(JSON.stringify(full, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
