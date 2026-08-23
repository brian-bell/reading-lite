// corpus-backfill-vectors repairs ready readings whose durable Vectorize
// vector is absent. It embeds the stored manifest TL;DR and writes Vectorize
// only. R2 is read-only throughout this command.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runVectorBackfill, type VectorBackfillRow } from "./corpus-lib/backfill-vectors";
import { makeOpenAIEmbedClient } from "./corpus-lib/batch/clients";
import { makeVectorizeClient } from "./lib/cf-clients";
import { loadDotVars } from "./lib/dotvars";
import { readListIndex, readManifest, vectorExists } from "./corpus-lib/wrangler-r2";
import { OPENAI_EMBEDDING_MODEL } from "../src/modules/embeddings";

interface Opts {
  only: string[];
  bucket: string;
  vectorizeIndex?: string;
  remote: boolean;
  execute: boolean;
  limit?: number;
}

export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Opts {
  const opts: Opts = {
    only: [],
    bucket: env.READING_LITE_BUCKET ?? "reading-lite",
    vectorizeIndex: undefined,
    remote: true,
    execute: false,
    limit: undefined,
  };
  const takeValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--execute") opts.execute = true;
    else if (arg === "--local") {
      throw new Error("--local is unsupported: Vectorize has no local store");
    }
    else if (arg === "--bucket") opts.bucket = takeValue(arg, index++);
    else if (arg === "--vectorize") opts.vectorizeIndex = takeValue(arg, index++);
    else if (arg === "--limit") {
      const raw = takeValue(arg, index++);
      const limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error("--limit must be a positive integer");
      }
      opts.limit = limit;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      opts.only.push(arg);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`corpus-backfill-vectors - restore missing vectors from stored TL;DRs.

Usage:
  npm run corpus-backfill-vectors -- [rd_ID...] [--limit N] [--bucket B] [--vectorize IDX] [--execute]

Eligible readings have a ready list row, a confirmed Vectorize miss, and a
valid ready manifest with a non-empty TL;DR. The parsed manifest supplies the
embedding input and metadata. The command never rewrites a manifest or list row.
Vectorize has no local store, so --local is rejected rather than touching the
remote index during an operation presented as local.

Dry-run is the default and makes no OpenAI request or external write. --execute
uses ${OPENAI_EMBEDDING_MODEL} and upserts 1536-dimensional vectors with url,
title, tldr, tags, and created_at metadata.

Run execute mode while the realtime writer is quiet. After Vectorize exposes
the new vectors, dry-run corpus-backfill-similarity for the restored IDs, then
run that command with --execute.`);
}

function executeVars(): Record<string, string | undefined> {
  return {
    ...loadDotVars(".dev.vars"),
    ...loadDotVars(".prd.vars"),
    ...loadDotVars(".corpus.vars"),
    ...process.env,
  };
}

function required(vars: Record<string, string | undefined>, names: string[]): string {
  for (const name of names) {
    const value = vars[name];
    if (value) return value;
  }
  throw new Error(`missing execute credential: ${names.join(" or ")}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  const opts = parseArgs(argv);
  const vectorizeIndex = opts.vectorizeIndex ?? opts.bucket;
  const r2 = { bucket: opts.bucket, remote: opts.remote };

  console.log(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
  console.log(`Vectorize: ${vectorizeIndex}`);
  console.log(`Embedding model: ${OPENAI_EMBEDDING_MODEL} (1536 dimensions)`);
  console.log(`Mode: ${opts.execute ? "EXECUTE" : "DRY RUN"}\n`);

  let embedMany = async (_inputs: string[]): Promise<{ embeddings: number[][] }> => {
    throw new Error("internal error: dry-run attempted an embedding request");
  };
  let upsert = async (_vectors: Parameters<ReturnType<typeof makeVectorizeClient>["upsert"]>[0]): Promise<void> => {
    throw new Error("internal error: dry-run attempted a Vectorize write");
  };

  if (opts.execute) {
    const vars = executeVars();
    const openai = makeOpenAIEmbedClient({
      fetch,
      apiKey: required(vars, ["OPENAI_API_KEY"]),
    });
    const vectorize = makeVectorizeClient({
      accountId: required(vars, ["CORPUS_VECTORIZE_ACCOUNT_ID", "CORPUS_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"]),
      apiToken: required(vars, ["CORPUS_CF_API_TOKEN", "CLOUDFLARE_API_TOKEN"]),
      index: vectorizeIndex,
    });
    embedMany = (inputs) => openai.embedMany(inputs);
    upsert = (vectors) => vectorize.upsert(vectors);
  }

  const result = await runVectorBackfill(
    {
      execute: opts.execute,
      only: opts.only,
      limit: opts.limit,
    },
    {
      readListIndex: async () => (await readListIndex(r2)) as VectorBackfillRow[],
      vectorExists: (id) => vectorExists(vectorizeIndex, id),
      readManifest: (keyPrefix) => readManifest(keyPrefix, r2),
      embedMany,
      upsert,
    },
  );

  console.log(`Corpus rows: ${result.stats.corpus}`);
  console.log(`Rows considered: ${result.stats.considered}`);
  console.log(`Non-ready (skipped): ${result.stats.skippedNotReady}`);
  console.log(`Already indexed (skipped): ${result.stats.alreadyIndexed}`);
  if (result.stats.raced > 0) {
    console.log(`Indexed during execute precheck (skipped): ${result.stats.raced}`);
  }
  console.log(`Eligible missing vectors: ${result.eligible.length}`);
  for (const target of result.eligible) console.log(`  ${target.id}`);
  for (const problem of result.problems) {
    console.error(`  ! ${problem.id}: ${problem.kind}`);
  }

  if (!opts.execute) {
    console.log(`\nExpected input embeddings: ${result.eligible.length}`);
    console.log("DRY RUN - no OpenAI request or write was made.");
    if (result.eligible.length > 0) {
      console.log(`Re-run with --execute to restore these ${result.eligible.length} vector(s).`);
    }
  } else {
    console.log(`\nRestored vectors: ${result.restoredIds.length}`);
    if (result.restoredIds.length > 0) {
      const ids = result.restoredIds.join(" ");
      console.log("After Vectorize exposes the mutations, dry-run:");
      console.log(`  npm run corpus-backfill-similarity -- ${ids} --bucket ${opts.bucket} --vectorize ${vectorizeIndex}`);
      console.log("Then add --execute to write the similarity snapshots.");
    }
  }

  if (result.problems.length > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
