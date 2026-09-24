import { envelopeFromPrincipal, type ProcessReadingEnvelopeV1 } from "../control-plane/envelope";
import type { AuthenticatedPrincipal } from "../control-plane/principal";
import type { ProcessReadingArgs } from "../process-reading";
import type { Manifest, ProcessingAttemptSummary } from "../schemas/manifest";
import { queueSendRollback } from "../modules/manifest-drafting";
import type { ContentStore } from "../modules/stores/content-store";
import type { PgReadingWriter } from "../modules/stores/postgres/reading-writer";
import type { Services } from "../services";

// The activation half of the IntakeOutcome union (see ./index.ts, which
// composes it): every activation either activates the attempt or reports the
// slot unavailable after the rollback ran. HTTP-free — the router maps
// `activated` to 202 and `unavailable` to 503.
//
// `activation_failed` is an import whose content never reached R2. That
// happens before any row is written (see captureArtifacts), so there is
// nothing to roll back and, for a new reading, no id to report.
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
      id?: string;
    };

// Raw bytes + extracted markdown captured eagerly on the import paths, with the
// attempt's revision keys to write them under. Absent on submit/reprocess,
// where the queue consumer fetches and extracts the source.
export interface ActivationArtifacts {
  // The attempt's own revision prefix: everything it writes lives under it.
  revisionPrefix: string;
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
  // Failure rollback base. New readings pass the pending manifest (→ failed);
  // reprocess passes the PRIOR manifest so a ready reading rolls back to ready.
  rollbackManifest: Manifest;
  rollbackAttempt: ProcessingAttemptSummary;
  queueMessage: ProcessReadingArgs;
  principal: AuthenticatedPrincipal;
}

export interface ActivationStores {
  writer: PgReadingWriter;
}

// Import content goes to R2 BEFORE the attempt row that points at it commits
// (the write order every revision follows): a reader that finds the keys on
// the row finds the objects too. The attempt's revision prefix is its own, so
// writing there before the claim can conflict with nothing; a claim or start
// that is then refused sweeps the prefix (discardArtifacts), as nothing will
// ever reference it. A throw here leaves whatever landed for the same sweep.
export async function captureArtifacts(content: ContentStore, a: ActivationArtifacts): Promise<void> {
  await content.put(a.rawKey, a.rawBytes, a.rawContentType);
  await content.put(a.extractedKey, a.extractedMarkdown, "text/markdown; charset=utf-8");
}

export async function discardArtifacts(content: ContentStore, a: ActivationArtifacts): Promise<void> {
  await content.deletePrefix(a.revisionPrefix);
}

// Runs AFTER the caller's transaction committed the attempt and its job row
// (PgReadingWriter.claimUrl / startAttempt), so the intent to do this work is
// durable before anything is sent, and after any import content is in R2. It
// enqueues; a throw rolls the reading back to a failed (retryable) state in
// one transaction and leaves the job marked `send_failed`. The attempt keeps
// its content keys: the objects are there, and a never-published reading
// serves its latest attempt's content.
//
// The deletion fence needs no check here. A reading purged in between has no
// row: failActivation finds nothing to roll back, and the consumer drops the
// message for the same reason.
export async function activateAttempt(
  { writer }: ActivationStores,
  queue: Queue<ProcessReadingEnvelopeV1>,
  services: Services,
  a: AttemptActivation,
): Promise<ActivationOutcome> {
  const ref = { id: a.manifest.id, attemptId: a.manifest.active_attempt!.id };
  try {
    await queue.send(envelopeFromPrincipal(a.principal, a.queueMessage));
  } catch (err) {
    console.error(err);
    const failed = queueSendRollback(a.rollbackManifest, a.rollbackAttempt, err, services.now());
    await writer.failActivation(ref, failed, failed.last_attempt!);
    return { kind: "unavailable", reason: "queue_send_failed", id: a.manifest.id };
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
