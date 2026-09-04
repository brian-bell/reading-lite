import {
  manifestToIndexItem,
  ReadingStore,
} from "./modules/stores/reading-store";
import { SimilarityStore } from "./modules/stores/similarity-store";
import type { VectorLedger } from "./control-plane/vector-ledger";
import type { Manifest, ProcessingStage } from "./schemas/manifest";
import { attemptOwnership, type ProcessReadingArgs } from "./attempt-ownership";

// The vector half of a reading's visibility: the tldr embedding plus the
// metadata Vectorize stores alongside it. Provided only when publishing a vector
// (the success path); omitted on failure paths, which are list-only.
export interface PublishVector {
  embedding: number[];
  meta: { url: string; title: string; tags: string[]; created_at: string };
}

// Optional per-write instrumentation: the success path passes a runStage-bound
// closure so each sub-write still logs a ProcessingStage event. Failure paths
// omit it and the writes run plainly.
type Instrument = <T>(stage: ProcessingStage, fn: () => Promise<T>) => Promise<T>;

const passthrough: Instrument = (_stage, fn) => fn();

// The single home of a reading's *visibility* — the invariant that a reading is
// publicly visible iff its `index/list.json` row and its Vectorize vector move
// together, and that only the attempt that owns the reading may change either.
// `commitTerminalManifest` decides WHAT (publish vs remove vs restore) and
// passes the ownership gate it already computed; this module enforces HOW the
// list row and vector stay in lockstep. The `defensive` failure-swallowing
// policy stays at the commit layer and never leaks in here.
//
// `similarity` is null on the failure paths (and locally / in tests with no
// Vectorize binding), which encodes the deliberate success/failure asymmetry:
// success removal clears list AND vector, failure removal clears list only.
//
// There are two removal verbs, and the difference is who they protect against.
// `remove` is the ordinary reconciliation, gated on this attempt still owning
// what it is about to unpublish. `removeForDeletedTenant` is the account-deletion
// fence: it drops the vector unconditionally, because a tenant marked `deleting`
// has no data left worth guarding and because a concurrent account wipe may
// already have removed the list row and manifest those gates read.
// `ledger` is the durable vector-id ledger (issue #195 S3,
// `src/control-plane/vector-ledger.ts`). It is null in exactly the situations
// `similarity` is — no Vectorize binding, so no vector to account for — and a
// write to it always accompanies a write to the vector, never replaces one.
export class ReadingVisibility {
  constructor(
    private readonly reader: ReadingStore,
    private readonly similarity: SimilarityStore | null,
    private readonly ledger: VectorLedger | null = null,
  ) {}

  // Append (or replace) the list row, then upsert the vector. With a null
  // similarity store or no vector this is list-only. Each sub-write is wrapped
  // in the instrument so it still emits its ProcessingStage event.
  async publish(
    manifest: Manifest,
    args: ProcessReadingArgs,
    vector?: PublishVector,
    opts: { instrument?: Instrument } = {},
  ): Promise<void> {
    const run = opts.instrument ?? passthrough;
    await run("write_indexes", () =>
      this.reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, args.keyPrefix)),
    );
    if (vector && this.similarity) {
      await run("upsert_vector", async () => {
        // Ledger BEFORE the upsert, never after. A row written first and then
        // followed by a crashed upsert costs one redundant `deleteByIds` for a
        // vector Vectorize does not hold; the reverse — an upsert whose ledger
        // write never lands — is a vector with no id source, which is the
        // stranding the ledger exists to prevent and which nothing can repair
        // once the reading's R2 objects are gone.
        await this.ledger?.markLive([args.id], Date.now());
        await this.similarity!.upsert(args.id, vector.embedding, vector.meta);
      });
    }
  }

  // Remove the list row if this attempt still owns it, then the vector if the
  // manifest gate also allows it. With a null similarity store this is list-only
  // (the failure-path asymmetry): the vector is left untouched.
  async remove(args: ProcessReadingArgs): Promise<void> {
    if (!this.similarity) {
      await this.removeListRow(args);
      return;
    }
    if (!(await this.removeListRow(args))) return;
    if (!(await this.canRemoveVector(args))) return;
    await this.similarity.delete(args.id);
    // AFTER the delete: `deleted_at_ms` is what the +120s first-confirmation
    // delay is measured from, so it must record when the delete was actually
    // asked for. The row is marked, not removed — an unconfirmed delete still
    // needs its id kept, which is the whole point of the ledger.
    await this.ledger?.markDeleteSubmitted([args.id], Date.now());
  }

  // Deletion-fence compensation: the tenant was confirmed `deleting` around this
  // attempt's terminal write, so nothing this reading owns may survive.
  //
  // Unlike `remove`, the vector delete is NOT gated on the list row still being
  // there, and not on the manifest ownership gate either. Both gates protect a
  // *live* tenant's data from an attempt that no longer owns the reading; on a
  // tenant being deleted there is nothing left to protect, and the gates are
  // actively harmful — an account wipe running concurrently deletes
  // `index/list.json` and the manifest out from under this consumer, and this
  // is the compensation that keeps the vector from outliving the reading it
  // belongs to. Since issue #195 S3 the id itself is safe either way (the
  // ledger holds it), so a missed compensation costs a later wipe pass rather
  // than a permanent stranding — but deleting promptly is still right.
  //
  // The list row is still removed under the ordinary ownership gate: removing a
  // foreign attempt's row buys nothing here (the wipe deletes the whole index
  // anyway) and re-spelling that gate would be a second, divergent copy of it.
  //
  // Note for anyone adding a "cancel deletion during the grace window": this
  // fires on `deleting` regardless of whether a wipe has started, so a reading
  // that completed during grace would survive a cancellation with its list row
  // and manifest but no embedding. Safe today only because `beginAccountDeletion`
  // is one-way; a reactivation path has to reconcile vectors (see `ops corpus
  // backfill-vectors`) or narrow this gate.
  // Vector first, list row second — the same ordering `reading-purge.ts` uses,
  // and here it is load-bearing. `removeListIndexItemIf` throws when its CAS
  // retries are exhausted, which is exactly what a concurrent wipe rewriting or
  // deleting `index/list.json` provokes. Sequencing the vector delete behind that
  // write would let the outcome this method exists to prevent — a vector
  // outliving the reading it belongs to — fall out of the failure it is most
  // likely to meet.
  //
  // Not free: when the list write is what fails, the vector is already gone
  // while the row and manifest survive, so the reading stays listed and readable
  // but missing from semantic search. That is the better half of the trade (the
  // ledger row survives either way, so the wipe can still finish the job) and it is confined
  // to a tenant being deleted, but it is a real intermediate state, not none.
  async removeForDeletedTenant(args: ProcessReadingArgs): Promise<void> {
    if (this.similarity) {
      await this.similarity.delete(args.id);
      await this.ledger?.markDeleteSubmitted([args.id], Date.now());
    }
    await this.removeListRow(args);
  }

  // Re-append the current list row after a lost manifest CAS, but only if the
  // by-url pointer still points at this reading.
  async restoreIfOwner(args: ProcessReadingArgs): Promise<void> {
    const manifest = await this.reader.readManifest(args.keyPrefix);
    if (!manifest) return;
    // A lost CAS means a concurrent attempt won and already reconciled visibility.
    // If the by-url pointer points at a DIFFERENT reading, this reading is a
    // non-owner duplicate whose row that winner may have deliberately removed —
    // blindly re-appending here would resurrect a row it unpublished. Mirror
    // terminalWriteState's `ownerAllowsVisibility = ownsUrl` gate: re-sync only
    // when we still own the URL (or no pointer exists, the failure-path default).
    // This narrows the resurrection window but doesn't close it: a winner that
    // changes the pointer *after* this read still loses to our re-append. That
    // residual race is last-writer-wins (the repo's documented stance) and
    // self-heals — the winner's list-row removal gate re-removes our row on its
    // next pass, or a later terminal write reconciles it.
    const pointer = await this.reader.readByUrlPointer(args.urlHash);
    if (pointer && (pointer.id !== args.id || pointer.key_prefix !== args.keyPrefix)) return;
    await this.reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, args.keyPrefix));
  }

  private async removeListRow(args: ProcessReadingArgs): Promise<boolean> {
    let removed = false;
    await this.reader.removeListIndexItemIf(args.id, (item) => {
      // The list-row cleanup gate: the row must be this reading's (id + key_prefix)
      // AND this attempt must own it under the cleanup rule (active, last, or the
      // stricter vacant-pending — see plan 006).
      if (item.id !== args.id || item.key_prefix !== args.keyPrefix) return false;
      const owner = attemptOwnership(item, args);
      const matches = owner.isActive || owner.isLast || owner.isVacantPending;
      removed = removed || matches;
      return matches;
    });
    return removed;
  }

  private async canRemoveVector(args: ProcessReadingArgs): Promise<boolean> {
    const manifest = await this.reader.readManifest(args.keyPrefix);
    if (!manifest) return true;
    const owner = attemptOwnership(manifest, args);
    return owner.isActive || owner.isLast || owner.isVacantPending;
  }
}
