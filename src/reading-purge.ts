import type { ContentStore } from "./modules/stores/content-store";
import type { PgReadingWriter } from "./modules/stores/postgres/reading-writer";
import { effectivelyRunning } from "./modules/staleness";

// Deletes a reading everywhere it exists: its PostgreSQL rows (the reading,
// its URL ownership, revisions, relationships, embedding, attempts and jobs,
// by cascade), every R2 object under its key_prefix, and the hosted refresh
// checkpoint.
//
// Two invariants shape the ordering:
//
// 1. Rows first, objects second. The row delete is one transaction, so the
//    reading stops being listed, readable, searchable and the owner of its URL
//    at a single instant, and a worker that dies afterwards leaves only
//    unreferenced bytes. The reverse order would leave a listed reading whose
//    content 404s.
//
//    The row delete is also the deletion fence (the in-flight-consumer race,
//    issue #179). TTL staleness is a read-time verdict, not proof the queue
//    consumer stopped, so a still-running >TTL attempt can reach its terminal
//    commit after this purge. That commit locks the reading row, finds none,
//    and writes nothing; the attempt log's foreign key refuses to be recreated
//    the same way. There is no tombstone to keep, latch or fail open on.
//
//    What a late consumer CAN still do is write content objects under its own
//    revision prefix after the sweep below. It deletes that prefix itself when
//    its commit reports the reading gone (process-reading.ts), and the second
//    sweep here covers an attempt that was mid-put during the first.
//
//    A purge that dies between the rows and the objects cannot be resumed by
//    re-issuing the DELETE: the id no longer resolves, so the retry is a 404.
//    The leftover bytes are unreachable through the API and are removed with
//    the tenant's prefix by the account wipe. That is the price of making the
//    visible half atomic.
//
// 2. URL ownership is a row owned by the reading, so it is released exactly
//    when this reading owned it. Purging an orphan duplicate cascades nothing
//    from the surviving copy's URL row.

export interface PurgeReport {
  id: string;
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
  writer: PgReadingWriter;
  content: ContentStore;
  // Hosted refresh work is control-plane state keyed by tenant and reading.
  deleteRefreshCheckpoint?: (id: string) => Promise<void>;
}

export async function purgeReading(
  deps: PurgeDeps,
  id: string,
  opts: { pendingTtlSeconds: number; now: string },
): Promise<PurgeOutcome> {
  // Refuse while an attempt is effectively running: purging under a live
  // consumer wastes its paid work. Decided under the row lock, so a purge and
  // an activation cannot both win.
  const purged = await deps.writer.purge(id, (row) =>
    effectivelyRunning(row, opts.pendingTtlSeconds, opts.now),
  );
  if (purged.kind === "not_found") return { kind: "not_found" };
  if (purged.kind === "conflict") return { kind: "conflict", reason: "active_attempt" };

  let objectsDeleted = await deps.content.deletePrefix(purged.keyPrefix);
  // Second pass: an attempt that was mid-put during the first.
  objectsDeleted += await deps.content.deletePrefix(purged.keyPrefix);

  // Best-effort: the purge already happened and a retry is a 404, so a failed
  // cleanup must not report it as an error. A leftover checkpoint is inert,
  // since the refresh it describes finds no reading and stops.
  await deps.deleteRefreshCheckpoint?.(id)?.catch((err) => console.error(err));

  return {
    kind: "purged",
    report: {
      id,
      // The embedding row goes with the reading; kept for the report contract.
      vector_delete_requested: true,
      list_row_removed: true,
      by_url_released: purged.urlReleased,
      objects_deleted: objectsDeleted,
    },
  };
}
