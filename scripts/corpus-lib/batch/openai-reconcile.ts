import type { OpenAIBatchClient, OpenAIBatchInfo } from "./clients";
import { assertResponsesBatchShape } from "./clients";
import type {
  OpenAICreatingSidecar,
  OpenAISubmittedSidecar,
  OpenAIUploadingSidecar,
  PersistedSidecar,
} from "./types";
import { acquireReconcileLock, type ReconcileLock } from "./reconcile-lock";

// Cost-safe resume of a pre-submit OpenAI sidecar (`phase: uploading` or
// `creating`, `batchId: ""`). On resume we adopt remote objects when the
// list-then-match finds them. The expensive `create` step is fail-closed:
// if no remote batch is visible, we abort rather than risk double-billing.
//
// Why fail-closed on create: the OpenAI Batch API has no idempotency key.
// A create that succeeds server-side but loses its response (crash,
// timeout) cannot be distinguished from a create that failed before
// reaching OpenAI. A list call right after may temporarily miss the new
// batch (visibility lag). Re-creating in that window would double-bill.
// The reconciler therefore refuses to create from a `creating` or
// `uploading`-after-no-remote-file sidecar when the list is empty, and
// asks the operator to resolve manually.
//
// Concurrency model: the sidecar-scoped file lock (`acquireReconcileLock`)
// serializes the entire reconcile path against concurrent resumes:
//   1. `--sole-writer` at the CLI layer (`scripts/corpus-lib/sole-writer.ts`),
//      an operator acknowledgement that the realtime writer is paused.
//   2. The file lock prevents two concurrent resumes from both adopting
//      or both uploading. A second resume fails to acquire and aborts.
//   3. The lock is held for the entire reconcile path (uploading through
//      creating checkpoint), so even long pauses don't race a new holder.

export interface ReconcileDeps {
  batch: OpenAIBatchClient;
  saveSidecar(sidecar: PersistedSidecar): Promise<void>;
  // Exact JSONL bytes persisted beside the sidecar before the "uploading"
  // checkpoint. Required when phase=uploading and no remote file matches.
  loadInputJsonl?(): Promise<string | null>;
  log?(line: string): void;
  // Sidecar-scoped file lock used to serialize the list-then-create window.
  // If not provided, the reconciler falls back to `acquireReconcileLock`
  // deriving the path from `sidecarFilePath`. Provide this in tests.
  acquireLock?: (sidecarPath: string) => Promise<ReconcileLock>;
  sidecarFilePath?: string;
}

const BATCH_LIST_PAGE_CAP = 20;

const INPUT_FILENAME = (runId: string) => `reading-lite-${runId}.jsonl`;

export async function reconcileOpenAIPreSubmitSidecar(
existing: OpenAIUploadingSidecar | OpenAICreatingSidecar,
  deps: ReconcileDeps,
): Promise<OpenAISubmittedSidecar> {
  const log = deps.log ?? (() => {});
  const runId = existing.runId;
  if (!runId) {
    throw new Error(
      "OpenAI pre-submit sidecar is missing runId; cannot reconcile",
    );
  }

  // Serialize the entire reconcile path against concurrent resumes.
  const lock = await acquireCreateLock(deps);
  try {
    if (existing.phase === "creating") {
      return await reconcileCreatingPhase(existing, deps, log);
    }
    return await reconcileUploadingPhase(existing, deps, log);
  } finally {
    await lock.release();
  }
}

async function reconcileCreatingPhase(
  existing: OpenAICreatingSidecar,
  deps: ReconcileDeps,
  log: (line: string) => void,
): Promise<OpenAISubmittedSidecar> {
  const { runId } = existing;
  log(`Reconciling OpenAI creating sidecar run_id=${runId}`);
  const remote = await findBatchesByRunId(deps.batch, runId);
  if (remote.length === 1) {
    const match = assertResponsesBatchShape(remote[0]!.raw, {
      id: remote[0]!.info.id,
      runId,
    });
    if (
      match.input_file_id &&
      match.input_file_id !== existing.inputFileId
    ) {
      throw new Error(
        `OpenAI run ${runId}: remote batch ${match.id} uses input_file_id=${match.input_file_id} ` +
          `but sidecar records ${existing.inputFileId}; refusing to adopt a foreign batch`,
      );
    }
    const submitted = submittedSidecarFrom(existing, match, existing.inputFileId);
    await deps.saveSidecar(submitted);
    log(`Found remote batch ${match.id}; adopting (no create)`);
    return submitted;
  }
  if (remote.length > 1) {
    throw ambiguousBatchesError(runId, remote.map((m) => m.info));
  }
  // Fail closed: do not create from a `creating` sidecar without a visible
  // remote batch. Visibility lag could hide a successful prior create.
  throw new Error(
    `OpenAI run ${runId}: creating sidecar with no remote batch visible. ` +
      `Refusing to create a second batch — the prior create may have succeeded ` +
      `but its response was lost. Reconcile the in-flight batch in the OpenAI ` +
      `dashboard (look for metadata.run_id=${runId}), then delete the sidecar ` +
      `and re-run.`,
  );
}

async function reconcileUploadingPhase(
  existing: OpenAIUploadingSidecar,
  deps: ReconcileDeps,
  log: (line: string) => void,
): Promise<OpenAISubmittedSidecar> {
  const { runId } = existing;
  log(`Reconciling OpenAI uploading sidecar run_id=${runId}`);
  const files = await findFilesByRunId(deps.batch, runId);
  if (files.length > 1) {
    throw ambiguousFilesError(runId, files);
  }
  let inputFileId: string;
  if (files.length === 1) {
    inputFileId = files[0]!.id;
    log(`Found remote input file ${inputFileId}; adopting`);
  } else {
    if (!deps.loadInputJsonl) {
      throw new Error(
        `OpenAI run ${runId}: no remote input file and no loadInputJsonl helper; ` +
          `cannot safely re-upload without exact bytes`,
      );
    }
    const jsonl = await deps.loadInputJsonl();
    if (jsonl === null) {
      throw new Error(
        `OpenAI run ${runId}: no remote input file and the persisted `.concat(
          `input JSONL is missing; refusing to re-upload without exact bytes. `,
          `Delete the sidecar and re-run the batch from scratch.`,
        ),
      );
    }
    const uploaded = await deps.batch.upload(jsonl, runId);
    inputFileId = uploaded.id;
    log(`No remote input file; re-uploading persisted JSONL -> ${inputFileId}`);
  }
  // Advance to "creating" so the next resume lands on the creating branch.
  const creatingCheckpoint: OpenAICreatingSidecar = {
    ...existing,
    phase: "creating",
    inputFileId,
    processingStatus: "creating",
  };
  await deps.saveSidecar(creatingCheckpoint);

  // Now look for a remote batch. If found, adopt it; if not, fail closed
  // (visibility lag could hide a successful prior create).
  const remote = await findBatchesByRunId(deps.batch, runId);
  if (remote.length === 1) {
    const match = assertResponsesBatchShape(remote[0]!.raw, {
      id: remote[0]!.info.id,
      runId,
    });
    if (match.input_file_id && match.input_file_id !== inputFileId) {
      throw new Error(
        `OpenAI run ${runId}: remote batch ${match.id} uses input_file_id=${match.input_file_id} ` +
          `but reconciled input is ${inputFileId}; refusing to adopt a foreign batch`,
      );
    }
    const submitted = submittedSidecarFrom(existing, match, inputFileId);
    await deps.saveSidecar(submitted);
    log(`Found remote batch ${match.id}; adopting (no create)`);
    return submitted;
  }
  if (remote.length > 1) {
    throw ambiguousBatchesError(runId, remote.map((m) => m.info));
  }
  throw new Error(
    `OpenAI run ${runId}: uploading sidecar reached the create step but no remote ` +
      `batch is visible. Refusing to create a second batch — the prior create may ` +
      `have succeeded but its response was lost. Reconcile the in-flight batch in the ` +
      `OpenAI dashboard (look for metadata.run_id=${runId}), then delete the sidecar ` +
      `and re-run.`,
  );
}

async function findFilesByRunId(
  batch: OpenAIBatchClient,
  runId: string,
): Promise<Array<{ id: string; filename: string }>> {
  const matches: Array<{ id: string; filename: string }> = [];
  const filename = INPUT_FILENAME(runId);
  let after: string | undefined;
  for (let i = 0; i < BATCH_LIST_PAGE_CAP; i++) {
    const page = await batch.listFiles({ purpose: "batch", after, limit: 100 });
    for (const f of page.data) {
      if (f.filename === filename && f.purpose === "batch") {
        matches.push({ id: f.id, filename: f.filename });
      }
    }
    if (!page.has_more) return matches;
    if (!page.last_id) {
      throw new Error(
        `OpenAI files list reported has_more=true without last_id; refusing to assume the page was exhausted`,
      );
    }
    after = page.last_id;
  }
  // Cap hit before list exhausted — fail closed rather than risk missing
  // a remote file we never saw.
  throw new Error(
    `OpenAI run ${runId}: file list page cap (${BATCH_LIST_PAGE_CAP}) reached before exhausting results; ` +
      `refusing to upload until the operator clears the in-flight file in the OpenAI dashboard.`,
  );
}

async function findBatchesByRunId(
  batch: OpenAIBatchClient,
  runId: string,
): Promise<Array<{ info: OpenAIBatchInfo; raw: unknown }>> {
  const matches: Array<{ info: OpenAIBatchInfo; raw: unknown }> = [];
  let after: string | undefined;
  for (let i = 0; i < BATCH_LIST_PAGE_CAP; i++) {
    const page = await batch.listBatches({ after, limit: 100 });
    for (let i = 0; i < page.data.length; i++) {
      if (page.data[i]!.metadata?.run_id === runId) {
        matches.push({ info: page.data[i]!, raw: page.raw[i] });
      }
    }
    if (!page.has_more) return matches;
    if (!page.last_id) {
      throw new Error(
        `OpenAI batches list reported has_more=true without last_id; refusing to assume the page was exhausted`,
      );
    }
    after = page.last_id;
  }
  throw new Error(
    `OpenAI run ${runId}: batch list page cap (${BATCH_LIST_PAGE_CAP}) reached before exhausting results; ` +
      `refusing to create until the operator clears the in-flight batch in the OpenAI dashboard.`,
  );
}

async function acquireCreateLock(deps: ReconcileDeps): Promise<ReconcileLock> {
  if (deps.acquireLock) return deps.acquireLock(deps.sidecarFilePath ?? "");
  if (!deps.sidecarFilePath) {
    // Test harnesses that don't pass sidecarFilePath can still opt in via
    // acquireLock; otherwise we fail closed rather than silently serialize
    // against a phantom path.
    throw new Error(
      "OpenAI reconcile requires sidecarFilePath on ReconcileDeps so the create-window lock has a path to lock",
    );
  }
  return acquireReconcileLock(deps.sidecarFilePath);
}

function submittedSidecarFrom(
  existing: OpenAIUploadingSidecar | OpenAICreatingSidecar,
  info: Pick<
    OpenAIBatchInfo,
    "id" | "status" | "output_file_id" | "error_file_id"
  >,
  inputFileId: string,
): OpenAISubmittedSidecar {
  // The shared fields across uploading/creating sidecars match the spread
  // source — drop the explicit `as` by selecting only the overlap.
  const base: Omit<
    OpenAISubmittedSidecar,
    | "phase"
    | "batchId"
    | "inputFileId"
    | "outputFileId"
    | "errorFileId"
    | "processingStatus"
  > = {
    version: existing.version,
    provider: existing.provider,
    runId: existing.runId,
    model: existing.model,
    reasoningEffort: existing.reasoningEffort,
    targets: existing.targets,
  };
  return {
    ...base,
    phase: "submitted",
    batchId: info.id,
    inputFileId,
    outputFileId: info.output_file_id,
    errorFileId: info.error_file_id,
    processingStatus: info.status,
  };
}

function ambiguousBatchesError(
  runId: string,
  remote: Array<{ id: string }>,
): Error {
  return new Error(
    `OpenAI run ${runId}: ${remote.length} remote batches share metadata.run_id; ` +
      `ambiguous resume would risk double-billing. Reconcile in the OpenAI dashboard before retrying.`,
  );
}

function ambiguousFilesError(
  runId: string,
  remote: Array<{ id: string }>,
): Error {
  return new Error(
    `OpenAI run ${runId}: ${remote.length} remote input files share filename ${INPUT_FILENAME(runId)}; ` +
      `ambiguous resume would risk duplicate uploads. Reconcile in the OpenAI dashboard before retrying.`,
  );
}