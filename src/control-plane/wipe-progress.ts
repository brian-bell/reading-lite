/**
 * Account-wipe progress, lease, and completion record (issue 195 S2; on
 * PostgreSQL since slice 1c.2, ADR 0005).
 *
 * This is the whole of the wipe's durable state.
 *
 * ## Phases
 *
 * `rows` deletes the tenant's reading rows — embeddings, revisions, URLs,
 * relationships and attempts by cascade — and its `relationship_refresh_jobs`
 * and `tension_refresh_jobs` checkpoints, and advances the phase, all in one
 * transaction. `objects` pages
 * the tenant's R2 prefix. `done` is terminal. Rows go first: a reading whose
 * objects outlive its row is invisible, where the reverse would be a listed
 * reading whose content 404s. D1's `vectors` phase, its Vectorize bookkeeping
 * (mutation ids, index baseline, probes) and the ledger seed have no
 * counterpart: an embedding is a row now, so there is nothing to submit,
 * confirm or seed.
 *
 * Because the phase advance shares the deletes' transaction, a row that reads
 * `objects` is reporting a fact a resuming delivery can rely on, not an
 * intention that a crash could have left half-done.
 *
 * ## The lease is a version, not a timestamp
 *
 * Every write is `UPDATE … WHERE tenant_id = ? AND lease_seq = ?` and bumps
 * `lease_seq`. Zero rows changed means the row moved under us (a sibling
 * delivery owns this wipe) and the writer throws
 * `AccountWipeProgressConflictError` rather than re-reading and re-applying.
 * Re-applying would be the clobber the CAS exists to prevent. So neither a
 * frozen job clock nor a long delayed retry can corrupt a cursor: whichever
 * writer bumps first owns the wipe, and the other is told so.
 *
 * `updated_at` is advice only: cron uses it to avoid enqueuing a duplicate it
 * would only have to turn away.
 *
 * ## The record outlives the wipe on purpose
 *
 * The row is keyed by a tenant whose `users` row is still present until S4's
 * teardown, and `complete()` clears the cursor, so the finished record names
 * no reading. Keeping it lets fan-out ask "was this tenant wiped?" directly,
 * and teardown's hard delete of the `users` row gates on `completed_at`, which
 * is also why the foreign key does not cascade.
 *
 * The completion is stored as TWO pairs, because they answer different
 * questions and a reopen must not conflate them:
 *
 * - `completedAtMs`/`residue` are the current state: this wipe has nothing
 *   left to do. A reopen clears them, so teardown does not hard-delete the
 *   users row while a reopened pass runs.
 * - `firstCompletedAtMs`/`firstResidue` are the durable history, written once
 *   at the first terminal transition and pinned in SQL thereafter, so a reopen
 *   that never finishes cannot leave the row claiming this tenant was never
 *   wiped.
 *
 * `residue` recorded, on D1, that Vectorize never confirmed a namespace
 * clean. A PostgreSQL wipe has no such unknown and always writes false; the
 * columns stay for the history imported from D1 (#348).
 */
import { isUniqueConstraintError, type ControlPlaneDb } from "./db";
import type { TenantId } from "./ids";
import { fromTimestamp, toTimestamp } from "./pg-time";

export type WipePhase = "rows" | "objects" | "done";

/** One tenant's wipe state as stored. */
export interface WipeProgress {
  phase: WipePhase;
  leaseSeq: number;
  updatedAtMs: number;
  r2Cursor?: string;
  force: boolean;
  objectsDeleted: number;
  continuations: number;
  /** Current state: nothing left to do. Cleared by a reopen. */
  completedAtMs: number | null;
  residue: boolean;
  /** Durable history: the FIRST terminal transition, never overwritten. */
  firstCompletedAtMs: number | null;
  firstResidue: boolean;
}

/**
 * A sibling delivery owns this wipe: our conditional UPDATE changed no rows.
 *
 * Not a failure to retry into the DLQ. The caller turns it into a `lease_held`
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
  updated_at: string;
  r2_cursor: string | null;
  force: boolean;
  objects_deleted: number;
  continuations: number;
  completed_at: string | null;
  residue: boolean;
  first_completed_at: string | null;
  first_residue: boolean;
}

const COLUMNS = `phase, lease_seq, updated_at, r2_cursor, force, objects_deleted, continuations,
    completed_at, residue, first_completed_at, first_residue`;

function parsePhase(value: string): WipePhase {
  return value === "objects" || value === "done" ? value : "rows";
}

function toProgress(row: WipeProgressRow): WipeProgress {
  return {
    phase: parsePhase(row.phase),
    leaseSeq: row.lease_seq,
    updatedAtMs: fromTimestamp(row.updated_at),
    r2Cursor: row.r2_cursor ?? undefined,
    force: row.force,
    objectsDeleted: row.objects_deleted,
    continuations: row.continuations,
    completedAtMs: fromTimestamp(row.completed_at),
    residue: row.residue,
    firstCompletedAtMs: fromTimestamp(row.first_completed_at),
    firstResidue: row.first_residue,
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
    `SELECT tenant_id, ${COLUMNS} FROM wipe_progress WHERE completed_at IS NULL`,
  );
  return new Map(rows.map((row) => [row.tenant_id, toProgress(row)]));
}

/** The state a brand-new wipe starts in. Not yet written. */
export function emptyWipeProgress(nowMs: number, force = false): WipeProgress {
  return {
    phase: "rows",
    leaseSeq: 0,
    updatedAtMs: nowMs,
    force,
    objectsDeleted: 0,
    continuations: 0,
    completedAtMs: null,
    residue: false,
    firstCompletedAtMs: null,
    firstResidue: false,
  };
}

/**
 * A finished wipe with leftover objects under its prefix is reopened as a
 * fresh pass from `rows`: new continuation budget, cursor cleared. Leftover
 * objects may come with rows a late writer added, so the pass deletes rows
 * again before it touches R2.
 *
 * `leaseSeq` is preserved: it is the row's identity for the CAS, not part of
 * the wipe's state. `firstCompletedAtMs`/`firstResidue` are preserved too, and
 * that is the point of their existing: if this reopen's enqueue fails, or the
 * new pass dead-letters, the row still shows the earlier wipe finished.
 */
export function reopenWipeProgress(progress: WipeProgress, force: boolean): WipeProgress {
  return {
    ...progress,
    phase: "rows",
    r2Cursor: undefined,
    force,
    continuations: 0,
    completedAtMs: null,
    residue: false,
    firstCompletedAtMs: progress.firstCompletedAtMs,
    firstResidue: progress.firstResidue,
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
   * inserter loses on the primary key rather than silently overwriting.
   *
   * The insert also requires the `users` row to still exist (issue 195 S4).
   * Queues are at-least-once, so a redelivered wipe job can read `users` as
   * `deleting` just before teardown commits and then try to insert a fresh
   * row for an account that is already gone. PostgreSQL's foreign key would
   * refuse it with an error; the guard turns that into the ordinary conflict,
   * which acks, and acking is the right answer for a wipe whose tenant no
   * longer exists.
   *
   * `db` overrides the writer's own handle for this one write, so the caller
   * can put the CAS inside a transaction it is already holding. The wipe's
   * `rows` phase does exactly that: the reading deletes, the refresh-checkpoint
   * delete and the phase advance commit together or not at all. The CAS goes
   * LAST in such a transaction — a conflict then rolls the deletes back
   * instead of leaving a sibling's wipe half-advanced, and `leaseSeq` is only
   * advanced by a write that returned, so a rollback after it would leave this
   * writer stale. That is safe because the delivery throws out of the
   * transaction and the next one re-reads the row.
   */
  async write(progress: WipeProgress, db: ControlPlaneDb = this.db): Promise<void> {
    const next = this.leaseSeq + 1;
    const changes = this.inserted
      ? await this.update(db, progress, next)
      : await this.insert(db, progress, next);
    if (changes === 0) throw new AccountWipeProgressConflictError(this.tenantId);
    this.leaseSeq = next;
    this.inserted = true;
  }

  private async insert(db: ControlPlaneDb, progress: WipeProgress, nextSeq: number): Promise<number> {
    try {
      return await this.insertRow(db, progress, nextSeq);
    } catch (error) {
      // Under READ COMMITTED two inserters can both pass NOT EXISTS; the loser
      // then fails on the primary key. Same outcome as a lost update: someone
      // else created this row first.
      if (isUniqueConstraintError(error)) return 0;
      throw error;
    }
  }

  private async insertRow(db: ControlPlaneDb, progress: WipeProgress, nextSeq: number): Promise<number> {
    const result = await db.run(
      `INSERT INTO wipe_progress (
         tenant_id, phase, lease_seq, updated_at, r2_cursor, force, objects_deleted,
         continuations, completed_at, residue, first_completed_at, first_residue
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM wipe_progress WHERE tenant_id = ?)
         AND EXISTS (SELECT 1 FROM users WHERE id = ?)`,
      this.tenantId,
      progress.phase,
      nextSeq,
      toTimestamp(progress.updatedAtMs),
      progress.r2Cursor ?? null,
      progress.force,
      progress.objectsDeleted,
      progress.continuations,
      toTimestamp(progress.completedAtMs),
      progress.residue,
      toTimestamp(progress.firstCompletedAtMs),
      progress.firstResidue,
      this.tenantId,
      this.tenantId,
    );
    return result.changes;
  }

  private async update(db: ControlPlaneDb, progress: WipeProgress, nextSeq: number): Promise<number> {
    const result = await db.run(
      `UPDATE wipe_progress
          SET phase = ?, lease_seq = ?, updated_at = ?, r2_cursor = ?, force = ?,
              objects_deleted = ?, continuations = ?, completed_at = ?, residue = ?,
              -- Write-once, enforced here rather than only in the caller: every
              -- SET expression reads the pre-UPDATE row, so once
              -- first_completed_at is set these two are pinned for the life of
              -- the row and no later write, reopen included, can move them.
              first_completed_at = COALESCE(first_completed_at, ?),
              first_residue = CASE
                WHEN first_completed_at IS NULL THEN ?
                ELSE first_residue
              END
        WHERE tenant_id = ? AND lease_seq = ?`,
      progress.phase,
      nextSeq,
      toTimestamp(progress.updatedAtMs),
      progress.r2Cursor ?? null,
      progress.force,
      progress.objectsDeleted,
      progress.continuations,
      toTimestamp(progress.completedAtMs),
      progress.residue,
      toTimestamp(progress.firstCompletedAtMs),
      progress.firstResidue,
      this.tenantId,
      this.leaseSeq,
    );
    return result.changes;
  }

  /**
   * The terminal transition. Writes the completion record and keeps it, with
   * the R2 cursor cleared.
   *
   * `firstCompletedAtMs`/`firstResidue` are set only if this is the row's
   * first ever completion, and the UPDATE pins them in SQL as well.
   */
  async complete(
    progress: WipeProgress,
    completedAtMs: number,
    residue: boolean,
    db: ControlPlaneDb = this.db,
  ): Promise<WipeProgress> {
    const first = progress.firstCompletedAtMs === null;
    const done: WipeProgress = {
      ...progress,
      phase: "done",
      r2Cursor: undefined,
      updatedAtMs: completedAtMs,
      completedAtMs,
      residue,
      firstCompletedAtMs: first ? completedAtMs : progress.firstCompletedAtMs,
      firstResidue: first ? residue : progress.firstResidue,
    };
    await this.write(done, db);
    return { ...done, leaseSeq: this.leaseSeq };
  }
}
