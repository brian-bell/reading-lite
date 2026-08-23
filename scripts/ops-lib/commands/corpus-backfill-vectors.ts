// `ops corpus backfill-vectors` — repair ready readings whose durable
// Vectorize vector is absent. Embeds the stored manifest TL;DR and writes
// Vectorize only; R2 is read-only throughout. Plan-first: a mode-less run
// resolves eligibility (list read + per-row Vectorize miss probe + manifest
// parse) but makes no OpenAI request and no external write; --execute embeds
// and upserts. --local is rejected outright: Vectorize has no local store, so
// a "local" run would mutate the real index.

import { runVectorBackfill, type VectorBackfillResult, type VectorBackfillRow } from "../../corpus-lib/backfill-vectors";
import { OPENAI_EMBEDDING_MODEL } from "../../../src/modules/embeddings";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";

export interface CorpusBackfillVectorsDeps extends BaseDeps {
  r2: {
    readListIndex: (deps: R2Deps) => Promise<VectorBackfillRow[]>;
    vectorExists: (index: string, id: string) => Promise<boolean>;
    readManifest: (keyPrefix: string, deps: R2Deps) => Promise<unknown>;
  };
  // Execute-only: resolves credentials (throwing when absent, BEFORE any read
  // work) and returns the paid/write seams. Never called in plan mode.
  makeWriters: (vectorizeIndex: string, namespace: string | undefined) => Promise<{
    embedMany: (inputs: string[]) => Promise<{ embeddings: number[][] }>;
    upsert: (vectors: {
      id: string;
      values: number[];
      metadata?: Record<string, unknown>;
    }[]) => Promise<void>;
  }>;
}

interface Opts {
  only: string[];
  bucket: string;
  tenant?: string;
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
      throw new UsageError(`${flag} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--execute") opts.execute = true;
    else if (arg === "--local") {
      throw new UsageError("--local is unsupported: Vectorize has no local store");
    }
    else if (arg === "--bucket") opts.bucket = takeValue(arg, index++);
    else if (arg === "--tenant") opts.tenant = takeValue(arg, index++);
    else if (arg === "--vectorize") opts.vectorizeIndex = takeValue(arg, index++);
    else if (arg === "--limit") {
      const raw = takeValue(arg, index++);
      const limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new UsageError("--limit must be a positive integer");
      }
      opts.limit = limit;
    } else if (arg.startsWith("--")) {
      throw new UsageError(`unknown flag: ${arg}`);
    } else {
      opts.only.push(arg);
    }
  }
  return opts;
}

async function runCorpusBackfillVectors(
  argv: string[],
  deps: CorpusBackfillVectorsDeps,
): Promise<number> {
  const opts = parseArgs(argv);
  const { io, r2 } = deps;
  const vectorizeIndex = opts.vectorizeIndex ?? opts.bucket;
  const tenant = requireOperatorTenant(opts.tenant);
  const r2Deps: R2Deps = { bucket: opts.bucket, keyRoot: tenant.keyRoot, remote: opts.remote };

  io.stdout(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
  io.stdout(`Vectorize: ${vectorizeIndex}`);
  io.stdout(`Embedding model: ${OPENAI_EMBEDDING_MODEL} (1536 dimensions)`);
  io.stdout(`Mode: ${opts.execute ? "EXECUTE" : "PLAN"}\n`);

  let embedMany = async (_inputs: string[]): Promise<{ embeddings: number[][] }> => {
    throw new Error("internal error: plan mode attempted an embedding request");
  };
  let upsert = async (
    _vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[],
  ): Promise<void> => {
    throw new Error("internal error: plan mode attempted a Vectorize write");
  };
  if (opts.execute) {
    // Awaited before any read so a missing credential fails the run up front,
    // matching the retired standalone script.
    ({ embedMany, upsert } = await deps.makeWriters(vectorizeIndex, tenant.namespace));
  }

  const result: VectorBackfillResult = await runVectorBackfill(
    {
      execute: opts.execute,
      only: opts.only,
      limit: opts.limit,
    },
    {
      readListIndex: async () => r2.readListIndex(r2Deps),
      vectorExists: (id) => r2.vectorExists(vectorizeIndex, id),
      readManifest: (keyPrefix) => r2.readManifest(keyPrefix, r2Deps),
      embedMany,
      upsert: upsert as never,
    },
  );

  io.stdout(`Corpus rows: ${result.stats.corpus}`);
  io.stdout(`Rows considered: ${result.stats.considered}`);
  io.stdout(`Non-ready (skipped): ${result.stats.skippedNotReady}`);
  io.stdout(`Already indexed (skipped): ${result.stats.alreadyIndexed}`);
  if (result.stats.raced > 0) {
    io.stdout(`Indexed during execute precheck (skipped): ${result.stats.raced}`);
  }
  io.stdout(`Eligible missing vectors: ${result.eligible.length}`);
  for (const target of result.eligible) io.stdout(`  ${target.id}`);
  for (const problem of result.problems) {
    io.stderr(`  ! ${problem.id}: ${problem.kind}`);
  }

  if (!opts.execute) {
    io.stdout(`\nExpected input embeddings: ${result.eligible.length}`);
    io.stdout("PLAN - no OpenAI request or write was made.");
    if (result.eligible.length > 0) {
      io.stdout(`Re-run with --execute to restore these ${result.eligible.length} vector(s).`);
    }
  } else {
    io.stdout(`\nRestored vectors: ${result.restoredIds.length}`);
    if (result.restoredIds.length > 0) {
      const ids = result.restoredIds.join(" ");
      io.stdout("After Vectorize exposes the mutations, plan:");
      io.stdout(`  npm run ops -- corpus backfill-similarity ${ids} --bucket ${opts.bucket} --vectorize ${vectorizeIndex}`);
      io.stdout("Then add --execute to write the similarity snapshots.");
    }
  }

  return result.problems.length > 0 ? 1 : 0;
}

export const corpusBackfillVectorsCommand: CommandDefinition<CorpusBackfillVectorsDeps> = {
  group: "corpus",
  name: "backfill-vectors",
  summary: "Restore missing Vectorize vectors from stored TL;DRs",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus backfill-vectors [rd_ID...] [options]

Eligible readings have a ready list row, a confirmed Vectorize miss, and a
valid ready manifest with a non-empty TL;DR. The parsed manifest supplies the
embedding input and metadata. The command never rewrites a manifest or list
row. Vectorize has no local store, so --local is rejected rather than touching
the remote index during an operation presented as local.

Plan is the default and makes no OpenAI request or external write. --execute
uses ${OPENAI_EMBEDDING_MODEL} and upserts 1536-dimensional vectors with url,
title, tldr, tags, and created_at metadata.

Run execute mode while the realtime writer is quiet. After Vectorize exposes
the new vectors, plan \`corpus backfill-similarity\` for the restored IDs, then
run that command with --execute.

Options:
  --limit <n>         Cap how many vectors are restored this pass.
  --bucket <name>     R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --tenant <selector>  REQUIRED: tenant id (usr_…) or 'global' for the pre-tenant layout.
  --vectorize <idx>   Vectorize index. Default: the bucket name.
  --execute           Embed and upsert the missing vectors.
  --help              Show this message.

Execute credentials (env or .corpus.vars/.dev.vars/.prd.vars): OPENAI_API_KEY,
CORPUS_VECTORIZE_ACCOUNT_ID / CORPUS_R2_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID,
and CORPUS_CF_API_TOKEN / CLOUDFLARE_API_TOKEN.`,
  defaultDeps: (io: CommandIo): CorpusBackfillVectorsDeps => ({
    io,
    r2: {
      readListIndex: async (d) =>
        (await (await import("../../corpus-lib/wrangler-r2")).readListIndex(d)) as VectorBackfillRow[],
      vectorExists: async (index, id) => (await import("../../corpus-lib/wrangler-r2")).vectorExists(index, id),
      readManifest: async (kp, d) => (await import("../../corpus-lib/wrangler-r2")).readManifest(kp, d),
    },
    makeWriters: async (vectorizeIndex, namespace) => {
      // Imports stay inside so plan mode and help never resolve credentials
      // or load client modules; the awaited call still fails a credential-less
      // execute before any read work happens.
      const { makeOpenAIEmbedClient } = await import("../../corpus-lib/batch/clients");
      const { makeVectorizeClient } = await import("../../lib/cf-clients");
      const { loadDotVars } = await import("../../lib/dotvars");
      const vars: Record<string, string | undefined> = {
        ...loadDotVars(".dev.vars"),
        ...loadDotVars(".prd.vars"),
        ...loadDotVars(".corpus.vars"),
        ...process.env,
      };
      const required = (names: string[]): string => {
        for (const name of names) {
          const value = vars[name];
          if (value) return value;
        }
        throw new Error(`missing execute credential: ${names.join(" or ")}`);
      };
      const openai = makeOpenAIEmbedClient({ fetch, apiKey: required(["OPENAI_API_KEY"]) });
      const vectorize = makeVectorizeClient({
        accountId: required(["CORPUS_VECTORIZE_ACCOUNT_ID", "CORPUS_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"]),
        apiToken: required(["CORPUS_CF_API_TOKEN", "CLOUDFLARE_API_TOKEN"]),
        index: vectorizeIndex,
        ...(namespace === undefined ? {} : { namespace }),
      });
      return {
        embedMany: (inputs) => openai.embedMany(inputs),
        upsert: async (vectors) => {
          await vectorize.upsert(vectors as never);
        },
      };
    },
  }),
  run: runCorpusBackfillVectors,
};
