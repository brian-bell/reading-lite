import {
  manifestToIndexItem,
  ReadingStore,
} from "./modules/stores/reading-store";
import { SimilarityStore } from "./modules/stores/similarity-store";
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
export class ReadingVisibility {
  constructor(
    private readonly reader: ReadingStore,
    private readonly similarity: SimilarityStore | null,
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
      await run("upsert_vector", () =>
        this.similarity!.upsert(args.id, vector.embedding, vector.meta),
      );
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
