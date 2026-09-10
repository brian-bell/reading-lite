import { envelopeFromPrincipal, type ProcessReadingEnvelopeV1 } from "../control-plane/envelope";
import type { AuthenticatedPrincipal } from "../control-plane/principal";
import type { ProcessReadingArgs } from "../process-reading";
import type { Manifest, ProcessingAttemptSummary } from "../schemas/manifest";
import { queueSendRollback } from "../modules/manifest-drafting";
import { manifestToIndexItem, ReadingStore } from "../modules/stores/reading-store";
import type { Services } from "../services";

// The activation half of the IntakeOutcome union (see ./index.ts, which
// composes it): every activation either activates the attempt or reports the
// slot unavailable after the rollback funnel ran. HTTP-free — the router maps
// `activated` to 202 and `unavailable` to 503.
export type ActivationOutcome =
  | {
      kind: "activated";
      id: string;
      status: Manifest["status"];
      attemptId: string;
    }
  | {
      kind: "unavailable";
      reason: "activation_failed" | "queue_send_failed";
      id: string;
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
  // The pending/next manifest to write. The `activated` outcome is DERIVED
  // from it: { id: manifest.id, status: manifest.status,
  //            attemptId: manifest.active_attempt!.id }
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
// the caller (Reading intake) *before* this runs; activation only writes into a
// slot it already owns. A throw anywhere before the queue send rolls the slot
// back to a failed (retryable) manifest and reports `unavailable`.
//
// The purge tombstone is a write fence here too (issue #179): a reprocess can
// pass loadReadingById and then lose the race to DELETE, which writes
// `index/deleted/{id}` and finishes before these puts. Under a confirmed
// tombstone we skip the pending write, the enqueue, and the rollback write —
// skip only, no compensation.
export async function activateAttempt(
  reader: ReadingStore,
  queue: Queue<ProcessReadingEnvelopeV1>,
  services: Services,
  a: AttemptActivation,
): Promise<ActivationOutcome> {
  if (await confirmedPurgeTombstone(reader, a.manifest.id)) {
    return { kind: "unavailable", reason: "activation_failed", id: a.manifest.id };
  }
  let failureReason: "activation_failed" | "queue_send_failed" = "activation_failed";
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
    failureReason = "queue_send_failed";
    await queue.send(envelopeFromPrincipal(a.principal, a.queueMessage));
  } catch (err) {
    console.error(err);
    if (!(await confirmedPurgeTombstone(reader, a.manifest.id))) {
      await writeFailedActivationManifest(
        reader,
        a.keyPrefix,
        a.rollbackManifest,
        a.rollbackAttempt,
        err,
        services,
      );
    }
    return { kind: "unavailable", reason: failureReason, id: a.manifest.id };
  }

  return {
    kind: "activated",
    id: a.manifest.id,
    status: a.manifest.status,
    attemptId: a.manifest.active_attempt!.id,
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
  const failedManifest = queueSendRollback(manifest, activeAttempt, err, services.now());
  await reader.writeManifest(keyPrefix, failedManifest);
  await reader.appendOrReplaceListIndexItem(manifestToIndexItem(failedManifest, keyPrefix));
}

// Confirmed tombstone only. A throwing HEAD is not evidence of purge —
// fail-open so a transient R2 error does not drop a live activation.
async function confirmedPurgeTombstone(reader: ReadingStore, id: string): Promise<boolean> {
  try {
    return await reader.hasPurgeTombstone(id);
  } catch (error) {
    console.error(error);
    return false;
  }
}
