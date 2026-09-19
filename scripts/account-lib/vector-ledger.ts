/**
 * The durable per-tenant vector-id ledger and its confirmation rule
 * (issue #195 slice S3 / #261, migration `0010`).
 *
 * ## Operator-only, and D1-only, since slice 1c.4
 *
 * This used to live in `src/control-plane/`. Nothing in the candidate runtime
 * reaches it any more: an embedding is a row of `reading_embeddings` that
 * deletes with its reading in one transaction (ADR 0005), so the account wipe
 * has no ids to record, submit or confirm, and `vector_ledger` is not among
 * the tables migration `0003` recreates on PostgreSQL. What is left is the
 * offline operator paths that still upsert into Vectorize — `corpus
 * backfill-vectors`, `corpus seed-vector-ledger`, `account
 * audit-bare-vectors` and the batch write phase — which read and write the
 * table over wrangler D1. They live until the pre-cutover Vectorize index is
 * retired; porting or retiring them is `reading-lite-gh347.4`.
 *
 * Everything below describes that D1/Vectorize world and is kept verbatim,
 * because those commands still run in it.
 *
 * ## What it is for
 *
 * Vectorize has no list or scan at any scope: a vector can only be deleted by
 * an id you already hold. Before this table the account wipe derived its ids
 * from R2, which made every vector whose R2 objects went first permanently
 * unaddressable — review finding F3, and the four races
 * `src/account-wipe.ts`'s header enumerates. The ledger records the id BEFORE
 * the upsert at every writer site, so the id outlives the objects, and the
 * wipe's terminal condition becomes "no rows left for this tenant" instead of
 * "the R2 prefix is empty".
 *
 * A row's life is: `live` (a vector was or is about to be upserted) →
 * `delete_submitted` (`deleteByIds` was submitted) → deleted, once the
 * confirmation rule below says the vector is actually gone. There is no third
 * state: an empty ledger IS the claim that a tenant has no vectors.
 *
 * Migration 0012 removes the users foreign key so unconfirmed rows survive
 * control-plane teardown after a residue wipe. They remain repair evidence;
 * teardown must not delete them merely to allow the users row to disappear.
 *
 * ## The confirmation rule
 *
 * Measured on staging (report `rl-195-s6-staging-gate`, §3 and §5), not
 * assumed. Four things it insists on, each for its own reason:
 *
 * 1. **Two consecutive absences, spaced at least
 *    `VECTOR_LEDGER_MIN_CONFIRM_SPACING_MS` apart.** S6 saw zero transient
 *    empties in 131 samples, so a single absence is in practice already
 *    correct — but the failure it guards against is one-directional and
 *    unrecoverable. Clearing a row for a vector that is still live strands that
 *    vector forever, because the ledger is now the only id source. A false
 *    negative merely costs another pass. The SPACING is the load-bearing half:
 *    two calls back to back inside one isolate hit the same replica
 *    milliseconds apart and confirm nothing.
 *
 * 2. **A non-200 is no information.** 400, 429, 5xx, timeout — none of them is
 *    an absence, and each resets the streak. The 20-id REST cap makes this
 *    concrete rather than theoretical: a 21-id chunk answers 400 with an empty
 *    body, which a naive reader parses as "all 21 are gone".
 *
 * 3. **A partial result is per-id evidence only.** Ids returned by a 200 are
 *    live; ids that were in the request and missing from that 200 are
 *    candidate-absent. Nothing may be inferred about an id that was not in the
 *    request.
 *
 * 4. **`describe()` / `vectorCount` / `processedUpToMutation` appear nowhere in
 *    this file**, as a gate, a shortcut, or corroboration. S6 §3.5 measured all
 *    three going *backwards* between replicas while `getByIds` and the
 *    namespaced query reported the correct state throughout.
 *
 * The fast path (S6 §5.3) is one namespaced `query` with `topK = 1`. It cannot
 * say WHICH id survived — that is what the ledger is for — but if the namespace
 * answers nothing, no id in it can be live, and the tenant's whole ledger
 * clears in one call instead of `ceil(n / 20)`. Per-id `getByIds` is the
 * fallback for when the namespace still answers. That probe was in lockstep
 * with `getByIds` in every sample S6 took, and it is already the wipe's shipped
 * terminal gate.
 *
 * ## Timing
 *
 * S6 measured `deleteByIds` → absent at 30-90s across four independent cohorts,
 * every cohort flipping atomically. The constants below sit above that ceiling
 * with margin. The one that matters most is not the confirmation count but
 * `VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS`: the old code probed immediately,
 * which is inside the propagation window by construction, so every healthy wipe
 * burned one attempt on a hit that carried no information (defect D2).
 */
import { fromD1, type ControlPlaneDb } from "../../src/control-plane/db";
import { parseTenantId, type TenantContext, type TenantId } from "../../src/control-plane/ids";
import { VECTORIZE_GET_BY_IDS_MAX_IDS } from "../../src/modules/stores/similarity-store";

export type VectorLedgerState = "live" | "delete_submitted";

/**
 * A ledger write failed.
 *
 * Typed so the publish path can tell it apart from every other write it makes.
 * `commitTerminalManifest` reconciles visibility defensively — a failed list-row
 * or vector write is logged and swallowed, because the manifest is already
 * committed and a later pass repairs it. A failed LEDGER write must not be
 * treated that way: swallowing it leaves a published reading with no row, which
 * is a hole in the one record that says what vectors this tenant owns, and it
 * is invisible. Fail closed and let the delivery retry instead.
 */
export class VectorLedgerWriteError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly cause: unknown,
  ) {
    super(
      `vector_ledger write failed for ${tenantId}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = "VectorLedgerWriteError";
  }
}

/**
 * How long after `deleteByIds` returns before the first confirmation attempt is
 * allowed to count.
 *
 * S6 measured propagation at 30-90s (n = 4, all cohorts atomic); 120s is above
 * that ceiling. Probing earlier is not merely wasteful, it is misleading: the
 * hit is guaranteed and it consumes one of the four attempts the bound exists
 * to spend on real residue. This is the fix for S6 defect D2.
 */
export const VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS = 120_000;

/**
 * Delay after each unsuccessful confirmation attempt, indexed by attempts
 * already made. Doubling, capped at the last entry.
 *
 * The second attempt lands at ~t+240s, already ~2.7x the worst latency S6
 * observed; the cap keeps a genuinely stuck tenant off a hot loop.
 */
export const VECTOR_LEDGER_BACKOFF_MS = [120_000, 240_000, 480_000] as const;

/**
 * Minimum gap between the two absences that clear a row.
 *
 * S6 §3.5 saw `/info` flapping between replicas on a ~30s period, so 60s is
 * enough to land on a different one. Below this the second call is not a second
 * observation.
 */
export const VECTOR_LEDGER_MIN_CONFIRM_SPACING_MS = 60_000;

/** Consecutive spaced absences that clear a row. */
export const VECTOR_LEDGER_REQUIRED_ABSENCES = 2;

/**
 * `getByIds` request size. Single-homed with the other Vectorize API limits;
 * the measurement and the reason it is not 1000 are recorded there.
 */
export { VECTORIZE_GET_BY_IDS_MAX_IDS } from "../../src/modules/stores/similarity-store";

/** One tenant's ledger row. */
export interface VectorLedgerEntry {
  readingId: string;
  state: VectorLedgerState;
  upsertedAtMs: number;
  deletedAtMs: number | null;
  absentStreak: number;
  lastAbsentAtMs: number | null;
}

interface VectorLedgerRow {
  reading_id: string;
  state: string;
  upserted_at_ms: number;
  deleted_at_ms: number | null;
  absent_streak: number;
  last_absent_at_ms: number | null;
}

function parseState(value: string): VectorLedgerState {
  return value === "delete_submitted" ? "delete_submitted" : "live";
}

function toEntry(row: VectorLedgerRow): VectorLedgerEntry {
  return {
    readingId: row.reading_id,
    state: parseState(row.state),
    upsertedAtMs: row.upserted_at_ms,
    deletedAtMs: row.deleted_at_ms,
    absentStreak: row.absent_streak,
    lastAbsentAtMs: row.last_absent_at_ms,
  };
}

/**
 * The write half, as every vector writer sees it.
 *
 * Deliberately narrow, and deliberately not the D1 handle: three of the five
 * writer sites are offline operator scripts reaching D1 through the wrangler
 * CLI, and one of them (`--tenant global`) has no tenant id to key rows by at
 * all. An interface lets that case be an explicit no-op rather than a
 * conditional threaded through every call site.
 */
export interface VectorLedger {
  /**
   * Record these ids as carrying a live vector. MUST be awaited BEFORE the
   * upsert it describes: a row written after a crashed upsert is the stranding
   * this ledger exists to prevent, and a row written for an upsert that never
   * happens costs only a redundant `deleteByIds` for an id Vectorize does not
   * hold.
   */
  markLive(readingIds: readonly string[], nowMs: number): Promise<void>;
  /**
   * Record that `deleteByIds` was submitted for these ids. Called AFTER the
   * submission, because `deleted_at_ms` is what the +120s first-confirmation
   * delay is measured from and it must stamp when the delete was actually
   * asked for.
   */
  markDeleteSubmitted(readingIds: readonly string[], nowMs: number): Promise<void>;
}

/**
 * The ledger for scopes that have no tenant to key rows by — `--tenant global`
 * on the operator commands, and plan mode everywhere.
 *
 * The pre-tenant corpus is un-namespaced and outside every tenant key root, so
 * no account wipe addresses it (see the CLAUDE.md gotcha and S7); ledgering it
 * would create rows for a tenant id that does not exist.
 */
export const NO_OP_VECTOR_LEDGER: VectorLedger = {
  async markLive() {},
  async markDeleteSubmitted() {},
};

/**
 * Reading ids per statement.
 *
 * Two limits meet here and the smaller one wins. SQLite caps bound parameters
 * per statement (D1 is conservative about it), and the offline operator path
 * reaches D1 through `makeWranglerD1`, whose `batch()` spawns one
 * `wrangler d1 execute --remote` subprocess PER STATEMENT. So a one-statement-
 * per-id shape would make `ops corpus seed-vector-ledger` spawn one subprocess
 * and one remote round trip per reading — minutes to hours on a real corpus,
 * on a command that is a rollout prerequisite. Every write below is therefore
 * ONE multi-row statement per chunk, and the chunk is sized so the widest of
 * them (4 parameters a row) stays well inside the parameter cap.
 */
export const VECTOR_LEDGER_WRITE_CHUNK = 20;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    out.push(items.slice(offset, offset + size));
  }
  return out;
}

/** D1-backed ledger for one tenant. */
export function d1VectorLedger(db: ControlPlaneDb, tenantId: TenantId): VectorLedger {
  // Every failure leaves this module as a VectorLedgerWriteError, so callers can
  // distinguish "the ledger did not record this" from any other write they make
  // in the same breath. See the class comment for why that distinction matters
  // on the publish path.
  const guarded = async (write: () => Promise<void>): Promise<void> => {
    try {
      await write();
    } catch (error) {
      throw new VectorLedgerWriteError(tenantId, error);
    }
  };
  return {
    markLive: (readingIds, nowMs) => guarded(async () => {
      // Re-marking an id `live` resets its delete bookkeeping, and that is the
      // point: a reading re-published after a delete was submitted for it has a
      // NEW vector, and carrying the old `deleted_at_ms` or absent streak
      // forward would let a confirmation about the previous vector clear a row
      // describing the current one.
      for (const chunk of chunked(dedupe(readingIds), VECTOR_LEDGER_WRITE_CHUNK)) {
        const values = chunk.map(() => "(?, ?, 'live', ?, NULL, 0, NULL)").join(", ");
        await db.run(
          `INSERT INTO vector_ledger (
             tenant_id, reading_id, state, upserted_at_ms, deleted_at_ms,
             absent_streak, last_absent_at_ms
           ) VALUES ${values}
           ON CONFLICT (tenant_id, reading_id) DO UPDATE SET
             state = 'live',
             upserted_at_ms = excluded.upserted_at_ms,
             deleted_at_ms = NULL,
             absent_streak = 0,
             last_absent_at_ms = NULL`,
          ...chunk.flatMap((readingId) => [tenantId, readingId, nowMs]),
        );
      }
    }),
    markDeleteSubmitted: (readingIds, nowMs) => guarded(async () => {
      // INSERT-or-update, not a bare UPDATE. A delete submitted for an id with
      // no ledger row (a pre-ledger reading, a purge racing a seed) still needs
      // its id kept: that id is the only thing that can address the vector if
      // the delete did not take.
      for (const chunk of chunked(dedupe(readingIds), VECTOR_LEDGER_WRITE_CHUNK)) {
        const values = chunk.map(() => "(?, ?, 'delete_submitted', ?, ?, 0, NULL)").join(", ");
        await db.run(
          `INSERT INTO vector_ledger (
             tenant_id, reading_id, state, upserted_at_ms, deleted_at_ms,
             absent_streak, last_absent_at_ms
           ) VALUES ${values}
           ON CONFLICT (tenant_id, reading_id) DO UPDATE SET
             state = 'delete_submitted',
             deleted_at_ms = excluded.deleted_at_ms,
             absent_streak = 0,
             last_absent_at_ms = NULL`,
          ...chunk.flatMap((readingId) => [tenantId, readingId, nowMs, nowMs]),
        );
      }
    }),
  };
}

/**
 * The ledger for a tenant in hosted code, or null when there is nothing to
 * ledger into.
 *
 * Null on an unbound `CONTROL_PLANE` (local `wrangler dev` and the Node-pool
 * tests) and on a malformed tenant id. Both are configurations with no account
 * wipe to feed, so a null ledger costs nothing — and a throwing one would take
 * down the publish path over bookkeeping.
 */
export function vectorLedgerFor(
  env: { CONTROL_PLANE?: D1Database },
  tenant: TenantContext,
): VectorLedger | null {
  if (!env.CONTROL_PLANE) return null;
  const tenantId = parseTenantId(String(tenant.tenantId));
  if (!tenantId) return null;
  return d1VectorLedger(fromD1(env.CONTROL_PLANE), tenantId);
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}

/**
 * Record ids that have no row yet, and touch nothing that does.
 *
 * The account wipe's seed phase derives ids from R2 while R2 still exists and
 * calls this before deleting anything, so the ledger's coverage is established
 * rather than asserted. Two properties make it safe to run over a corpus that
 * is already partly ledgered:
 *
 * - `ON CONFLICT DO NOTHING`, not `markLive`. A row already moved to
 *   `delete_submitted` by an earlier pass keeps its state, its delete stamp and
 *   its absent streak. Re-marking it `live` would restart the confirmation
 *   clock and force a redundant re-submit on every resume.
 * - It never deletes. An id derived from R2 for a reading with no vector costs
 *   one no-op `deleteByIds` later; a missing row costs a vector nobody can
 *   address. The asymmetry is the whole reason to over-record.
 *
 * @returns how many rows were actually created — the observability that tells
 * an operator a supposedly-seeded tenant was not.
 */
export async function insertMissingLedgerRows(
  db: ControlPlaneDb,
  tenantId: TenantId,
  readingIds: readonly string[],
  nowMs: number,
): Promise<number> {
  let created = 0;
  for (const chunk of chunked(dedupe(readingIds), VECTOR_LEDGER_WRITE_CHUNK)) {
    const values = chunk.map(() => "(?, ?, 'live', ?, NULL, 0, NULL)").join(", ");
    const result = await db.run(
      `INSERT INTO vector_ledger (
         tenant_id, reading_id, state, upserted_at_ms, deleted_at_ms,
         absent_streak, last_absent_at_ms
       ) VALUES ${values}
       ON CONFLICT (tenant_id, reading_id) DO NOTHING`,
      ...chunk.flatMap((readingId) => [tenantId, readingId, nowMs]),
    );
    created += result.changes;
  }
  return created;
}

/** Ids still carrying a live vector, oldest first, bounded. */
export async function listLiveLedgerIds(
  db: ControlPlaneDb,
  tenantId: TenantId,
  limit: number,
): Promise<string[]> {
  const rows = await db.all<{ reading_id: string }>(
    `SELECT reading_id FROM vector_ledger
      WHERE tenant_id = ? AND state = 'live'
      ORDER BY reading_id
      LIMIT ?`,
    tenantId,
    limit,
  );
  return rows.map((row) => row.reading_id);
}

/** Rows awaiting confirmation, oldest submission first, bounded. */
export async function listDeleteSubmittedEntries(
  db: ControlPlaneDb,
  tenantId: TenantId,
  limit: number,
): Promise<VectorLedgerEntry[]> {
  const rows = await db.all<VectorLedgerRow>(
    `SELECT reading_id, state, upserted_at_ms, deleted_at_ms, absent_streak, last_absent_at_ms
       FROM vector_ledger
      WHERE tenant_id = ? AND state = 'delete_submitted'
      ORDER BY deleted_at_ms, reading_id
      LIMIT ?`,
    tenantId,
    limit,
  );
  return rows.map(toEntry);
}

/** How many rows of each kind this tenant still has. */
export async function countLedgerRows(
  db: ControlPlaneDb,
  tenantId: TenantId,
): Promise<{ live: number; deleteSubmitted: number; total: number }> {
  const row = await db.first<{ live: number; delete_submitted: number }>(
    `SELECT
       SUM(CASE WHEN state = 'live' THEN 1 ELSE 0 END) AS live,
       SUM(CASE WHEN state = 'delete_submitted' THEN 1 ELSE 0 END) AS delete_submitted
     FROM vector_ledger WHERE tenant_id = ?`,
    tenantId,
  );
  const live = row?.live ?? 0;
  const deleteSubmitted = row?.delete_submitted ?? 0;
  return { live, deleteSubmitted, total: live + deleteSubmitted };
}

/**
 * Remove specific rows: the vector is confirmed gone.
 *
 * Scoped to `state = 'delete_submitted'` AND to the exact `deleted_at_ms` the
 * observation was made against, and both halves are load-bearing. A reading
 * re-published between the `getByIds` that observed its absence and this DELETE
 * has a brand-new vector and a fresh `live` row; deleting it because a *previous*
 * vector was confirmed gone would strand the new one — the precise failure the
 * ledger exists to prevent, reintroduced by the code meant to close it. A
 * changed stamp means the row is no longer the one that was observed, so it is
 * left alone and the next pass observes it properly.
 */
export async function clearLedgerRows(
  db: ControlPlaneDb,
  tenantId: TenantId,
  cleared: ReadonlyArray<{ readingId: string; deletedAtMs: number }>,
): Promise<void> {
  const seen = new Set<string>();
  const rows = cleared.filter((row) => {
    if (row.readingId.length === 0 || seen.has(row.readingId)) return false;
    seen.add(row.readingId);
    return true;
  });
  for (const chunk of chunked(rows, VECTOR_LEDGER_WRITE_CHUNK)) {
    const predicate = chunk.map(() => "(reading_id = ? AND deleted_at_ms = ?)").join(" OR ");
    await db.run(
      `DELETE FROM vector_ledger
        WHERE tenant_id = ? AND state = 'delete_submitted' AND (${predicate})`,
      tenantId,
      ...chunk.flatMap((row) => [row.readingId, row.deletedAtMs]),
    );
  }
}

/**
 * Remove this tenant's confirmed rows — the fast path's one call.
 *
 * Only ever reached from a 200 namespaced `query` that returned nothing: no id
 * in a namespace can be live when the namespace itself answers nothing.
 *
 * Scoped to `delete_submitted` for the same reason `clearLedgerRows` is. The
 * probe happens between the row count and this DELETE, and a publisher or an
 * offline writer can insert a `live` row inside that window — a vector that has
 * never been submitted to `deleteByIds` and that the empty probe therefore says
 * nothing about. Clearing it here would delete the only record of it.
 */
export async function clearTenantLedger(
  db: ControlPlaneDb,
  tenantId: TenantId,
  /**
   * When the probe that authorizes this clear was taken.
   *
   * Rows whose delete was submitted AFTER that instant are left alone: an empty
   * probe is evidence about the namespace at the moment it ran and says nothing
   * about a vector deleted a second later, so clearing such a row would drop an
   * id on no evidence at all — the stranding this table exists to prevent, in
   * miniature. A concurrent purge or publisher-fence delete on the same tenant
   * is exactly how that row appears.
   */
  probedAtMs: number,
): Promise<number> {
  // Two floors, and they answer different questions.
  //
  // `<= probedAtMs` is about EVIDENCE: a delete submitted after the probe was
  // taken is not something the probe saw.
  //
  // `<= probedAtMs - VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS` is about
  // PROPAGATION, and it is the one that was missing. S6 measured
  // `deleteByIds` taking 30-90s to become visible, which is why no per-id
  // absence counts inside 120s — and an empty namespace query is subject to
  // exactly the same lag. Without this floor the fast path would clear a row
  // whose delete was submitted seconds earlier on a probe that could not yet
  // have seen it either way, which is the weakest evidence in the module
  // clearing the most rows at once.
  //
  // A row younger than the floor simply survives to the next pass, where it is
  // old enough to be judged.
  const result = await db.run(
    `DELETE FROM vector_ledger
      WHERE tenant_id = ? AND state = 'delete_submitted'
        AND deleted_at_ms IS NOT NULL AND deleted_at_ms <= ?`,
    tenantId,
    probedAtMs - VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS,
  );
  return result.changes;
}

/**
 * Persist advanced streaks, in as few statements as the parameter budget allows.
 *
 * `state = 'delete_submitted'` again: a row re-marked `live` between the
 * observation and this write describes a different vector, and stamping it with
 * an absence observed about the previous one is how a later pass would clear it
 * early.
 */
export async function recordAbsences(
  db: ControlPlaneDb,
  tenantId: TenantId,
  advanced: ReadonlyArray<{ readingId: string; absentStreak: number }>,
  lastAbsentAtMs: number,
): Promise<void> {
  // Grouped by streak so one UPDATE covers every row moving to the same value.
  // In practice there is only ever one group (the streak is 1 on the way to 2,
  // and 2 clears rather than advancing), so this is one statement per pass.
  const byStreak = new Map<number, string[]>();
  for (const row of advanced) {
    const bucket = byStreak.get(row.absentStreak) ?? [];
    bucket.push(row.readingId);
    byStreak.set(row.absentStreak, bucket);
  }
  for (const [absentStreak, ids] of byStreak) {
    for (const chunk of chunked(dedupe(ids), VECTOR_LEDGER_WRITE_CHUNK)) {
      const placeholders = chunk.map(() => "?").join(", ");
      await db.run(
        `UPDATE vector_ledger SET absent_streak = ?, last_absent_at_ms = ?
          WHERE tenant_id = ? AND state = 'delete_submitted'
            AND reading_id IN (${placeholders})`,
        absentStreak,
        lastAbsentAtMs,
        tenantId,
        ...chunk,
      );
    }
  }
}

/** Reset a row's streak: it was seen live, or the call carried no information. */
export async function resetAbsenceStreaks(
  db: ControlPlaneDb,
  tenantId: TenantId,
  readingIds: readonly string[],
): Promise<void> {
  for (const chunk of chunked(dedupe(readingIds), VECTOR_LEDGER_WRITE_CHUNK)) {
    const placeholders = chunk.map(() => "?").join(", ");
    await db.run(
      `UPDATE vector_ledger SET absent_streak = 0, last_absent_at_ms = NULL
        WHERE tenant_id = ? AND state = 'delete_submitted'
          AND reading_id IN (${placeholders})`,
      tenantId,
      ...chunk,
    );
  }
}

// ---------------------------------------------------------------------------
// The confirmation rule, as pure functions.
//
// Kept free of D1 and of Vectorize so the rule itself is testable without
// either. The wipe supplies observations; these decide what they mean.
// ---------------------------------------------------------------------------

/**
 * What one `getByIds` call produced.
 *
 * `ok: false` is EVERY non-success — a non-200 status, a timeout, a thrown
 * binding error. It carries no `present`/`requested` split on purpose: there is
 * nothing to split, because the call observed nothing.
 */
export type GetByIdsObservation =
  | { ok: true; requested: readonly string[]; present: readonly string[] }
  | { ok: false; requested: readonly string[]; reason: string };

export interface AbsenceVerdict {
  /**
   * Rows to delete: the streak reached `VECTOR_LEDGER_REQUIRED_ABSENCES`.
   *
   * Carries the `deleted_at_ms` the observation was made against, so the DELETE
   * can refuse a row that has been re-marked since — a re-published reading has
   * a new vector, and clearing its row on a confirmation about the old one
   * would strand it.
   */
  clear: Array<{ readingId: string; deletedAtMs: number }>;
  /** Rows whose streak advanced but has not yet reached the bar. */
  advanced: Array<{ readingId: string; absentStreak: number }>;
  /** Rows whose streak must go back to zero. */
  reset: string[];
}

/**
 * Apply one observation to the rows it covers.
 *
 * The three rules of §5.1, in order:
 *
 * - A failed call resets every row it asked about and confirms nothing. It is
 *   NOT treated as "all absent", which is the trap the 20-id cap sets.
 * - Within a successful call, an id that came back is live: its streak resets.
 *   An id that was asked for and did not come back is a candidate absence.
 * - A candidate absence counts only if it is at least
 *   `VECTOR_LEDGER_MIN_CONFIRM_SPACING_MS` after the previously counted one,
 *   and at least `VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS` after the delete was
 *   submitted. An absence that is too early is neither counted nor a reset —
 *   it is simply not an observation.
 *
 * Ids absent from `observation.requested` are never touched: nothing may be
 * inferred about an id that was not asked about.
 */
export function applyAbsenceObservation(
  entries: readonly VectorLedgerEntry[],
  observation: GetByIdsObservation,
  nowMs: number,
): AbsenceVerdict {
  const verdict: AbsenceVerdict = { clear: [], advanced: [], reset: [] };
  const requested = new Set(observation.requested);
  const covered = entries.filter((entry) => requested.has(entry.readingId));
  if (!observation.ok) {
    // No information. Reset only rows that had a streak to lose — an UPDATE per
    // id on every transient failure would be a write amplifier for nothing.
    for (const entry of covered) {
      if (entry.absentStreak > 0) verdict.reset.push(entry.readingId);
    }
    return verdict;
  }
  const present = new Set(observation.present);
  for (const entry of covered) {
    if (present.has(entry.readingId)) {
      if (entry.absentStreak > 0) verdict.reset.push(entry.readingId);
      continue;
    }
    if (!absenceCounts(entry, nowMs)) continue;
    const next = entry.absentStreak + 1;
    if (next >= VECTOR_LEDGER_REQUIRED_ABSENCES) {
      // `absenceCounts` already refused a null stamp, so this is non-null.
      verdict.clear.push({ readingId: entry.readingId, deletedAtMs: entry.deletedAtMs! });
    } else {
      verdict.advanced.push({ readingId: entry.readingId, absentStreak: next });
    }
  }
  return verdict;
}

/**
 * Is this absence old enough to count?
 *
 * Two gates, and they answer different questions. The first says the delete has
 * had time to propagate at all (S6 measured 30-90s; we wait 120s). The second
 * says this observation is a genuinely separate one from the last counted
 * absence rather than a second read of the same replica.
 */
export function absenceCounts(entry: VectorLedgerEntry, nowMs: number): boolean {
  // A `delete_submitted` row with no stamp cannot be aged. Refusing to count it
  // is the safe direction: the row survives, the id stays addressable, and the
  // next `deleteByIds` re-stamps it.
  if (entry.deletedAtMs === null) return false;
  if (nowMs - entry.deletedAtMs < VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS) return false;
  if (entry.lastAbsentAtMs === null) return true;
  return nowMs - entry.lastAbsentAtMs >= VECTOR_LEDGER_MIN_CONFIRM_SPACING_MS;
}

/**
 * The earliest instant at which any of these rows could be confirmed.
 *
 * `null` when one is already due. Used to defer a confirmation pass rather than
 * spend an attempt on a probe that cannot count (defect D2).
 */
export function earliestConfirmableAtMs(
  entries: readonly VectorLedgerEntry[],
  nowMs: number,
): number | null {
  let earliest: number | null = null;
  for (const entry of entries) {
    if (absenceCounts(entry, nowMs)) return null;
    const due =
      entry.deletedAtMs === null
        ? null
        : Math.max(
            entry.deletedAtMs + VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS,
            entry.lastAbsentAtMs === null
              ? 0
              : entry.lastAbsentAtMs + VECTOR_LEDGER_MIN_CONFIRM_SPACING_MS,
          );
    if (due === null) continue;
    if (earliest === null || due < earliest) earliest = due;
  }
  return earliest;
}

/** Backoff after `attempts` unsuccessful confirmation attempts, in seconds. */
export function confirmBackoffSeconds(attempts: number): number {
  const index = Math.min(Math.max(0, attempts - 1), VECTOR_LEDGER_BACKOFF_MS.length - 1);
  return Math.ceil(VECTOR_LEDGER_BACKOFF_MS[index]! / 1000);
}

/** Split ids into `getByIds`-sized requests. */
export function chunkForGetByIds(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += VECTORIZE_GET_BY_IDS_MAX_IDS) {
    chunks.push(ids.slice(offset, offset + VECTORIZE_GET_BY_IDS_MAX_IDS));
  }
  return chunks;
}
