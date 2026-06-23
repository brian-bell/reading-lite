#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { ManifestSchema } from "../src/schemas/manifest";
import { mintReadingId } from "../src/services";
import { resolveBatchConfig, type BatchConfig } from "./corpus-lib/config";
import { readMarkdownDir } from "./import-markdown-lib/parse";
import { runIngest, type IngestArgs, type IngestDeps } from "./corpus-lib/batch/ingest-cli";
import { runFreshBatch, type BatchRunResult } from "./corpus-lib/batch/run";
import type { FreshMarkdownDeps } from "./corpus-lib/batch/fresh-markdown";
import type { ExtractedTarget } from "./corpus-lib/batch/types";
import { makeR2Client, makeVectorizeClient, type R2Client } from "./lib/cf-clients";
import { makeAnthropicBatchClient, makeOpenAIEmbedClient } from "./corpus-lib/batch/clients";
import { clearSidecar, loadSidecar, saveSidecar, sidecarPath } from "./corpus-lib/batch/sidecar";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CliArgs extends IngestArgs {
  bucket?: string;
  sidecar: string;
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      execute: { type: "boolean", default: false },
      limit: { type: "string" },
      bucket: { type: "string" },
      sidecar: { type: "string" },
      // Accepted for parity with corpus-recover; batch is the only ingest mode.
      batch: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.dir) {
    printUsage();
    process.exit(values.help ? 0 : 2);
  }
  return {
    dir: values.dir,
    execute: values.execute === true,
    limit: parseLimit(values.limit),
    ...(values.bucket === undefined ? {} : { bucket: values.bucket }),
    sidecar: values.sidecar ?? "./corpus-ingest.batch.json",
  };
}

// A typo'd --limit must not silently disable the cap; reject non-positive ints.
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return Infinity;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--limit "${raw}" must be a positive integer`);
    process.exit(2);
  }
  return n;
}

function printUsage(): void {
  console.log(`Usage: npm run corpus-ingest -- --dir <path> [options]

Bulk-ingest a directory of fresh markdown files into the corpus, summarizing via
the Anthropic Message Batch API (~50% cheaper, async, no rate-limit retries)
instead of the realtime queue. Each file needs a **Source:** line with its URL.
Dry-run (plan only) by default.

  --dir <path>      Directory of .md files to ingest (required).
  --execute         Actually submit + write (otherwise prints the plan only).
  --limit <n>       Cap readings submitted THIS run, applied after idempotency
                    skips — a re-run resumes where the last left off.
  --bucket <name>   R2 bucket. Default: CORPUS_R2_BUCKET / reading-lite.
  --sidecar <path>  Batch resume sidecar. Default: ./corpus-ingest.batch.json.
  --batch           Accepted for parity; batch is the only ingest mode.
  --help            Show this message.

Idempotency is resolved client-side from index/by-url pointers: ready owners are
skipped, failed owners re-ingested in place, pending owners skipped. Because the
by-url slot is only claimed on success, the slot stays unclaimed during the
in-flight batch window — a concurrent realtime submit of the same URL could
create a duplicate. Safe for an operator backfill where this script is the sole
writer. Crash-safe: a re-run resumes the in-flight batch from the sidecar rather
than creating a second (double-billed) one.

Needs R2 + Vectorize creds (.corpus.vars: CORPUS_R2_*, CORPUS_CF_API_TOKEN) and
ANTHROPIC/OPENAI keys (.dev.vars/.prd.vars). Dry-run resolves idempotency from
R2 when creds are present; without them it warns and shows every eligible file
as would-submit.`);
}

function r2FreshDeps(r2: R2Client): FreshMarkdownDeps {
  return {
    readPointer: async (hash) => {
      const raw = await r2.get(`index/by-url/${hash}`);
      if (!raw) return null;
      return JSON.parse(raw) as { id: string; key_prefix: string };
    },
    readManifest: async (keyPrefix) => {
      const raw = await r2.get(`${keyPrefix}/manifest.json`);
      return raw ? ManifestSchema.parse(JSON.parse(raw)) : null;
    },
    now: () => new Date().toISOString(),
    newId: mintReadingId,
  };
}

const offlineFreshDeps: FreshMarkdownDeps = {
  readPointer: async () => null,
  readManifest: async () => null,
  now: () => new Date().toISOString(),
  newId: mintReadingId,
};

async function executeBatch(
  args: CliArgs,
  targets: ExtractedTarget[],
  cfg: BatchConfig,
): Promise<BatchRunResult> {
  const fetchFn = globalThis.fetch;
  const scPath = sidecarPath(args.sidecar);
  const result = await runFreshBatch(targets, {
    r2: makeR2Client(cfg.r2, fetchFn),
    vectorize: makeVectorizeClient(cfg.vectorize, fetchFn),
    batch: makeAnthropicBatchClient({ fetch: fetchFn, apiKey: cfg.anthropicApiKey }),
    embed: makeOpenAIEmbedClient({ fetch: fetchFn, apiKey: cfg.openaiApiKey }),
    model: cfg.anthropicModel,
    now: () => new Date().toISOString(),
    sleep: (ms: number) => sleep(ms).then(() => undefined),
    loadSidecar: () => loadSidecar(scPath),
    saveSidecar: (s) => saveSidecar(scPath, s),
    log: (line) => process.stderr.write(line + "\n"),
  });
  // The batch finished and results are written — the sidecar is no longer needed.
  await clearSidecar(scPath);
  return result;
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const deps: IngestDeps = {
    readMarkdownDir,
    resolveConfig: () => resolveBatchConfig({ ...(args.bucket === undefined ? {} : { bucket: args.bucket }) }),
    freshDepsFromConfig: (cfg) => r2FreshDeps(makeR2Client(cfg.r2, globalThis.fetch)),
    offlineFreshDeps,
    runBatch: (targets, cfg) => executeBatch(args, targets, cfg),
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  };
  const code = await runIngest(args, deps);
  if (code !== 0) process.exit(code);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
