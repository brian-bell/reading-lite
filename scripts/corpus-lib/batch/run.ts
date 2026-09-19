import { randomUUID } from "node:crypto";
import type { ExtractedContent } from "../../../src/modules/extractor";
import type { R2Client, VectorizeClient, VectorizeMatch } from "../../lib/cf-clients";
import type { VectorLedger } from "../../../src/control-plane/vector-ledger";
import type {
  AnthropicBatchClient,
  OpenAIBatchClient,
  OpenAIEmbedClient,
  OpenAIBatchInfo,
} from "./clients";
import type { AuditRow } from "../types";
import { readManifest } from "./r2-reads";
import { prepareTargets } from "./prepare";
import { extractTargets } from "./extract-phase";
import { activateRecoverTargets } from "./activation-phase";
import { resolveSimilar } from "./similar-phase";
import {
  anthropicBatchRequests,
  assertExtractedBatchPayloadWithinLimit,
  assertSummarizeBatchPayloadWithinLimit,
  submitBatch,
  submitOpenAIBatch,
} from "./submit-phase";
import {
  admitBatchSpend,
  anthropicResultLines,
  boundAnthropicBatch,
  boundOpenAIBatch,
  cancelUnsentBatchSpend,
  openAIResultLines,
  settleBatchSpend,
  type BatchSpendIdentity,
  type BatchSpendOutcome,
} from "./spend";
import type { SpendRpc } from "../../../src/control-plane/paid-dispatch";
import { prepareOpenAIBatchPayload } from "./openai-payload";
import { pollUntilEnded } from "./poll-phase";
import { r2KeyLayout } from "../../../src/modules/stores/layout";
import {
  writeOpenAIResults,
  writeResults,
  type WriteReportRow,
} from "./write-phase";
import type {
  DroppedTarget,
  ExtractedTarget,
  OpenAISubmittedSidecar,
  PersistedSidecar,
  Sidecar,
  SummarizeTarget,
} from "./types";
import type { ActivationResult } from "./activation-phase";
import type {
  AnthropicReasoningEffort,
  OpenAIReasoningEffort,
} from "../../../src/modules/summarizer/types";
import { reconcileOpenAIPreSubmitSidecar } from "./openai-reconcile";

// Relative-key spelling only: keys built here are handed to a tenant-rooted
// client (withKeyRoot) or tenant-rooted R2Deps, which apply the operator's
// --tenant key root. This module never sees the root (s1k.4.3).
const layout = r2KeyLayout();

export interface BatchRunDeps {
  r2: R2Client;
  vectorize: VectorizeClient;
  // The durable vector-id ledger (issue #195 S3). Every id is recorded before
  // its vector is upserted, so a batch pass running against a tenant whose
  // account wipe is already past its vectors phase cannot leave a vector the
  // wipe can never address. Omitted for `--tenant global` and in tests, where
  // write-phase falls back to the no-op.
  ledger?: VectorLedger;
  /**
   * The tenant's Vectorize namespace, so write-phase can compose the ADR 0002
   * tenant-scoped vector id. Undefined for `--tenant global`. See
   * `WriteDeps.vectorNamespace` for the pre-existing bug this closes.
   */
  vectorNamespace?: string;
  batch?: AnthropicBatchClient;
  openaiBatch?: OpenAIBatchClient;
  embed: OpenAIEmbedClient;
  // Fresh extraction (browser UA) for readings without saved markdown.
  extract(url: string): Promise<ExtractedContent>;
  configuredProvider?: "openai" | "anthropic";
  model: string;
  reasoningEffort?: OpenAIReasoningEffort;
  anthropicReasoningEffort?: AnthropicReasoningEffort;
  newRunId?(): string;
  newAttemptId?(): string;
  now(): string;
  sleep(ms: number): Promise<void>;
  // Resume support: the sidecar persists the in-flight batch so a crashed poll
  // resumes without re-summarizing (cost-safe).
  loadSidecar(): Promise<PersistedSidecar | null>;
  saveSidecar(sidecar: PersistedSidecar): Promise<void>;
  clearSidecar(): Promise<void>;
  // Persist the exact input JSONL beside the sidecar. Required for OpenAI
  // resume (a crashed upload has no recoverable payload otherwise). For
  // Anthropic / non-pre-submit paths this is unused.
  saveInputJsonl?(jsonl: string): Promise<void>;
  // Resume support for OpenAI pre-submit sidecars: load the exact JSONL that
  // the failed upload was sending so a re-upload produces the same bytes.
  loadInputJsonl?(): Promise<string | null>;
  // Filesystem path of the sidecar. Used by the OpenAI reconciler to acquire
  // a create-window lock that serializes the list-then-create critical
  // section against concurrent resumes.
  sidecarFilePath?: string;
  // Override the reconciler's lock acquisition (tests inject a no-op).
  reconcileAcquireLock?: (path: string) => Promise<{ release(): Promise<void> }>;
  activateExtracted?(
    targets: ExtractedTarget[],
    identity: BatchIdentity,
  ): Promise<ActivationResult>;
  maxBatchBytes?: number;
  log?(line: string): void;
  poll?: { intervalMs?: number; maxPolls?: number };
  // The spend authority (reading-lite-gh319.2). A new batch is admitted
  // against `tenantId` before its first sidecar; results settle the operation
  // the sidecar recorded, whichever tenant this run names.
  spend: { tenantId: string; rpc: SpendRpc; newOpId?(): string };
}

export type BatchIdentity =
  | { provider: "anthropic"; model: string; spend?: BatchSpendIdentity }
  | {
      provider: "openai";
      model: string;
      reasoningEffort: OpenAIReasoningEffort;
      runId: string;
      spend?: BatchSpendIdentity;
    };

export interface BatchRunResult {
  report: WriteReportRow[];
  dropped: DroppedTarget[];
  resumed: boolean;
  batchId?: string;
  // Absent when no batch was submitted.
  spend?: BatchSpendOutcome;
}

// The front-end half of a bulk run: produce the extracted-and-in-hand targets to
// summarize (plus any rows dropped along the way). The recover path resolves
// these from audit rows + R2; the fresh-markdown path builds them from files.
export type ProduceExtracted = () => Promise<{
  extracted: ExtractedTarget[];
  dropped: DroppedTarget[];
}>;

// Orchestrate the shared bulk tail end-to-end:
//   resume? -> poll existing batch -> write
//   fresh  -> produce -> similar -> submit (+sidecar) -> poll -> write
// A live sidecar always means "resume" — we never recreate a batch, so a re-run
// after a crash can't double-bill the summarize step. `produce` runs only on a
// fresh run (after the resume check), so resuming never re-does the front-end.
export async function runBatchPipeline(
  produce: ProduceExtracted,
  deps: BatchRunDeps,
): Promise<BatchRunResult> {
  const log = deps.log ?? (() => {});

  const existing = await deps.loadSidecar();
  if (existing) {
    if (existing.provider === "openai") {
      if (existing.phase === "submitted") {
        const openaiBatch = requireOpenAIBatchClient(deps, "resume pinned sidecar");
        log(`Resuming OpenAI batch ${existing.batchId} (${existing.targets.length} readings)`);
        const { report, spend } = await pollAndWriteOpenAI(existing, deps, openaiBatch);
        return {
          report,
          dropped: [],
          resumed: true,
          batchId: existing.batchId,
          spend,
        };
      }
      if (
        existing.phase === "uploading" ||
        existing.phase === "creating"
      ) {
        const openaiBatch = requireOpenAIBatchClient(deps, "resume pinned sidecar");
        // Pre-submit sidecar — auto-reconcile against OpenAI list APIs so a
        // crashed upload/create window doesn't require manual console cleanup.
        // The reconciler lists remote files/batches by run id before any
        // non-idempotent call, so a resumed run never double-bills.
        const submitted = await reconcileOpenAIPreSubmitSidecar(existing, {
          batch: openaiBatch,
          saveSidecar: deps.saveSidecar,
          loadSidecar: deps.loadSidecar,
          ...(deps.loadInputJsonl ? { loadInputJsonl: deps.loadInputJsonl } : {}),
          ...(deps.sidecarFilePath ? { sidecarFilePath: deps.sidecarFilePath } : {}),
          ...(deps.reconcileAcquireLock ? { acquireLock: deps.reconcileAcquireLock } : {}),
          log,
        });
        const { report, spend } = await pollAndWriteOpenAI(submitted, deps, openaiBatch);
        return {
          report,
          dropped: [],
          resumed: true,
          batchId: submitted.batchId,
          spend,
        };
      }
      // OpenAI `activating` (no remote object) keeps the manual reconcile path.
      throw noIdReconciliationError(existing);
    }
    // Anthropic: an empty batchId still aborts; we have no remote-tagged
    // identity to adopt.
    if (!existing.batchId) {
      throw noIdReconciliationError(existing);
    }
    const batch = requireAnthropicBatchClient(deps, "resume pinned sidecar");
    const sidecar = existing as Sidecar;
    log(`Resuming batch ${sidecar.batchId} (${sidecar.targets.length} readings)`);
    const { report, spend } = await pollAndWrite(sidecar, deps, batch);
    return { report, dropped: [], resumed: true, batchId: sidecar.batchId, spend };
  }

  const provider = deps.configuredProvider ?? "anthropic";
  const batch =
    provider === "anthropic"
      ? requireAnthropicBatchClient(deps, "start new batch")
      : undefined;
  const openaiBatch =
    provider === "openai"
      ? requireOpenAIBatchClient(deps, "start new batch")
      : undefined;
  const reasoningEffort = deps.reasoningEffort ?? "low";
  const anthropicEffort = deps.anthropicReasoningEffort ?? "low";
  const runId =
    provider === "openai"
      ? (deps.newRunId?.() ?? `run_${Date.now()}`)
      : undefined;
  const identity: BatchIdentity =
    provider === "openai"
      ? {
          provider,
          model: deps.model,
          reasoningEffort,
          runId: runId!,
        }
      : { provider, model: deps.model };

  let { extracted, dropped } = await produce();
  // Surface *why* each reading dropped — a bare "dropped: N" count hides dead
  // origins, missing manifests, etc., leaving the operator no thread to pull.
  for (const d of dropped) {
    log(`  dropped ${d.readingId}: ${d.reason}`);
  }

  let activationSkipped: WriteReportRow[] = [];
  if (deps.activateExtracted) {
    // Extracted-only preflight: an oversized run, or one the price catalog
    // cannot bound (reading-lite-gh319.2), must fail here, before
    // resolveSimilar spends embedding quota and before any eager by-url claim.
    const preflight = extracted.map((target) => ({
      extracted: target,
      similar: [],
      queryEmbedTokens: 0,
      // Preflight payload only: never written to a manifest.
      similarity: { count: 0, computed_at: deps.now() },
    }));
    if (provider === "anthropic") {
      assertExtractedBatchPayloadWithinLimit(
        extracted,
        deps.model,
        anthropicEffort,
        deps.maxBatchBytes,
      );
      if (extracted.length > 0) {
        await boundAnthropicBatch(
          anthropicBatchRequests(preflight, deps.model, anthropicEffort),
          deps.model,
        );
      }
    } else {
      const prepared = prepareOpenAIBatchPayload(
        preflight,
        deps.model,
        reasoningEffort,
        deps.maxBatchBytes === undefined
          ? undefined
          : { maxBytes: deps.maxBatchBytes },
      );
      if (extracted.length > 0) await boundOpenAIBatch(prepared.jsonl, deps.model);
    }
  }

  let summarizeTargets = await resolveSimilar(extracted, {
    embedMany: (inputs) => deps.embed.embedMany(inputs),
    query: async (vector, opts) => stripNamespace(
      await deps.vectorize.query(vector, opts),
      deps.vectorNamespace,
    ),
    now: () => deps.now(),
  });

  // Admit the batch before anything is claimed or written (reading-lite-
  // gh319.2): a refusal leaves no sidecar and no pending manifest, so a rerun
  // starts clean. Activation can only drop requests from the admitted set, so
  // its maximum still bounds the batch that is created.
  const spend =
    summarizeTargets.length === 0
      ? undefined
      : await admitBatch(summarizeTargets, provider, deps, {
          reasoningEffort,
          anthropicEffort,
          log,
        });
  const spendDeps = { rpc: deps.spend.rpc, log };
  // Until the provider create is attempted no batch can exist, so a failure
  // settles the operation at zero. Once create is attempted the batch may
  // exist and be billed, so the maximum stays held for reconciliation.
  let createAttempted = false;
  const settleUnsent = async () => {
    if (spend && !createAttempted) await cancelUnsentBatchSpend(spend, spendDeps);
  };

  let submitted:
    | { provider: "openai"; sidecar: OpenAISubmittedSidecar }
    | { provider: "anthropic"; sidecar: Sidecar };
  try {
    if (deps.activateExtracted) {
      const activated = await deps.activateExtracted(
        extracted,
        spend ? { ...identity, spend } : identity,
      );
      extracted = activated.activated;
      activationSkipped = activated.skipped;
      for (const row of activationSkipped) {
        log(`  skipped ${row.id}: ${row.reason ?? "batch activation skipped"}`);
      }

      const activatedByKey = new Map(
        extracted.map((target) => [extractedTargetKey(target), target]),
      );
      summarizeTargets = summarizeTargets
        .filter((target) => activatedByKey.has(extractedTargetKey(target.extracted)))
        .map((target) => ({
          ...target,
          extracted: activatedByKey.get(extractedTargetKey(target.extracted))!,
        }));

      if (extracted.length === 0) {
        await settleUnsent();
        await deps.clearSidecar();
        log("No readings to summarize after batch activation.");
        return { report: activationSkipped, dropped, resumed: false };
      }
    }

    if (summarizeTargets.length === 0) {
      await settleUnsent();
      log("No readings to summarize after extraction.");
      return { report: activationSkipped, dropped, resumed: false };
    }

    if (provider === "openai") {
      const prepared = prepareOpenAIBatchPayload(
        summarizeTargets,
        deps.model,
        reasoningEffort,
        deps.maxBatchBytes === undefined
          ? undefined
          : { maxBytes: deps.maxBatchBytes },
      );
      log(`Submitting OpenAI Batch: ${summarizeTargets.length} readings`);
      const client = openaiBatch!;
      const { info, sidecar } = await submitOpenAIBatch(
        summarizeTargets,
        prepared,
        {
          model: deps.model,
          reasoningEffort,
          runId: runId!,
          batch: {
            ...client,
            create: (inputFileId, batchRunId) => {
              createAttempted = true;
              return client.create(inputFileId, batchRunId);
            },
          },
          putObject: (key, body, contentType) =>
            deps.r2.put(key, body, { contentType }),
          saveInputJsonl: deps.saveInputJsonl ?? (() => {
            // OpenAI resume depends on the companion JSONL; if a caller wires
            // an OpenAI provider without one, fail loudly here rather than
            // silently lose the upload bytes on the next crash.
            throw new Error(
              "OpenAI submission requires a saveInputJsonl helper on BatchRunDeps",
            );
          }),
          saveSidecar: deps.saveSidecar,
          loadSidecar: deps.loadSidecar,
          ...(deps.sidecarFilePath ? { sidecarFilePath: deps.sidecarFilePath } : {}),
          ...(deps.reconcileAcquireLock ? { acquireLock: deps.reconcileAcquireLock } : {}),
          ...(spend ? { spend } : {}),
        },
      );
      log(`Batch ${info.id} created; polling for completion...`);
      submitted = { provider: "openai", sidecar };
    } else {
      log(`Submitting Message Batch: ${summarizeTargets.length} readings`);
      const client = batch!;
      const { info, sidecar } = await submitBatch(summarizeTargets, {
        model: deps.model,
        effort: anthropicEffort,
        batch: {
          ...client,
          create: (requests) => {
            createAttempted = true;
            return client.create(requests);
          },
        },
        putObject: (key, body, contentType) => deps.r2.put(key, body, { contentType }),
        saveSidecar: deps.saveSidecar,
        ...(deps.maxBatchBytes === undefined ? {} : { maxBatchBytes: deps.maxBatchBytes }),
        ...(spend ? { spend } : {}),
      });
      log(`Batch ${info.id} created; polling for completion...`);
      submitted = { provider: "anthropic", sidecar };
    }
  } catch (error) {
    await settleUnsent();
    throw error;
  }

  const polled =
    submitted.provider === "openai"
      ? await pollAndWriteOpenAI(submitted.sidecar, deps, openaiBatch!)
      : await pollAndWrite(submitted.sidecar, deps, batch!);
  return {
    report: [...activationSkipped, ...polled.report],
    dropped,
    resumed: false,
    batchId: submitted.sidecar.batchId,
    spend: polled.spend,
  };
}

// The size preflight doubles as the bound: the exact payload submit would
// send is what gets quoted, and an oversized batch fails before reserving.
async function admitBatch(
  targets: SummarizeTarget[],
  provider: "openai" | "anthropic",
  deps: BatchRunDeps,
  opts: {
    reasoningEffort: OpenAIReasoningEffort;
    anthropicEffort: AnthropicReasoningEffort;
    log: (line: string) => void;
  },
): Promise<BatchSpendIdentity> {
  let bound;
  if (provider === "openai") {
    const prepared = prepareOpenAIBatchPayload(
      targets,
      deps.model,
      opts.reasoningEffort,
      deps.maxBatchBytes === undefined ? undefined : { maxBytes: deps.maxBatchBytes },
    );
    bound = await boundOpenAIBatch(prepared.jsonl, deps.model);
  } else {
    assertSummarizeBatchPayloadWithinLimit(
      targets,
      deps.model,
      opts.anthropicEffort,
      deps.maxBatchBytes,
    );
    bound = await boundAnthropicBatch(
      anthropicBatchRequests(targets, deps.model, opts.anthropicEffort),
      deps.model,
    );
  }
  return admitBatchSpend(bound, {
    tenantId: deps.spend.tenantId,
    rpc: deps.spend.rpc,
    nowMs: Date.parse(deps.now()),
    opId: `operator:${provider}-batch:${deps.spend.newOpId?.() ?? randomUUID()}`,
    log: opts.log,
  });
}

// Recover path: resolve audit rows into targets (existing manifest authoritative)
// and re-extract any whose markdown isn't already captured, then run the pipeline.
// Eager by-url claim parity with fresh ingest: activateRecoverTargets flips each
// owner's slot to pending before batch submit (a failed→pending flip for an
// already-held slot), closing the in-flight race window (#71).
/**
 * Return neighbour matches under BARE reading ids.
 *
 * `SimilarityStore.query` in the Worker strips its own `{tenant}:` prefix so
 * callers only ever see reading ids; `makeVectorizeClient.query` does not, and
 * the batch pipeline consumes matches directly. That divergence was invisible
 * while this pipeline wrote bare ids — and it stopped being invisible the
 * moment `write-phase` started composing them, because the pipeline then reads
 * back its own prefixed writes.
 *
 * Two things go wrong without this, and neither is loud. `excludeSelf` compares
 * the bare reading id against a prefixed match, so a re-ingested reading no
 * longer excludes itself and spends a neighbour slot on itself at score ~1.0.
 * And the ids flow onward into `similarity` and `connections` on the manifest
 * this pipeline writes, where the read path and the SPA expect bare reading
 * ids.
 */
function stripNamespace(
  matches: VectorizeMatch[],
  namespace: string | undefined,
): VectorizeMatch[] {
  if (namespace === undefined) return matches;
  const prefix = `${namespace}:`;
  return matches.map((m) =>
    m.id.startsWith(prefix) ? { ...m, id: m.id.slice(prefix.length) } : m,
  );
}

export async function runBatch(rows: AuditRow[], deps: BatchRunDeps): Promise<BatchRunResult> {
  return runBatchPipeline(
    async () => {
      const prepared = await prepareTargets(rows, {
        readManifest: (keyPrefix) => readManifest(deps.r2, keyPrefix),
        newAttemptId: deps.newAttemptId ?? newBatchAttemptId,
        now: deps.now,
      });
      const extracted = await extractTargets(prepared.targets, {
        loadExtracted: (kp) => deps.r2.get(layout.extractedKey(kp)),
        extract: deps.extract,
      });
      return {
        extracted: extracted.extracted,
        dropped: [...prepared.dropped, ...extracted.dropped],
      };
    },
    {
      ...deps,
      activateExtracted:
        deps.activateExtracted ??
        ((targets, identity) =>
          activateRecoverTargets(targets, {
            r2: deps.r2,
            identity,
            now: deps.now,
            saveSidecar: deps.saveSidecar,
            ...(deps.log ? { log: deps.log } : {}),
          })),
    },
  );
}

export function newBatchAttemptId(): string {
  return `batch_${randomUUID()}`;
}

function noIdReconciliationError(existing: PersistedSidecar): Error {
  const provider = existing.provider === "openai" ? "OpenAI" : "Anthropic";
  const detail =
    existing.phase === "activating"
      ? "eager ownership activation may be incomplete"
      : existing.phase === "uploading"
        ? "an input file may have been uploaded without its id being recorded"
        : "a batch may have been created and billed without its id being recorded";
  return new Error(
    `found a ${provider} ${existing.phase} sidecar with no batch id; ${detail}. ` +
      `Reconcile that provider's console, then delete the .batch.json sidecar before retrying.`,
  );
}

function extractedTargetKey(target: ExtractedTarget): string {
  return `${target.target.readingId}\0${target.target.keyPrefix}`;
}

function requireAnthropicBatchClient(
  deps: BatchRunDeps,
  action: string,
): AnthropicBatchClient {
  if (deps.batch) return deps.batch;
  throw new Error(
    `cannot ${action}: missing Anthropic batch credentials (ANTHROPIC_API_KEY)`,
  );
}

function requireOpenAIBatchClient(
  deps: BatchRunDeps,
  action: string,
): OpenAIBatchClient {
  if (deps.openaiBatch) return deps.openaiBatch;
  throw new Error(
    `cannot ${action}: missing OpenAI batch credentials (OPENAI_API_KEY)`,
  );
}

async function pollAndWrite(
  sidecar: Sidecar,
  deps: BatchRunDeps,
  batch: AnthropicBatchClient,
): Promise<{ report: WriteReportRow[]; spend: BatchSpendOutcome }> {
  const ended = await pollUntilEnded(sidecar.batchId, {
    batch,
    sleep: deps.sleep,
    ...(deps.poll?.intervalMs === undefined ? {} : { intervalMs: deps.poll.intervalMs }),
    ...(deps.poll?.maxPolls === undefined ? {} : { maxPolls: deps.poll.maxPolls }),
    ...(deps.log ? { log: deps.log } : {}),
  });
  if (!ended.results_url) {
    throw new Error(`batch ${sidecar.batchId} ended without a results_url`);
  }
  const results = await batch.results(ended.results_url);
  const spend = await settleBatchSpend(sidecar, anthropicResultLines(results), settleDeps(deps));
  const report = await writeResults(sidecar, results, {
    r2: deps.r2,
    vectorize: deps.vectorize,
    embedMany: (inputs) => deps.embed.embedMany(inputs),
    now: deps.now,
    ...(deps.ledger ? { ledger: deps.ledger } : {}),
    ...(deps.vectorNamespace === undefined ? {} : { vectorNamespace: deps.vectorNamespace }),
    ...(deps.log ? { log: deps.log } : {}),
  });
  return { report, spend };
}

function settleDeps(deps: BatchRunDeps) {
  return { rpc: deps.spend.rpc, ...(deps.log ? { log: deps.log } : {}) };
}

async function pollAndWriteOpenAI(
  sidecar: OpenAISubmittedSidecar,
  deps: BatchRunDeps,
  batch: OpenAIBatchClient,
): Promise<{ report: WriteReportRow[]; spend: BatchSpendOutcome }> {
  const terminal = new Set([
    "completed",
    "failed",
    "expired",
    "cancelled",
    "canceled",
  ]);
  const intervalMs = deps.poll?.intervalMs ?? 15_000;
  const maxPolls = deps.poll?.maxPolls ?? 10_000;
  let info: OpenAIBatchInfo | undefined;
  for (let poll = 0; poll < maxPolls; poll++) {
    info = await batch.get(sidecar.batchId);
    deps.log?.(
      `Batch ${sidecar.batchId}: ${info.status} ` +
        `(${info.request_counts.completed}/${info.request_counts.total} completed, ` +
        `${info.request_counts.failed} failed)`,
    );
    if (terminal.has(info.status)) break;
    await deps.sleep(intervalMs);
  }
  if (!info || !terminal.has(info.status)) {
    throw new Error(
      `OpenAI batch ${sidecar.batchId} did not reach a terminal state before the poll limit`,
    );
  }
  // Fetch every available terminal file before writing anything. If either
  // download fails, the submitted sidecar remains intact for a clean resume and
  // no subset of the corpus has been terminal-written.
  const output = info.output_file_id
    ? await batch.content(info.output_file_id)
    : undefined;
  const errors = info.error_file_id
    ? await batch.content(info.error_file_id)
    : undefined;
  const spend = await settleBatchSpend(
    sidecar,
    openAIResultLines(`${output ?? ""}\n${errors ?? ""}`),
    settleDeps(deps),
  );
  const report = await writeOpenAIResults(
    {
      ...sidecar,
      processingStatus: info.status,
      outputFileId: info.output_file_id,
      errorFileId: info.error_file_id,
    },
    {
      ...(output === undefined ? {} : { outputJsonl: output }),
      ...(errors === undefined ? {} : { errorJsonl: errors }),
      batchStatus: info.status,
    },
    {
      r2: deps.r2,
      vectorize: deps.vectorize,
      embedMany: (inputs) => deps.embed.embedMany(inputs),
      now: deps.now,
      ...(deps.ledger ? { ledger: deps.ledger } : {}),
      ...(deps.vectorNamespace === undefined ? {} : { vectorNamespace: deps.vectorNamespace }),
      ...(deps.log ? { log: deps.log } : {}),
    },
  );
  return { report, spend };
}
