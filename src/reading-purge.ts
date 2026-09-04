import { ZodError } from "zod";
import type { ReadingStore } from "./modules/stores/reading-store";
import type { SimilarityStore } from "./modules/stores/similarity-store";
import type { VectorLedger } from "./control-plane/vector-ledger";
import { applyStaleness } from "./modules/staleness";
import { sha256Hex } from "./services";
import type { Manifest } from "./schemas/manifest";

// The purge counterpart to ReadingVisibility: deletes a reading everywhere it
// exists — Vectorize vector, index/list.json row, by-url ownership pointer,
// every R2 object under its id-scoped prefix, and the by-id pointer.
//
// Two invariants shape the ordering:
//
// 1. No step may leave the reading visible or unrecoverable if the worker dies
//    between steps: vector → owned by-url pointer → list row → objects →
//    final sweep → by-id pointer. The pointer precedes the row because the row
//    is the URL-identity fallback a retry needs to release the slot when the
//    manifest is corrupt or gone. The by-id pointer goes LAST: it is what lets
//    a re-issued DELETE for the same id resolve the key prefix and finish a
//    partial purge, so it must outlive every other artifact.
//
//    Known residual race (deliberate, last-writer-wins per the repo's stance):
//    TTL staleness is a read-time verdict, not proof the queue consumer
//    stopped, so a still-running >TTL attempt that pauses between its terminal
//    manifest CAS and its visibility publish can republish a row/vector after
//    every sweep. Account deletion (DELETE /api/account, issue 195a) closes
//    that race at tenant scope by rechecking users.status immediately before
//    publish. A per-reading tombstone for this purge path is still #179.
//
// 2. The by-url pointer records *ownership*, not readiness, and an
//    orphan-duplicate's URL hashes to the same slot as its surviving copy. The
//    pointer is deleted only when the stored pointer's id equals the purged
//    reading's id — the same rule the offline tooling encodes in
//    scripts/corpus-lib/delete-plan.ts (byUrlPointerKeyIfOwned).
//
// Every step is idempotent, so the endpoint doubles as its own repair tool: a
// purge that lost its manifest (or any other artifact) earlier still completes.

export interface PurgeReport {
  id: string;
  // True when a vector delete was issued (Vectorize's deleteByIds does not
  // report whether the vector existed); false when no similarity store is
  // bound (local dev) and the vector — if any — was left untouched.
  vector_delete_requested: boolean;
  list_row_removed: boolean;
  by_url_released: boolean;
  objects_deleted: number;
}

export type PurgeOutcome =
  | { kind: "not_found" }
  | { kind: "conflict"; reason: "active_attempt" }
  | { kind: "purged"; report: PurgeReport };

export interface PurgeDeps {
  reader: ReadingStore;
  // Null when no Vectorize binding exists (local dev): the purge is R2-only.
  similarity: SimilarityStore | null;
  // The durable vector-id ledger (issue #195 S3). Null in the same
  // configurations `similarity` is, plus one with no control plane bound.
  //
  // FOR S5's RESIDUE SCAN: on a tenant that is never wiped, the row this writes
  // is permanent — nothing clears a `delete_submitted` row except an account
  // wipe's confirmation pass or a republish of the same reading. So a live
  // tenant accumulates one row per purged reading, forever. Harmless (it is a
  // reading id the tenant owned, in their own control-plane row) and bounded by
  // purge count, but it is unbounded in time and it lengthens the eventual
  // wipe's confirmation work. The residue scan is the natural place to report
  // and retire rows whose vector it can confirm gone.
  //
  // A purge marks the row `delete_submitted` rather than removing it, and that
  // is deliberate: `deleteByIds` is asynchronous and confirms nothing, so a
  // purge whose vector delete did not take is precisely the unaddressable-vector
  // case (review finding F3). Keeping the id is the only thing that leaves it
  // addressable. The row clears when a wipe's confirmation pass says something
  // definite about it, or when a later republish of the same reading marks it
  // live again.
  ledger?: VectorLedger | null;
}

export async function purgeReading(
  deps: PurgeDeps,
  id: string,
  opts: { pendingTtlSeconds: number; now: string },
): Promise<PurgeOutcome> {
  const pointer = await deps.reader.readByIdPointer(id);
  if (!pointer) return { kind: "not_found" };
  // Destructive-safety: never follow a damaged by-id pointer into another
  // reading's prefix. Activation writes {id, key_prefix ending in "-{id}"}
  // (the buildKeyPrefix contract); anything else is damage, and a purge must
  // refuse rather than delete objects this id does not own.
  if (pointer.id !== id || !pointer.key_prefix.endsWith(`-${id}`)) {
    return { kind: "not_found" };
  }

  // A missing or CORRUPT manifest must not block the purge — that is exactly
  // the partial state a re-issued delete exists to clean up. A transiently
  // FAILING read is neither: treating it as absence would skip the
  // active-attempt guard on a reading that may be live, so it aborts the purge
  // (the caller retries) instead.
  let manifest: Manifest | null = null;
  try {
    manifest = await deps.reader.readManifest(pointer.key_prefix);
  } catch (err) {
    if (!isCorruptStoredObjectError(err)) throw err;
  }
  if (manifest && hasRunningAttempt(manifest, opts)) {
    return { kind: "conflict", reason: "active_attempt" };
  }

  // Read the list row before removing it: it is the URL fallback for releasing
  // the by-url slot when the manifest is already gone.
  const row = await deps.reader.findListIndexItem(id);

  if (deps.similarity) {
    await deps.similarity.delete(id);
    // After the delete: `deleted_at_ms` dates the submission, and the ledger's
    // +120s first-confirmation delay is measured from it. Off the injected
    // clock, like everything else here.
    await deps.ledger?.markDeleteSubmitted([id], ledgerStamp(opts.now));
  }

  // Pointer before list row: when the manifest is corrupt or missing, the row
  // is the ONLY recoverable source of the URL hash, so it must survive until
  // the owned by-url slot is released — otherwise a transient failure here
  // would strand the pointer beyond what a retry can repair. The brief window
  // this leaves (row without pointer, re-adoptable by a racing submit's
  // cold-path scan) is closed by the final sweep below plus the consumer's
  // purge guard.
  const byUrlReleased = await releaseByUrlSlotIfOwned(deps.reader, id, manifest, row?.url);

  let listRowRemoved = false;
  await deps.reader.removeListIndexItemIf(id, (item) => {
    listRowRemoved = listRowRemoved || item.id === id;
    return item.id === id;
  });

  let objectsDeleted = await deps.reader.deleteReadingObjects(pointer.key_prefix);

  // Final sweep for the narrow race where a live in-flight attempt — TTL
  // staleness is a read-time verdict, not proof the worker stopped —
  // republished state between the steps above. Every op is idempotent, and
  // the sweep runs BEFORE the by-id delete so a failure anywhere in it leaves
  // the retry locator intact. A commit landing after this pass is the
  // accepted last-writer-wins residue (the repo's documented stance, same
  // class as delete-plan.ts's orphan attempt JSONs): invisible-or-repairable —
  // the consumer's purge guard refuses retries, attempt-log writes dangle
  // nothing, and a stray pointer/row is reclaimed by the next submit's
  // ownership repair or corpus tooling.
  objectsDeleted += await deps.reader.deleteReadingObjects(pointer.key_prefix);
  // The sweep re-issues the vector delete but NOT the ledger write. The row was
  // recorded before the first delete and carries this same stamp, so a second
  // write would change nothing — while adding a failure point after the objects
  // are already gone, where a D1 blip would throw out of
  // `DELETE /api/readings/:id` with the by-id pointer still present. The
  // invariant that matters is already satisfied: the id was in the ledger
  // before anything was deleted.
  if (deps.similarity) await deps.similarity.delete(id);
  await deps.reader.removeListIndexItemIf(id, (item) => item.id === id);
  await releaseByUrlSlotIfOwned(deps.reader, id, manifest, row?.url);

  // Last, so every earlier step can be re-driven by re-issuing the DELETE.
  await deps.reader.deleteByIdPointer(id);

  return {
    kind: "purged",
    report: {
      id,
      vector_delete_requested: deps.similarity !== null,
      list_row_removed: listRowRemoved,
      by_url_released: byUrlReleased,
      objects_deleted: objectsDeleted,
    },
  };
}

function hasRunningAttempt(
  manifest: Manifest,
  opts: { pendingTtlSeconds: number; now: string },
): boolean {
  // The same read-time staleness rule reprocess applies: a zombie attempt past
  // TTL reads as failed and must not block the purge forever.
  const effective = applyStaleness(manifest, opts.pendingTtlSeconds, opts.now);
  return effective.active_attempt?.status === "running";
}

/**
 * The purge's clock as a ledger stamp.
 *
 * Guarded rather than trusted. `deleted_at_ms` is bound straight into D1, and a
 * `NaN` from an unparseable `opts.now` would be rejected by the binding — after
 * `similarity.delete` has already been submitted, which is exactly the
 * unaddressable-vector case the ledger exists to prevent. Every current caller
 * passes `services.now()`, so this only ever fires on a future one.
 */
function ledgerStamp(now: string): number {
  const parsed = Date.parse(now);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

async function releaseByUrlSlotIfOwned(
  reader: ReadingStore,
  id: string,
  manifest: Manifest | null,
  rowUrl: string | undefined,
): Promise<boolean> {
  const urlHash =
    manifest?.url_hash ?? (rowUrl === undefined ? null : await sha256Hex(rowUrl));
  if (urlHash === null) return false;
  // An unparseable pointer is left alone, like delete-plan's rule — but a
  // transiently failing read aborts (per the same contract there): mistaking
  // it for absence would strand an owned pointer while the rest is purged.
  let stored: Awaited<ReturnType<ReadingStore["readByUrlPointer"]>> = null;
  try {
    stored = await reader.readByUrlPointer(urlHash);
  } catch (err) {
    if (!isCorruptStoredObjectError(err)) throw err;
  }
  if (!stored || stored.id !== id) return false;
  // R2 has no conditional delete, so the ownership check and the delete are
  // two operations: a submit that claims the freed slot inside that gap could
  // lose its fresh pointer to a concurrently re-issued purge. That loss is
  // the missing-pointer damage class resolveOwner's cold-path claim already
  // repairs on the next write (the new reading keeps its list row), so it is
  // accepted as self-healing rather than paid for with a reservation protocol.
  await reader.deleteByUrlPointer(urlHash);
  return true;
}

// The two ways a stored JSON object reads as corrupt rather than unavailable:
// JSON.parse throws SyntaxError, schema validation throws ZodError. Anything
// else is infrastructure and must propagate.
function isCorruptStoredObjectError(err: unknown): boolean {
  return err instanceof SyntaxError || err instanceof ZodError;
}
