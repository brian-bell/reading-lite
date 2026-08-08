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
// `creating`, `batchId: ""`). On resume we never call `create` unless we've
// first listed remote batches for this run id; we never call `upload` unless
// we've first listed remote files for this run id. This keeps a crashed run
// from double-billing the summarize step.
//
// Concurrency model: the list-then-create window is not atomic at the OpenAI
// API level (the Batch endpoint has no idempotency key). The architectural
// defense against two concurrent resumes of the same sidecar is:
//   1. `--sole-writer` at the CLI layer (`scripts/corpus-lib/sole-writer.ts`),
//      an operator acknowledgement that the realtime writer is paused.
//   2. A sidecar-scoped file lock acquired immediately before each `create`
//      call via `acquireReconcileLock`. Two concurrent resumes of the same
//      sidecar cannot both pass the wx create — the loser refuses to create.
//   3. A last-chance re-list inside `createOnceWithLastChanceCheck` catches
//      the case where the other process acquired the lock, listed, found
//      nothing, created, released, and exited before this process's create
//      call landed (multi-millisecond window).

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

  if (existing.phase === "creating") {
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
    const lock = await acquireCreateLock(deps);
    let submitted: OpenAISubmittedSidecar;
    try {
      const info = await createOnceWithLastChanceCheck(
        deps.batch,
        runId,
        existing.inputFileId,
      );
      submitted = submittedSidecarFrom(existing, info, existing.inputFileId);
      await deps.saveSidecar(submitted);
      log(`No remote batch; creating once for file ${existing.inputFileId} -> ${info.id}`);
    } finally {
      await lock.release();
    }
    return submitted!;
  }

  // phase === "uploading" — inputFileId is null in the sidecar.
  log(`Reconciling OpenAI uploading sidecar run_id=${runId}`);
  const files = await findFilesByRunId(deps.batch, runId);
  if (files.length > 1) {
    throw ambiguousFilesError(runId, files);
  }
  let inputFileId: string;
  let checkpointsBefore: number = 0;
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
  // Adopt / upload complete; advance to "creating" so a crash between list and
  // create lands on the creating branch instead of re-listing.
  const creatingCheckpoint: OpenAICreatingSidecar = {
    ...(existing as OpenAIUploadingSidecar),
    phase: "creating",
    inputFileId,
    processingStatus: "creating",
  };
  await deps.saveSidecar(creatingCheckpoint);
  checkpointsBefore = 1;
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
  const lock = await acquireCreateLock(deps);
  let submitted: OpenAISubmittedSidecar;
  try {
    const info = await createOnceWithLastChanceCheck(deps.batch, runId, inputFileId);
    submitted = submittedSidecarFrom(existing, info, inputFileId);
    await deps.saveSidecar(submitted);
    log(
      `No remote batch; creating once for file ${inputFileId} -> ${info.id} ` +
        `(checkpoints=${checkpointsBefore})`,
    );
  } finally {
    await lock.release();
  }
  return submitted;
}

// Defense-in-depth: re-list remote batches by run id immediately before
// calling `create`. Closes the multi-millisecond window between the main
// reconcile-time list and the create call (the architectural sole-writer
// contract at the CLI layer is the primary defense).
async function createOnceWithLastChanceCheck(
  batch: OpenAIBatchClient,
  runId: string,
  inputFileId: string,
) {
  const lastChance = await findBatchesByRunId(batch, runId);
  if (lastChance.length === 1) {
    const match = assertResponsesBatchShape(lastChance[0]!.raw, {
      id: lastChance[0]!.info.id,
      runId,
    });
    throw new Error(
      `OpenAI run ${runId}: last-chance re-list found batch ${match.id}; ` +
        `refusing to create a second batch for this run id`,
    );
  }
  if (lastChance.length > 1) {
    throw ambiguousBatchesError(runId, lastChance.map((m) => m.info));
  }
  return batch.create(inputFileId, runId);
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