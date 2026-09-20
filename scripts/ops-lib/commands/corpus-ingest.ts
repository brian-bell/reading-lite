// `ops corpus ingest` — bulk-import a directory of fresh markdown files into
// the corpus, summarizing via the configured provider's Batch API instead of
// the realtime /api/readings queue.
//
// Plan-first: a mode-less run reads the directory, resolves by-url ownership
// (read-only R2 reads, degrading gracefully without credentials), and prints
// the disposition tally and what one batch would submit — no eager claims,
// batch creation, provider calls, or sidecar writes. --execute requires
// --sole-writer (enforced before any directory or credential work) and runs
// the existing fresh-markdown batch pipeline.

import { parseArgs } from "node:util";
import { resolveBatchConfig, type BatchConfig } from "../../corpus-lib/config";
import { operatorTenantSelector, type OperatorTenant } from "../../corpus-lib/tenant";
import { requireOperatorTenant } from "../tenant-flag";
import { MARKDOWN_IMPORT_MAX_BYTES } from "../../import-markdown-lib/parse";
import type { MarkdownArticle } from "../../import-markdown-lib/parse";
import { selectEligibleArticles } from "../../corpus-lib/ingest-eligible";
import { soleWriterGuard } from "../../corpus-lib/sole-writer";
import type { PersistedSidecar } from "../../corpus-lib/batch/types";
import type { BatchRunResult } from "../../corpus-lib/batch/run";
import type { FreshDisposition } from "../../corpus-lib/batch/prepare-fresh-markdown";
import { tallyDispositions } from "../../corpus-lib/batch/prepare-fresh-markdown";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import {
  BILLING_TENANT_FLAG_HELP,
  resolveBatchBillingTenant,
  spendEnvironmentForBucket,
  withOperatorPaidFetch,
  type OperatorPaidFetchDeps,
} from "../operator-spend";
import type { SpendRpc } from "../../../src/control-plane/paid-dispatch";

export interface FreshBatchResult extends BatchRunResult {
  dispositions: FreshDisposition[];
}

// What an execute run bills through (reading-lite-gh319.2): the embedding
// client's paid fetch, and the admission route for the batch itself.
export interface BatchPaidDeps {
  fetch: typeof fetch;
  spend: { tenantId: string; rpc: SpendRpc };
}

export interface CorpusIngestDeps extends BaseDeps, OperatorPaidFetchDeps {
  readMarkdownDir: (dir: string) => Promise<MarkdownArticle[]>;
  loadSidecar: (path: string) => Promise<PersistedSidecar | null>;
  clearSidecar: (path: string) => Promise<void>;
  resolveConfig: (flags: {
    bucket?: string;
    resumeProvider?: PersistedSidecar["provider"];
    tenant: OperatorTenant;
  }) => BatchConfig;
  // Plan-mode ownership check: read-only R2 reads + in-memory id minting.
  planOwnership: (
    eligible: MarkdownArticle[],
    cfg: BatchConfig,
  ) => Promise<{ dispositions: FreshDisposition[] }>;
  // Execute path: the whole fresh-markdown batch pipeline (clients + sidecar
  // seams wired in by defaultDeps).
  executeBatch: (
    eligible: MarkdownArticle[],
    cfg: BatchConfig,
    opts: { limit?: number; sidecar: string; paid: BatchPaidDeps },
  ) => Promise<FreshBatchResult>;
}

const DEFAULT_SIDECAR = "./corpus-ingest.batch.json";

interface Args {
  dir: string;
  tenant?: string;
  billingTenant?: string;
  execute: boolean;
  soleWriter: boolean;
  limit: number;
  bucket?: string;
  sidecar: string;
}

function parseIngestArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        dir: { type: "string" },
        tenant: { type: "string" },
        "billing-tenant": { type: "string" },
        execute: { type: "boolean", default: false },
        "sole-writer": { type: "boolean", default: false },
        limit: { type: "string" },
        bucket: { type: "string" },
        sidecar: { type: "string" },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (!values.dir) throw new UsageError("missing required --dir <path>");
  return {
    dir: values.dir,
    ...(values.tenant === undefined ? {} : { tenant: values.tenant }),
    ...(values["billing-tenant"] === undefined ? {} : { billingTenant: values["billing-tenant"] }),
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
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--limit "${raw}" is not a positive integer`);
  return n;
}

async function runCorpusIngest(argv: string[], deps: CorpusIngestDeps): Promise<number> {
  const args = parseIngestArgs(argv);
  const tenant = requireOperatorTenant(args.tenant);
  const { io } = deps;

  // Sole-writer preflight (issue #68): refuse a real submit unless the operator
  // asserts the realtime writer is paused/drained. Runs before any dir/cred/batch
  // work so an unacknowledged --execute fails loudly and immediately. A resume
  // (live sidecar) is gated too.
  const verdict = soleWriterGuard({ execute: args.execute, acknowledged: args.soleWriter, tool: "ops corpus ingest" });
  if (verdict.message) io.stderr(verdict.message);
  if (!verdict.proceed) return 2;

  // Load the in-flight batch marker BEFORE touching --dir. The sidecar already
  // carries every target needed to poll + write, so a resume must not depend on
  // the source markdown directory (see the resume rationale in the batch docs).
  const existing = await deps.loadSidecar(args.sidecar);

  // A sidecar records the tenant its batch was submitted under. Resuming it
  // with a different --tenant would poll the original provider batch and write
  // its terminal state into the newly selected namespace — refuse instead.
  // Legacy sidecars (no tenant field) were all written under the global layout.
  const selector = operatorTenantSelector(tenant);
  if (existing && (existing.tenant ?? "global") !== selector) {
    io.stderr(
      `sidecar ${args.sidecar} belongs to tenant '${existing.tenant ?? "global"}' but --tenant is '${selector}'; ` +
        "resume with the sidecar's tenant, or clear the sidecar after reconciling the batch manually.",
    );
    return 1;
  }
  const billingTenant = resolveBatchBillingTenant(args.billingTenant, {
    tenant,
    execute: args.execute,
    sidecar: existing,
  });

  const articles = existing ? [] : await deps.readMarkdownDir(args.dir);
  const { plan, oversized, eligible } = selectEligibleArticles(articles);

  if (!existing) {
    io.stderr(
      `Plan from ${args.dir}:\n` +
        `  files:          ${articles.length}\n` +
        `  selected:       ${plan.selected.length} (after de-dup by source URL)\n` +
        `  duplicate sets: ${plan.duplicateGroups.length}\n` +
        `  oversized:      ${oversized.length} (>${Math.round(MARKDOWN_IMPORT_MAX_BYTES / 1000)} KB, skipped)\n` +
        `  missing source: ${plan.missingSource.length} (skipped)\n` +
        `  eligible:       ${eligible.length}${
          Number.isFinite(args.limit) ? ` (submit capped to ${args.limit} by --limit)` : ""
        }\n`,
    );
  }

  // Creds are needed to read by-url ownership (plan) and to write (execute).
  // In plan mode we degrade gracefully without them so the local plan is still
  // previewable offline; execute requires them.
  let cfg: BatchConfig;
  try {
    cfg = deps.resolveConfig({
      ...(args.bucket === undefined ? {} : { bucket: args.bucket }),
      ...(existing === null ? {} : { resumeProvider: existing.provider }),
      tenant,
    });
  } catch (e) {
    if (args.execute) {
      io.stderr(e instanceof Error ? e.message : String(e));
      return 2;
    }
    io.stderr(
      existing
        ? `  [plan] would RESUME in-flight batch ${existing.batchId} (${existing.targets.length} readings) from ${args.sidecar}\n` +
            `  [plan] resume needs creds to poll + write — ${e instanceof Error ? e.message : String(e)}`
        : `  [plan] ownership check skipped — ${e instanceof Error ? e.message : String(e)}\n` +
            `  [plan] up to ${eligible.length} eligible reading(s) would be checked + submitted with creds`,
    );
    printSummary(io, { executed: false });
    return 0;
  }

  if (!args.execute) {
    if (existing) {
      io.stderr(
        `  [plan] would RESUME in-flight batch ${existing.batchId} (${existing.targets.length} readings) from ${args.sidecar}`,
      );
      printSummary(io, { executed: false });
      return 0;
    }
    const dryPlan = await deps.planOwnership(eligible, cfg);
    const tally = tallyDispositions(dryPlan.dispositions);
    const wouldSubmit = Number.isFinite(args.limit) ? Math.min(tally.toIngest, args.limit) : tally.toIngest;
    io.stderr(
      `  [plan] ownership check:\n` +
        `    already-ready (skip):    ${tally.skipReady}\n` +
        `    pending owner (skip):    ${tally.skipPending}\n` +
        `    initializing (skip):     ${tally.skipInitializing}\n` +
        `    occupied repair (skip):  ${tally.skipOccupiedNeedsRepair}\n` +
        `    failed owner (reingest): ${tally.ingestFailed}\n` +
        `    new (mint id):           ${tally.ingestNew}\n` +
        `  [plan] would submit ${wouldSubmit} reading(s) through one provider batch`,
    );
    printSummary(io, {
      executed: false,
      skipped_ready: tally.skipReady,
      skipped_pending: tally.skipPending,
      skipped_occupied_repair: tally.skipOccupiedNeedsRepair,
    });
    return 0;
  }

  const result = await withOperatorPaidFetch(
    deps,
    { env: spendEnvironmentForBucket(cfg.r2.bucket), billingTenant, command: "corpus-ingest" },
    (paidFetch, spend) =>
      deps.executeBatch(eligible, cfg, {
        ...(Number.isFinite(args.limit) ? { limit: args.limit } : {}),
        sidecar: args.sidecar,
        paid: { fetch: paidFetch, spend },
      }),
  );

  // The batch finished and results are written — the sidecar is no longer needed.
  await deps.clearSidecar(args.sidecar);

  const ready = result.report.filter((r) => r.status === "ready").length;
  const failed = result.report.filter((r) => r.status === "failed").length;
  const skipped = result.report.filter((r) => r.status === "skipped").length;
  const tally = tallyDispositions(result.dispositions);
  printSummary(io, {
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
  return failed > 0 ? 1 : 0;
}

// One JSON summary shape across plan and execute so the same field names mean
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

function printSummary(io: CommandIo, s: Partial<Summary> & { executed: boolean }): void {
  const full: Summary = {
    ready: 0,
    failed: 0,
    skipped: 0,
    skipped_ready: 0,
    skipped_pending: 0,
    skipped_occupied_repair: 0,
    ...s,
  };
  io.stdout(JSON.stringify(full, null, 2));
}

function defaultDeps(io: CommandIo): CorpusIngestDeps {
  return {
    io,
    openSpend: async (env) => (await import("../../system-lib/spend")).openRemoteOperatorSpend(env),
    fetch: globalThis.fetch,
    now: () => Date.now(),
    readMarkdownDir: async (dir) => (await import("../../import-markdown-lib/parse")).readMarkdownDir(dir),
    loadSidecar: async (p) => (await import("../../corpus-lib/batch/sidecar")).loadSidecar(p),
    clearSidecar: async (p) => (await import("../../corpus-lib/batch/sidecar")).clearSidecar(p),
    resolveConfig: (flags) => resolveBatchConfig(flags),
    planOwnership: async (eligible, cfg) => {
      const { makeR2Client, withKeyRoot } = await import("../../lib/cf-clients");
      const { prepareFreshMarkdown } = await import("../../corpus-lib/batch/prepare-fresh-markdown");
      const { newBatchAttemptId } = await import("../../corpus-lib/batch/run");
      const { r2ReadDeps } = await import("../../corpus-lib/batch/r2-reads");
      const { mintReadingId } = await import("../../../src/services");
      const r2 = withKeyRoot(makeR2Client(cfg.r2, globalThis.fetch), cfg.keyRoot);
      return prepareFreshMarkdown(eligible, {
        ...r2ReadDeps(r2),
        newId: mintReadingId,
        newAttemptId: newBatchAttemptId,
        now: () => new Date().toISOString(),
      });
    },
    executeBatch: async (eligible, cfg, opts) => {
      const { randomUUID } = await import("node:crypto");
      const { makeR2Client, makeVectorizeClient, withKeyRoot } = await import("../../lib/cf-clients");
      const { makeAnthropicBatchClient, makeOpenAIBatchClient, makeOpenAIEmbedClient } =
        await import("../../corpus-lib/batch/clients");
      const { clearSidecar, loadInputJsonl, loadSidecar, saveInputJsonl, saveSidecar } =
        await import("../../corpus-lib/batch/sidecar");
      const { runFreshMarkdownBatch } = await import("../../corpus-lib/batch/run-fresh-markdown");
      const { mintReadingId } = await import("../../../src/services");
      const fetchFn = globalThis.fetch;
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      return runFreshMarkdownBatch(eligible, {
        // Ledger every vector this batch writes (issue #195 S3). Resolved from
        // the run's own tenant and bucket; the no-op for --tenant global, which
        // no account wipe addresses.
        // So write-phase composes the ADR 0002 tenant-scoped vector id, like
        // every other writer. Undefined for --tenant global.
        ...(cfg.vectorize.namespace === undefined
          ? {}
          : { vectorNamespace: cfg.vectorize.namespace }),
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        r2: withKeyRoot(makeR2Client(cfg.r2, fetchFn), cfg.keyRoot),
        vectorize: makeVectorizeClient(cfg.vectorize, fetchFn),
        ...(cfg.anthropicApiKey
          ? { batch: makeAnthropicBatchClient({ fetch: fetchFn, apiKey: cfg.anthropicApiKey }) }
          : {}),
        openaiBatch: makeOpenAIBatchClient({ fetch: fetchFn, apiKey: cfg.openaiApiKey }),
        embed: makeOpenAIEmbedClient({ fetch: opts.paid.fetch, apiKey: cfg.openaiApiKey }),
        spend: opts.paid.spend,
        // The fresh-markdown path never fetches a URL; this is only here to satisfy
        // the shared BatchRunDeps shape and must never be called.
        extract: () => {
          throw new Error("corpus ingest must not fetch URLs — markdown is in hand");
        },
        configuredProvider: cfg.summarizerProvider,
        model: cfg.summarizerProvider === "openai" ? cfg.openaiModel : cfg.anthropicModel,
        reasoningEffort: cfg.openaiReasoningEffort,
        anthropicReasoningEffort: cfg.anthropicReasoningEffort,
        newRunId: randomUUID,
        newId: mintReadingId,
        now: () => new Date().toISOString(),
        sleep,
        loadSidecar: () => loadSidecar(opts.sidecar),
        // Stamp the tenant selector on every checkpoint so a resume can refuse
        // a mismatched --tenant (the sidecar guard in runCorpusIngest).
        saveSidecar: (s) => saveSidecar(opts.sidecar, { ...s, tenant: cfg.tenantSelector }),
        clearSidecar: () => clearSidecar(opts.sidecar),
        saveInputJsonl: (jsonl) => saveInputJsonl(opts.sidecar, jsonl),
        loadInputJsonl: () => loadInputJsonl(opts.sidecar),
        sidecarFilePath: opts.sidecar,
        log: (line) => io.stderr(line),
      });
    },
  };
}

export const corpusIngestCommand: CommandDefinition<CorpusIngestDeps> = {
  group: "corpus",
  name: "ingest",
  summary: "Bulk-ingest a fresh markdown directory through a provider Batch API",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus ingest --dir <path> [options]

Bulk-imports a directory of fresh markdown files into the corpus, summarizing via
the configured provider's Batch API (OpenAI by default; Anthropic remains
selectable, async, no realtime rate-limit retries) instead of the realtime
/api/readings queue. Plans by default.

Each file needs a source URL on a "**Source:** <url>" line. Files are deduped
by source URL (largest wins) and any over ${Math.round(MARKDOWN_IMPORT_MAX_BYTES / 1000)} KB are skipped.

Options:
  --dir <path>     Directory of .md files to ingest (required).
  --execute        Actually submit + write (otherwise prints the plan).
  --sole-writer    Required with --execute: assert the realtime writer is
                   paused/drained. Fresh ingest eagerly claims activated by-url
                   slots and releases its own failed eager claims. Run refuses
                   without the acknowledgment.
  --limit <n>      Cap how many readings to *submit*, applied after the ownership
                   check so skipped ready/pending owners don't consume the budget.
  --bucket <name>  R2 bucket to write to. Default: CORPUS_R2_BUCKET / reading-lite.
  --tenant <selector>  REQUIRED: tenant id (usr_…) or 'global' for the pre-tenant layout.
  ${BILLING_TENANT_FLAG_HELP}
                   Defaults to a usr_… --tenant; required with --tenant global.
                   A resume settles against the tenant its batch was admitted under.
  --sidecar <path> In-flight batch marker. Default: ${DEFAULT_SIDECAR}.
  --help           Show this message.

Idempotency: by-url ownership is read client-side — ready owners are skipped,
pending owners are skipped (a realtime submit may be in flight), failed owners
re-ingest in place, and unclaimed URLs mint a new reading. An existing sidecar
pins its provider/model/effort regardless of current SUMMARIZER_PROVIDER, and
there is no automatic provider fallback.

Spend: --execute admits the whole batch's maximum (the sum of every request's
synchronous price) against the billing tenant's and the global daily caps
before it claims anything or writes the sidecar, and settles actual usage once
the results are in. A refusal leaves nothing to reconcile. Embedding calls are
admitted per request.

Credentials (env or .corpus.vars/.dev.vars/.prd.vars): CORPUS_R2_* +
CORPUS_CF_API_TOKEN for R2/Vectorize and OPENAI_API_KEY for embeddings/default
OpenAI batches. ANTHROPIC_API_KEY is required only when starting or resuming an
Anthropic batch. Plan mode uses credentials to resolve ownership but degrades
to the local plan (no ready/pending skips shown) when they're absent.`,
  defaultDeps,
  run: runCorpusIngest,
};
