/**
 * D1-backed account-wipe progress, lease, and completion record (issue 195 S2).
 *
 * This is the whole of the wipe's durable state. It replaces
 * `wipe/{tenantId}/progress.json` and the R2 etag CAS around it.
 *
 * ## The lease is a version, not a timestamp
 *
 * Every write is `UPDATE … WHERE tenant_id = ? AND lease_seq = ?` and bumps
 * `lease_seq`. `changes === 0` means the row moved under us — a sibling
 * delivery owns this wipe — and the writer throws
 * `AccountWipeProgressConflictError` rather than re-reading and re-applying.
 * Re-applying would be the clobber the CAS exists to prevent.
 *
 * Two things that were special under the R2 etag CAS stop being special here:
 *
 * - **A frozen clock.** The old lease was `updated_at_ms` compared against the
 *   wall clock, so a job whose clock did not advance could have its record
 *   last-write-wins clobbered by a cron tick at the 15-minute boundary. That is
 *   why the job heartbeat had to read a live clock rather than the frozen
 *   consume-start `nowMs`. A CAS on a counter no clock touches does not care:
 *   whichever writer bumps first owns the wipe, and the other one is told so.
 * - **A long delayed retry.** A 12-hour `Retry-After` used to require pushing
 *   `updated_at_ms` into the future so cron would not enqueue a sibling while
 *   the retry was still owed. Now a sibling enqueued in that window simply
 *   claims the lease, and the late retry's stale `lease_seq` loses and backs
 *   off. Duplicated effort at worst, never a corrupted cursor.
 *
 * `updated_at_ms` survives, but demoted to advice: cron uses it to avoid
 * enqueuing a duplicate it would only have to turn away.
 *
 * ## The record outlives the wipe on purpose
 *
 * The R2 object was deleted at the terminal transition (review finding F4)
 * because its key named a deleted tenant and its body listed that tenant's
 * reading ids. Neither is true here: the row is keyed by a tenant whose `users`
 * row is still present until S4's teardown, and `complete()` clears both
 * cursors so the finished record carries no reading id at all.
 *
 * Keeping it is what closes the gap S1 documented as accepted. Fan-out no
 * longer has to infer "already wiped" from "no record AND an empty R2 prefix",
 * a shape a tenant with an emptied prefix and stranded vectors also has. The
 * row says what happened, and `residue` says whether the namespace was ever
 * confirmed clean. S4's hard delete of the `users` row gates on
 * `completed_at_ms`, which is also why the foreign key does not cascade.
 */
import type { ControlPlaneDb } from "./db";
import type { TenantId } from "./ids";

export type WipePhase = "vectors" | "objects" | "done";

/** One tenant's wipe state as stored. */
export interface WipeProgress {
  phase: WipePhase;
  leaseSeq: number;
  updatedAtMs: number;
  vectorCursor?: string;
  r2Cursor?: string;
  force: boolean;
  objectsDeleted: number;
  mutationIds: string[];
  /** True once the whole-index baseline has been sampled for this pass. */
  indexCountSampled: boolean;
  /** The baseline itself; null when the binding has no `describe()`. */
  indexCountStart: number | null;
  probeAttempts: number;
  probeSawResidue: boolean;
  continuations: number;
  completedAtMs: number | null;
  residue: boolean;
}

/**
 * A sibling delivery owns this wipe: our conditional UPDATE changed no rows.
 *
 * Not a failure to retry into the DLQ — the caller turns it into a `lease_held`
 * skip and acks, because the owner is already doing the work.
 */
export class AccountWipeProgressConflictError extends Error {
  constructor(public readonly tenantId: string) {
    super(`account_wipe progress_conflict for ${tenantId}`);
    this.name = "AccountWipeProgressConflictError";
  }
}

interface WipeProgressRow {
  phase: string;
  lease_seq: number;
  updated_at_ms: number;
  vector_cursor: string | null;
  r2_cursor: string | null;
  force: number;
  objects_deleted: number;
  mutation_ids: string;
  index_count_sampled: number;
  index_count_start: number | null;
  probe_attempts: number;
  probe_saw_residue: number;
  continuations: number;
  completed_at_ms: number | null;
  residue: number;
}

const COLUMNS = `phase, lease_seq, updated_at_ms, vector_cursor, r2_cursor, force,
    objects_deleted, mutation_ids, index_count_sampled, index_count_start,
    probe_attempts, probe_saw_residue, continuations, completed_at_ms, residue`;

function parsePhase(value: string): WipePhase {
  return value === "objects" || value === "done" ? value : "vectors";
}

function parseMutationIds(value: string): string[] {
  // Written by this module only, but it is a stored value and reads of stored
  // values are parsed everywhere else in this codebase too.
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function toProgress(row: WipeProgressRow): WipeProgress {
  return {
    phase: parsePhase(row.phase),
    leaseSeq: row.lease_seq,
    updatedAtMs: row.updated_at_ms,
    vectorCursor: row.vector_cursor ?? undefined,
    r2Cursor: row.r2_cursor ?? undefined,
    force: row.force !== 0,
    objectsDeleted: row.objects_deleted,
    mutationIds: parseMutationIds(row.mutation_ids),
    indexCountSampled: row.index_count_sampled !== 0,
    indexCountStart: row.index_count_start,
    probeAttempts: row.probe_attempts,
    probeSawResidue: row.probe_saw_residue !== 0,
    continuations: row.continuations,
    completedAtMs: row.completed_at_ms,
    residue: row.residue !== 0,
  };
}

export async function readWipeProgress(
  db: ControlPlaneDb,
  tenantId: TenantId,
): Promise<WipeProgress | null> {
  const row = await db.first<WipeProgressRow>(
    `SELECT ${COLUMNS} FROM wipe_progress WHERE tenant_id = ?`,
    tenantId,
  );
  return row ? toProgress(row) : null;
}

/** Every unfinished wipe, for cron fan-out. */
export async function listUnfinishedWipes(
  db: ControlPlaneDb,
): Promise<Map<string, WipeProgress>> {
  const rows = await db.all<WipeProgressRow & { tenant_id: string }>(
    `SELECT tenant_id, ${COLUMNS} FROM wipe_progress WHERE completed_at_ms IS NULL`,
  );
  return new Map(rows.map((row) => [row.tenant_id, toProgress(row)]));
}

/** The state a brand-new wipe starts in. Not yet written. */
export function emptyWipeProgress(nowMs: number, force = false): WipeProgress {
  return {
    phase: "vectors",
    leaseSeq: 0,
    updatedAtMs: nowMs,
    force,
    objectsDeleted: 0,
    mutationIds: [],
    indexCountSampled: false,
    indexCountStart: null,
    probeAttempts: 0,
    probeSawResidue: false,
    continuations: 0,
    completedAtMs: null,
    residue: false,
  };
}

/**
 * A finished wipe with leftover objects under its prefix is reopened as a fresh
 * pass: new probe budget, new count baseline, new continuation budget, cursors
 * cleared. Carrying a used-up `probe_attempts` into a pass that has just
 * submitted new deletes made its very first probe declare residue.
 *
 * `leaseSeq` is deliberately preserved — it is the row's identity for the CAS,
 * not part of the wipe's state.
 */
export function reopenWipeProgress(progress: WipeProgress, force: boolean): WipeProgress {
  return {
    ...progress,
    phase: "vectors",
    vectorCursor: undefined,
    r2Cursor: undefined,
    force,
    probeAttempts: 0,
    probeSawResidue: false,
    indexCountSampled: false,
    indexCountStart: null,
    continuations: 0,
    completedAtMs: null,
    residue: false,
  };
}

/**
 * Compare-and-set writer for one tenant's wipe row.
 *
 * Constructed from the `leaseSeq` the caller last read; each successful write
 * advances the writer's own copy so the next one chains. A write that changes
 * no rows means a sibling took the wipe over and throws.
 */
export class WipeProgressWriter {
  private leaseSeq: number;
  /** False until this writer knows a row exists to UPDATE. */
  private inserted: boolean;

  constructor(
    private readonly db: ControlPlaneDb,
    private readonly tenantId: TenantId,
    stored: WipeProgress | null,
  ) {
    this.leaseSeq = stored?.leaseSeq ?? 0;
    this.inserted = stored !== null;
  }

  /** The lease version this writer currently holds. */
  get seq(): number {
    return this.leaseSeq;
  }

  /**
   * Claim or extend the lease and persist `progress`.
   *
   * The first write for a tenant with no row inserts it, and a concurrent
   * inserter loses on the primary key rather than silently overwriting: the
   * `INSERT … WHERE NOT EXISTS` changes no rows and raises the same conflict a
   * lost UPDATE does.
   */
  async write(progress: WipeProgress): Promise<void> {
    const next = this.leaseSeq + 1;
    const changes = this.inserted
      ? await this.update(progress, next)
      : await this.insert(progress, next);
    if (changes === 0) throw new AccountWipeProgressConflictError(this.tenantId);
    this.leaseSeq = next;
    this.inserted = true;
  }

  private async insert(progress: WipeProgress, nextSeq: number): Promise<number> {
    const result = await this.db.run(
      `INSERT INTO wipe_progress (
         tenant_id, phase, lease_seq, updated_at_ms, vector_cursor, r2_cursor,
         force, objects_deleted, mutation_ids, index_count_sampled,
         index_count_start, probe_attempts, probe_saw_residue, continuations,
         completed_at_ms, residue
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM wipe_progress WHERE tenant_id = ?)`,
      this.tenantId,
      progress.phase,
      nextSeq,
      progress.updatedAtMs,
      progress.vectorCursor ?? null,
      progress.r2Cursor ?? null,
      progress.force ? 1 : 0,
      progress.objectsDeleted,
      JSON.stringify(progress.mutationIds),
      progress.indexCountSampled ? 1 : 0,
      progress.indexCountStart,
      progress.probeAttempts,
      progress.probeSawResidue ? 1 : 0,
      progress.continuations,
      progress.completedAtMs,
      progress.residue ? 1 : 0,
      this.tenantId,
    );
    return result.changes;
  }

  private async update(progress: WipeProgress, nextSeq: number): Promise<number> {
    const result = await this.db.run(
      `UPDATE wipe_progress
          SET phase = ?, lease_seq = ?, updated_at_ms = ?, vector_cursor = ?,
              r2_cursor = ?, force = ?, objects_deleted = ?, mutation_ids = ?,
              index_count_sampled = ?, index_count_start = ?, probe_attempts = ?,
              probe_saw_residue = ?, continuations = ?, completed_at_ms = ?,
              residue = ?
        WHERE tenant_id = ? AND lease_seq = ?`,
      progress.phase,
      nextSeq,
      progress.updatedAtMs,
      progress.vectorCursor ?? null,
      progress.r2Cursor ?? null,
      progress.force ? 1 : 0,
      progress.objectsDeleted,
      JSON.stringify(progress.mutationIds),
      progress.indexCountSampled ? 1 : 0,
      progress.indexCountStart,
      progress.probeAttempts,
      progress.probeSawResidue ? 1 : 0,
      progress.continuations,
      progress.completedAtMs,
      progress.residue ? 1 : 0,
      this.tenantId,
      this.leaseSeq,
    );
    return result.changes;
  }

  /**
   * The terminal transition. Writes the completion record and keeps it.
   *
   * Both cursors are cleared first: `vector_cursor` holds a reading id, and a
   * record that outlives the account must not. Everything else the record
   * carries is a count, a flag, or an opaque Vectorize mutation handle.
   */
  async complete(
    progress: WipeProgress,
    completedAtMs: number,
    residue: boolean,
  ): Promise<WipeProgress> {
    const done: WipeProgress = {
      ...progress,
      phase: "done",
      vectorCursor: undefined,
      r2Cursor: undefined,
      updatedAtMs: completedAtMs,
      completedAtMs,
      residue,
    };
    await this.write(done);
    return { ...done, leaseSeq: this.leaseSeq };
  }
}
