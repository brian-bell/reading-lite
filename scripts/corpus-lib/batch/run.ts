import type { ExtractedContent } from "../../../src/modules/extractor";
import type { R2Client, VectorizeClient } from "../../lib/cf-clients";
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
  assertExtractedBatchPayloadWithinLimit,
  assertSummarizeBatchPayloadWithinLimit,
  submitBatch,
  submitOpenAIBatch,
} from "./submit-phase";
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
} from "./types";
import type { ActivationResult } from "./activation-phase";
import type { OpenAIReasoningEffort } from "../../../src/modules/summarizer/types";
import { reconcileOpenAIPreSubmitSidecar } from "./openai-reconcile";

// Relative-key spelling only: keys built here are handed to a tenant-rooted
// client (withKeyRoot) or tenant-rooted R2Deps, which apply the operator's
// --tenant key root. This module never sees the root (s1k.4.3).
const layout = r2KeyLayout();

export interface BatchRunDeps {
  r2: R2Client;
  vectorize: VectorizeClient;
  batch?: AnthropicBatchClient;
  openaiBatch?: OpenAIBatchClient;
  embed: OpenAIEmbedClient;
  // Fresh extraction (browser UA) for readings without saved markdown.
  extract(url: string): Promise<ExtractedContent>;
  configuredProvider?: "openai" | "anthropic";
  model: string;
  reasoningEffort?: OpenAIReasoningEffort;
  newRunId?(): string;
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
}

export type BatchIdentity =
  | { provider: "anthropic"; model: string }
  | {
      provider: "openai";
      model: string;
      reasoningEffort: OpenAIReasoningEffort;
      runId: string;
    };

export interface BatchRunResult {
  report: WriteReportRow[];
  dropped: DroppedTarget[];
  resumed: boolean;
  batchId?: string;
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
        const report = await pollAndWriteOpenAI(existing, deps, openaiBatch);
        return {
          report,
          dropped: [],
          resumed: true,
          batchId: existing.batchId,
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
        const report = await pollAndWriteOpenAI(submitted, deps, openaiBatch);
        return {
          report,
          dropped: [],
          resumed: true,
          batchId: submitted.batchId,
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
    const report = await pollAndWrite(sidecar, deps, batch);
    return { report, dropped: [], resumed: true, batchId: sidecar.batchId };
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
    // Extracted-only preflight: an oversized run must fail here, before
    // resolveSimilar spends embedding quota and before any eager by-url claim.
    if (provider === "anthropic") {
      assertExtractedBatchPayloadWithinLimit(
        extracted,
        deps.model,
        deps.maxBatchBytes,
      );
    } else {
      prepareOpenAIBatchPayload(
        extracted.map((target) => ({
          extracted: target,
          similar: [],
          queryEmbedTokens: 0,
          // Size-check payload only: never written to a manifest.
          similarity: { count: 0, computed_at: deps.now() },
        })),
        deps.model,
        reasoningEffort,
        deps.maxBatchBytes === undefined
          ? undefined
          : { maxBytes: deps.maxBatchBytes },
      );
    }
  }

  let summarizeTargets = await resolveSimilar(extracted, {
    embedMany: (inputs) => deps.embed.embedMany(inputs),
    query: (vector, opts) => deps.vectorize.query(vector, opts),
    now: () => deps.now(),
  });

  if (deps.activateExtracted) {
    if (provider === "anthropic") {
      assertSummarizeBatchPayloadWithinLimit(
        summarizeTargets,
        deps.model,
        deps.maxBatchBytes,
      );
    } else {
      prepareOpenAIBatchPayload(
        summarizeTargets,
        deps.model,
        reasoningEffort,
        deps.maxBatchBytes === undefined
          ? undefined
          : { maxBytes: deps.maxBatchBytes },
      );
    }
    const activated = await deps.activateExtracted(extracted, identity);
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
      await deps.clearSidecar();
      log("No readings to summarize after batch activation.");
      return { report: activationSkipped, dropped, resumed: false };
    }
  }

  if (summarizeTargets.length === 0) {
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
    const { info, sidecar } = await submitOpenAIBatch(
      summarizeTargets,
      prepared,
      {
        model: deps.model,
        reasoningEffort,
        runId: runId!,
        batch: openaiBatch!,
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
      },
    );
    log(`Batch ${info.id} created; polling for completion...`);
    const report = await pollAndWriteOpenAI(sidecar, deps, openaiBatch!);
    return {
      report: [...activationSkipped, ...report],
      dropped,
      resumed: false,
      batchId: sidecar.batchId,
    };
  }

  log(`Submitting Message Batch: ${summarizeTargets.length} readings`);
  const { info, sidecar } = await submitBatch(summarizeTargets, {
    model: deps.model,
    batch: batch!,
    putObject: (key, body, contentType) => deps.r2.put(key, body, { contentType }),
    saveSidecar: deps.saveSidecar,
    ...(deps.maxBatchBytes === undefined ? {} : { maxBatchBytes: deps.maxBatchBytes }),
  });
  log(`Batch ${info.id} created; polling for completion...`);

  const report = await pollAndWrite(sidecar, deps, batch!);
  return { report: [...activationSkipped, ...report], dropped, resumed: false, batchId: sidecar.batchId };
}

// Recover path: resolve audit rows into targets (existing manifest authoritative)
// and re-extract any whose markdown isn't already captured, then run the pipeline.
// Eager by-url claim parity with fresh ingest: activateRecoverTargets flips each
// owner's slot to pending before batch submit (a failed→pending flip for an
// already-held slot), closing the in-flight race window (#71).
export async function runBatch(rows: AuditRow[], deps: BatchRunDeps): Promise<BatchRunResult> {
  return runBatchPipeline(
    async () => {
      const prepared = await prepareTargets(rows, {
        readManifest: (keyPrefix) => readManifest(deps.r2, keyPrefix),
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
): Promise<WriteReportRow[]> {
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
  return writeResults(sidecar, results, {
    r2: deps.r2,
    vectorize: deps.vectorize,
    embedMany: (inputs) => deps.embed.embedMany(inputs),
    now: deps.now,
    ...(deps.log ? { log: deps.log } : {}),
  });
}

async function pollAndWriteOpenAI(
  sidecar: OpenAISubmittedSidecar,
  deps: BatchRunDeps,
  batch: OpenAIBatchClient,
): Promise<WriteReportRow[]> {
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
  return writeOpenAIResults(
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
      ...(deps.log ? { log: deps.log } : {}),
    },
  );
}
