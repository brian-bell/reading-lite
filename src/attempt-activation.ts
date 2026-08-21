import { envelopeFromPrincipal, type ProcessReadingEnvelopeV1 } from "./control-plane/envelope";
import type { AuthenticatedPrincipal } from "./control-plane/principal";
import type { ProcessReadingArgs } from "./process-reading";
import type { Manifest, ProcessingAttemptSummary } from "./schemas/manifest";
import { manifestToIndexItem, ReadingStore } from "./modules/stores/reading-store";
import type { Services } from "./services";

// The JSON envelope returned by every submit/import/reprocess activation path.
// Lives here (rather than router.ts) because activateAttempt is the canonical
// producer of the 202/503 activation results; router.ts re-imports it.
export type SubmitJsonResult = {
  body: unknown;
  status: 200 | 202 | 409 | 503;
};

// Raw bytes + extracted markdown captured eagerly on the import paths. Absent on
// submit/reprocess, where the queue consumer fetches and extracts the source.
export interface ActivationArtifacts {
  rawExt: string;
  rawBytes: Uint8Array;
  rawContentType: string;
  extractedMarkdown: string;
}

export interface AttemptActivation {
  keyPrefix: string;
  // The pending/next manifest to write. The 202 response is DERIVED from it:
  //   { id: manifest.id, status: manifest.status,
  //     attempt_id: manifest.active_attempt!.id }
  manifest: Manifest;
  // Submit + both import paths write the by-id pointer; reprocess does not.
  writeByIdPointer: boolean;
  // Present only on the import paths (raw bytes + extracted markdown).
  artifacts?: ActivationArtifacts;
  // Failure rollback base. New readings pass the pending manifest (→ failed);
  // reprocess passes the PRIOR manifest so a ready reading rolls back to ready.
  rollbackManifest: Manifest;
  rollbackAttempt: ProcessingAttemptSummary;
  queueMessage: ProcessReadingArgs;
  principal: AuthenticatedPrincipal;
}

// The write-side mirror of commitTerminalManifest: owns the canonical
// eager-write → enqueue ordering and the two-stage failure funnel shared by
// submit, reprocess, and both markdown-import paths. The by-url claim happens in
// the caller (router) *before* this runs; activation only writes into a slot it
// already owns. A throw anywhere before the queue send rolls the slot back to a
// failed (retryable) manifest and reports 503.
export async function activateAttempt(
  reader: ReadingStore,
  queue: Queue<ProcessReadingEnvelopeV1>,
  services: Services,
  a: AttemptActivation,
): Promise<SubmitJsonResult> {
  let failureMessage = "reading setup failed";
  try {
    if (a.artifacts) {
      await reader.writeRaw(
        a.keyPrefix,
        a.artifacts.rawExt,
        a.artifacts.rawBytes,
        a.artifacts.rawContentType,
      );
      await reader.writeExtracted(a.keyPrefix, a.artifacts.extractedMarkdown);
    }
    await reader.writeManifest(a.keyPrefix, a.manifest);
    if (a.writeByIdPointer) {
      await reader.writeByIdPointer(a.manifest.id, {
        id: a.manifest.id,
        key_prefix: a.keyPrefix,
      });
    }
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(a.manifest, a.keyPrefix));
    failureMessage = "queue send failed";
    await queue.send(envelopeFromPrincipal(a.principal, a.queueMessage));
  } catch (err) {
    console.error(err);
    await writeFailedActivationManifest(
      reader,
      a.keyPrefix,
      a.rollbackManifest,
      a.rollbackAttempt,
      err,
      services,
    );
    return { body: { error: failureMessage, id: a.manifest.id }, status: 503 };
  }

  return {
    body: {
      id: a.manifest.id,
      status: a.manifest.status,
      poll: `/api/readings/${a.manifest.id}`,
      attempt_id: a.manifest.active_attempt!.id,
    },
    status: 202,
  };
}

async function writeFailedActivationManifest(
  reader: ReadingStore,
  keyPrefix: string,
  manifest: Manifest,
  activeAttempt: ProcessingAttemptSummary,
  err: unknown,
  services: Services,
): Promise<void> {
  const failedManifest = manifestForQueueSendFailure(manifest, activeAttempt, err, services);
  await reader.writeManifest(keyPrefix, failedManifest);
  await reader.appendOrReplaceListIndexItem(manifestToIndexItem(failedManifest, keyPrefix));
}

function manifestForQueueSendFailure(
  manifest: Manifest,
  activeAttempt: ProcessingAttemptSummary,
  err: unknown,
  services: Services,
): Manifest {
  const failedAt = services.now();
  const error = {
    code: "QueueSendError",
    message: err instanceof Error ? err.message : "queue send failed",
    stage: "queued" as const,
    failed_at: failedAt,
    retryable: true,
  };
  const failedAttempt: ProcessingAttemptSummary = {
    ...activeAttempt,
    status: "failed",
    stage: "queued",
    finished_at: failedAt,
    error,
  };

  if (manifest.status === "ready") {
    return {
      ...manifest,
      active_attempt: undefined,
      last_attempt: failedAttempt,
      updated_at: failedAt,
    };
  }

  return {
    ...manifest,
    status: "failed",
    active_attempt: undefined,
    last_attempt: failedAttempt,
    error,
    ...(manifest.status === "pending" ? { content_status: "failed" as const } : {}),
    updated_at: failedAt,
  };
}
