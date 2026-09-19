import { envelopeFromPrincipal, type ProcessReadingEnvelopeV1 } from "../control-plane/envelope";
import type { AuthenticatedPrincipal } from "../control-plane/principal";
import type { ProcessReadingArgs } from "../process-reading";
import type { Manifest, ProcessingAttemptSummary } from "../schemas/manifest";
import { queueSendRollback } from "../modules/manifest-drafting";
import type { ContentStore } from "../modules/stores/content-store";
import type { PgReadingStore } from "../modules/stores/postgres/reading-store";
import type { PgReadingWriter } from "../modules/stores/postgres/reading-writer";
import { discardUnreferencedContent } from "../attempt-io";
import type { Services } from "../services";

// The activation half of the IntakeOutcome union (see ./index.ts, which
// composes it): every activation either activates the attempt or reports the
// slot unavailable after the rollback ran. HTTP-free — the router maps
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

// Raw bytes + extracted markdown captured eagerly on the import paths, with the
// attempt's revision keys to write them under. Absent on submit/reprocess,
// where the queue consumer fetches and extracts the source.
export interface ActivationArtifacts {
  rawKey: string;
  rawBytes: Uint8Array;
  rawContentType: string;
  extractedKey: string;
  extractedMarkdown: string;
}

export interface AttemptActivation {
  // The pending/next manifest the caller already committed. The `activated`
  // outcome is DERIVED from it: { id: manifest.id, status: manifest.status,
  //                               attemptId: manifest.active_attempt!.id }
  manifest: Manifest;
  // Present only on the import paths.
  artifacts?: ActivationArtifacts;
  // Failure rollback base. New readings pass the pending manifest (→ failed);
  // reprocess passes the PRIOR manifest so a ready reading rolls back to ready.
  rollbackManifest: Manifest;
  rollbackAttempt: ProcessingAttemptSummary;
  queueMessage: ProcessReadingArgs;
  principal: AuthenticatedPrincipal;
}

export interface ActivationStores {
  writer: PgReadingWriter;
  store: PgReadingStore;
  content: ContentStore;
}

// Runs AFTER the caller's transaction committed the attempt and its job row
// (PgReadingWriter.claimUrl / startAttempt), so the intent to do this work is
// durable before anything is sent. It writes the import artifacts under the
// attempt's own revision keys, then enqueues. A throw at either step rolls the
// reading back to a failed (retryable) state in one transaction and leaves the
// job marked `send_failed`. A content write that fails also drops the
// attempt's content keys, so no reader resolves content that never landed,
// and sweeps whatever part of the import did land.
//
// The deletion fence needs no check here. A reading purged in between has no
// row: failActivation finds nothing to roll back, and the consumer drops the
// message for the same reason. The artifacts are under the purged prefix only
// if the put raced the purge's sweep, which the purge's second pass covers.
export async function activateAttempt(
  { writer, store, content }: ActivationStores,
  queue: Queue<ProcessReadingEnvelopeV1>,
  services: Services,
  a: AttemptActivation,
): Promise<ActivationOutcome> {
  const ref = { id: a.manifest.id, attemptId: a.manifest.active_attempt!.id };
  let failureReason: "activation_failed" | "queue_send_failed" = "activation_failed";
  try {
    if (a.artifacts) {
      await content.put(a.artifacts.rawKey, a.artifacts.rawBytes, a.artifacts.rawContentType);
      await content.put(a.artifacts.extractedKey, a.artifacts.extractedMarkdown, "text/markdown; charset=utf-8");
    }
    failureReason = "queue_send_failed";
    await queue.send(envelopeFromPrincipal(a.principal, a.queueMessage));
  } catch (err) {
    console.error(err);
    const failed = queueSendRollback(a.rollbackManifest, a.rollbackAttempt, err, services.now());
    // Past the content writes only once the failure is the send itself.
    const contentCaptured = failureReason === "queue_send_failed";
    await writer.failActivation(ref, failed, failed.last_attempt!, { contentCaptured });
    // Nothing revisits this attempt's revision prefix, so a half-written import
    // is swept now. After the rollback, so the reading no longer points at it.
    if (a.artifacts && !contentCaptured) {
      await discardUnreferencedContent(store, content, a.queueMessage).catch((e) => console.error(e));
    }
    return { kind: "unavailable", reason: failureReason, id: a.manifest.id };
  }
  // Bookkeeping only: the message is already queued, so a failure here must
  // not report the activation as failed.
  await writer.markJobSent(ref).catch((err) => console.error(err));

  return {
    kind: "activated",
    id: a.manifest.id,
    status: a.manifest.status,
    attemptId: ref.attemptId,
  };
}
