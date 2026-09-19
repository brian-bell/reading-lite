// `ops corpus backfill-vectors` — repair ready readings whose durable
// Vectorize vector is absent. Embeds the stored manifest TL;DR and writes
// Vectorize; in R2 it reads manifests and the list index and writes exactly one
// object, the tier-1 run marker (below). Plan-first: a mode-less run resolves
// eligibility (list read + per-row Vectorize miss probe + manifest parse) but
// makes no OpenAI request and no external write; --execute embeds and upserts.
// --local is rejected outright: Vectorize has no local store, so a "local" run
// would mutate the real index.
//
// The run marker. Restoring a vector moves neighbourhoods without moving any
// row timestamp or the list ETag, which is exactly what `corpus
// refresh-neighbours --since-last-run` scopes from — so a restored vector would
// be invisible to every incremental pass until the next weekly sweep. Stamping
// `invalidated_by` on the marker makes the next pass sweep on its own, rather
// than on an operator remembering to pass --full.
//
// The stamp goes on BEFORE the first upsert, and a stamp that cannot be written
// stops the run before it spends anything. Crash-safety is the reason: a
// process killed between the upserts and a trailing stamp would leave vectors
// restored, no stamp, and no way for a re-run to notice (it would find the
// vectors already indexed and restore nothing). Stamping first can only ever
// cost a full sweep that was not strictly owed, which is the cheap direction.
// What it does NOT cover is a crash during a concurrent refresh pass: a pass
// that started after the opening stamp reads that same value, and if this run
// dies before the closing one it will clear it. That residual is what the
// refresh side's --sole-writer assertion is for.
//
// A run that restored something stamps a SECOND time when it is done, with a
// different value. Neither this command nor the refresh pass holds a lock on
// the marker, so a refresh that began after the opening stamp can sweep while
// vectors are still arriving and then clear the stamp; the closing one is a
// value that pass never saw, which is what makes it stand down instead. Every
// stamp carries this run's clock for the same reason — one run must never
// answer for another's.

import { runVectorBackfill, type VectorBackfillResult, type VectorBackfillRow } from "../../corpus-lib/backfill-vectors";
import {
  REFRESH_STATE_VERSION,
  parseRefreshState,
  type RefreshState,
} from "../../corpus-lib/refresh-scope";
import { OPENAI_EMBEDDING_MODEL } from "../../../src/modules/embeddings";
import { tenantVectorId } from "../../../src/modules/stores/similarity-store";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";
import { operatorTenantSelector, type OperatorTenant } from "../../corpus-lib/tenant";
import { operatorVectorLedger } from "../../account-lib/operator-ledger";
import type { VectorLedger } from "../../account-lib/vector-ledger";
import {
  BILLING_TENANT_FLAG_HELP,
  resolveBillingTenant,
  spendEnvironmentForBucket,
  withOperatorPaidFetch,
} from "../operator-spend";
import type { OpenOperatorSpend } from "../../system-lib/spend";

export interface CorpusBackfillVectorsDeps extends BaseDeps {
  r2: {
    readListIndex: (deps: R2Deps) => Promise<VectorBackfillRow[]>;
    vectorExists: (index: string, id: string, namespace?: string) => Promise<boolean>;
    readManifest: (keyPrefix: string, deps: R2Deps) => Promise<unknown>;
    /** The tier-1 run marker, unparsed; `null` only when confirmed absent. */
    readRefreshState: (deps: R2Deps) => Promise<unknown | null>;
    writeRefreshState: (state: unknown, deps: R2Deps) => Promise<void>;
  };
  // Execute-only: resolves credentials (throwing when absent, BEFORE any read
  // work) and returns the paid/write seams. Never called in plan mode. The
  // embedding client must send through `paidFetch`, the spend-admitted
  // transport; the raw `fetch` below is never handed to a provider client.
  makeWriters: (vectorizeIndex: string, namespace: string | undefined, paidFetch: typeof fetch) => Promise<{
    embedMany: (inputs: string[]) => Promise<{ embeddings: number[][] }>;
    upsert: (vectors: {
      id: string;
      values: number[];
      metadata?: Record<string, unknown>;
    }[]) => Promise<void>;
  }>;
  /** Stamps the run marker, so one run's invalidation is identifiably its own. */
  now: () => number;
  /** Execute-only: the session with the central spend authority. */
  openSpend: OpenOperatorSpend;
  /** The provider transport, reached only through the spend wrapper. */
  fetch: typeof fetch;
  /**
   * The durable vector-id ledger (issue #195 S3). Every id is recorded before
   * its upsert, so a vector this command restores stays addressable even if the
   * tenant's account wipe is already past its vectors phase — this writer has
   * never checked `users.status` and does not start now.
   *
   * Resolved per run rather than injected as a value, because the control plane
   * it writes to is a function of `--bucket` and it must be the no-op in plan
   * mode and for `--tenant global`.
   */
  makeLedger: (opts: { tenant: OperatorTenant; bucket: string; execute: boolean }) => VectorLedger;
}

interface Opts {
  only: string[];
  bucket: string;
  tenant?: string;
  billingTenant?: string;
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
    else if (arg === "--billing-tenant") opts.billingTenant = takeValue(arg, index++);
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
  const tenant = requireOperatorTenant(opts.tenant);
  const billingTenant = resolveBillingTenant(opts.billingTenant, { tenant, execute: opts.execute });
  if (!opts.execute) return backfill(opts, tenant, deps, undefined);
  return withOperatorPaidFetch(
    deps,
    { env: spendEnvironmentForBucket(opts.bucket), billingTenant, command: "corpus-backfill-vectors" },
    (paidFetch) => backfill(opts, tenant, deps, paidFetch),
  );
}

async function backfill(
  opts: Opts,
  tenant: OperatorTenant,
  deps: CorpusBackfillVectorsDeps,
  paidFetch: typeof fetch | undefined,
): Promise<number> {
  const { io, r2 } = deps;
  const vectorizeIndex = opts.vectorizeIndex ?? opts.bucket;
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
  // Resolved before the credential check so an unrecognised --bucket (which has
  // no known control plane) stops an EXECUTE before it embeds or upserts
  // anything. Plan mode is deliberately not stopped — `operatorVectorLedger`
  // returns the no-op before it looks the bucket up — so a plan can succeed
  // where the execute will refuse. `corpus seed-vector-ledger` refuses in both
  // modes instead, because writing rows is its whole purpose; here the ledger
  // is a side effect of a command that has plenty to say in plan mode without
  // a control plane.
  const ledger = deps.makeLedger({ tenant, bucket: opts.bucket, execute: opts.execute });
  // One clock read for both stamps, so a run is identifiable by it.
  const runAt = new Date(deps.now()).toISOString();
  if (paidFetch !== undefined) {
    // Awaited before any read so a missing credential fails the run up front,
    // matching the retired standalone script.
    ({ embedMany, upsert } = await deps.makeWriters(vectorizeIndex, tenant.namespace, paidFetch));
    // Before the first upsert, and fatal: an unstamped marker would let the
    // next incremental refresh scope narrowly around vectors it cannot see, and
    // nothing later in this run can put that right.
    if (!(await invalidateRefreshMarker(deps, r2Deps, `started ${runAt}`))) {
      io.stderr("    Nothing was embedded or upserted.");
      return 1;
    }
  }

  const result: VectorBackfillResult = await runVectorBackfill(
    {
      execute: opts.execute,
      only: opts.only,
      limit: opts.limit,
    },
    {
      readListIndex: async () => r2.readListIndex(r2Deps),
      vectorExists: (id) =>
        r2.vectorExists(vectorizeIndex, tenantVectorId(tenant.namespace, id), tenant.namespace),
      readManifest: (keyPrefix) => r2.readManifest(keyPrefix, r2Deps),
      embedMany,
      upsert: (async (vectors: {
        id: string;
        values: number[];
        metadata?: Record<string, unknown>;
      }[]) => {
        // Ledger BEFORE the upsert, on the BARE reading ids — the
        // `{tenantId}:{readingId}` composition is applied below and never
        // stored. A row for an upsert that then fails costs one redundant
        // `deleteByIds`; an upsert with no row is a vector nothing can address.
        await ledger.markLive(vectors.map((vector) => vector.id), deps.now());
        await upsert(vectors.map((vector) => ({
          ...vector,
          id: tenantVectorId(tenant.namespace, vector.id),
          ...(tenant.namespace === undefined
            ? {}
            : { metadata: { ...(vector.metadata ?? {}), tenant_id: tenant.namespace } }),
        })));
      }) as never,
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
      io.stdout(`  npm run ops -- corpus backfill-similarity --tenant ${operatorTenantSelector(tenant)} ${ids} --bucket ${opts.bucket} --vectorize ${vectorizeIndex}`);
      io.stdout("Then add --execute to write the similarity snapshots.");
    }
  }

  // A second stamp, after the last upsert, and only when something was actually
  // restored. The first one cannot cover a refresh pass that started between it
  // and these vectors landing: that pass would sweep without them and then
  // clear the stamp, which is why the closing stamp carries a different value —
  // the refresh pass compares what it read against what is there now, and a
  // stamp it has not seen makes it stand down.
  const closingFailed =
    opts.execute && result.restoredIds.length > 0
      ? !(await invalidateRefreshMarker(deps, r2Deps, `finished ${runAt}`))
      : false;
  if (closingFailed) {
    io.stderr("    Run `corpus refresh-neighbours --full` next: these vectors are already restored.");
  }

  return result.problems.length > 0 || closingFailed ? 1 : 0;
}

/**
 * Tells the tier-1 run marker that vectors are moving under it, stamping
 * `phase` (this run's clock, so the value is its own). Returns false only when
 * the marker is still standing and still says a narrower pass is safe, which is
 * the one state this command must not leave behind.
 *
 * An existing stamp IS overwritten: another run's stamp is another run's, and a
 * refresh pass answering that one would clear it and go on to miss this run's
 * vectors.
 *
 * Read-modify-write over an unconditional put, like every other writer of this
 * object — the R2 adapters offer no If-Match here. The window is one read and
 * one write, and `--sole-writer` on the refresh side is what an operator
 * asserts to keep the two commands from overlapping at all.
 */
async function invalidateRefreshMarker(
  deps: CorpusBackfillVectorsDeps,
  r2Deps: R2Deps,
  phase: string,
): Promise<boolean> {
  const { io, r2 } = deps;
  const stamp = `corpus backfill-vectors ${phase}`;
  let raw: unknown;
  try {
    raw = await r2.readRefreshState(r2Deps);
  } catch (error) {
    // A marker whose JSON does not parse is unusable, not unreachable — the
    // adapters parse inside the read — and an unusable marker already sweeps.
    // Blocking a repair command on a damaged marker, under a message about
    // credentials, would be the wrong failure for the wrong reason.
    if (error instanceof SyntaxError) {
      io.stdout("Run marker: unparseable — replacing it with a minimal invalidated one.");
      raw = null;
    } else {
      io.stderr(
        `  ! could not read the tier-1 run marker: ${error instanceof Error ? error.message : String(error)}`,
      );
      io.stderr("    Fix the R2 credential and re-run.");
      return false;
    }
  }
  const state = raw === null ? null : parseRefreshState(raw);
  // An absent or unusable marker makes the NEXT pass sweep on its own, but a
  // pass already running read that same absent marker, and nothing would stop
  // it from advancing afterwards and recording as covered a sweep these vectors
  // missed. So a stamp is written either way, on a minimal marker.
  //
  // Its `last_run_at` is the epoch and its `list_ids` empty on purpose: the
  // stamp already forces a sweep (changedSince checks it first), and those two
  // fields are what a scope would narrow on if the stamp ever went missing.
  // Epoch dates every row as changed and an empty id list claims no reading was
  // ever seen, so the worst a stripped stamp could do here is measure too much.
  const base: RefreshState = state ?? {
    version: REFRESH_STATE_VERSION,
    last_run_at: new Date(0).toISOString(),
    list_ids: [],
  };
  try {
    await r2.writeRefreshState({ ...base, invalidated_by: stamp }, r2Deps);
    io.stdout(`Run marker invalidated (${stamp}): the next refresh pass will sweep.`);
    return true;
  } catch (error) {
    io.stderr(
      `  ! could not invalidate the tier-1 run marker: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
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

An --execute run invalidates the tier-1 run marker at index/refresh-state.json
before its first upsert, so the next \`corpus refresh-neighbours\` pass sweeps
the whole corpus even under --since-last-run: a restored vector moves
neighbourhoods without moving any timestamp an incremental scope can read. That
is the one R2 object this command writes, and it needs an R2 write credential:
if the stamp cannot be written the run stops before embedding or upserting
anything. A run that turns out to have nothing to restore still costs one full
sweep, which is the cheap side of the trade.

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
  ${BILLING_TENANT_FLAG_HELP}
                      Default: --tenant. Required to --execute with --tenant global.
  --vectorize <idx>   Vectorize index. Default: the bucket name.
  --execute           Embed and upsert the missing vectors.
  --help              Show this message.

Execute credentials (env or .corpus.vars/.dev.vars/.prd.vars): OPENAI_API_KEY,
CORPUS_VECTORIZE_ACCOUNT_ID / CORPUS_R2_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID,
and CORPUS_CF_API_TOKEN / CLOUDFLARE_API_TOKEN.`,
  defaultDeps: (io: CommandIo): CorpusBackfillVectorsDeps => ({
    io,
    now: () => Date.now(),
    r2: {
      readListIndex: async (d) =>
        (await (await import("../../corpus-lib/wrangler-r2")).readListIndex(d)) as VectorBackfillRow[],
      vectorExists: async (index, id, namespace) =>
        (await import("../../corpus-lib/wrangler-r2")).vectorExists(index, id, { namespace }),
      readManifest: async (kp, d) => (await import("../../corpus-lib/wrangler-r2")).readManifest(kp, d),
      readRefreshState: async (d) =>
        (await import("../../corpus-lib/wrangler-r2")).readRefreshState(d),
      writeRefreshState: async (state, d) =>
        (await import("../../corpus-lib/wrangler-r2")).writeRefreshState(state, d),
    },
    openSpend: async (env) => (await import("../../system-lib/spend")).openRemoteOperatorSpend(env),
    fetch: (input, init) => globalThis.fetch(input, init),
    makeWriters: async (vectorizeIndex, namespace, paidFetch) => {
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
      const openai = makeOpenAIEmbedClient({ fetch: paidFetch, apiKey: required(["OPENAI_API_KEY"]) });
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
    makeLedger: (opts) => operatorVectorLedger(opts),
  }),
  run: runCorpusBackfillVectors,
};
