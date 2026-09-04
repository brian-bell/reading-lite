/**
 * The durable per-tenant vector-id ledger and its confirmation rule
 * (issue #195 slice S3 / #261, migration `0010`).
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
import { fromD1, type ControlPlaneDb } from "./db";
import { parseTenantId, type TenantContext, type TenantId } from "./ids";
import { VECTORIZE_GET_BY_IDS_MAX_IDS } from "../modules/stores/similarity-store";

export type VectorLedgerState = "live" | "delete_submitted";

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
export { VECTORIZE_GET_BY_IDS_MAX_IDS } from "../modules/stores/similarity-store";

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

/** D1-backed ledger for one tenant. */
export function d1VectorLedger(db: ControlPlaneDb, tenantId: TenantId): VectorLedger {
  return {
    async markLive(readingIds, nowMs) {
      const ids = dedupe(readingIds);
      if (ids.length === 0) return;
      // Re-marking an id `live` resets its delete bookkeeping, and that is the
      // point: a reading re-published after a delete was submitted for it has a
      // NEW vector, and carrying the old `deleted_at_ms` or absent streak
      // forward would let a confirmation about the previous vector clear a row
      // describing the current one.
      await db.batch(
        ids.map((readingId) => ({
          sql: `INSERT INTO vector_ledger (
                  tenant_id, reading_id, state, upserted_at_ms, deleted_at_ms,
                  absent_streak, last_absent_at_ms
                ) VALUES (?, ?, 'live', ?, NULL, 0, NULL)
                ON CONFLICT (tenant_id, reading_id) DO UPDATE SET
                  state = 'live',
                  upserted_at_ms = excluded.upserted_at_ms,
                  deleted_at_ms = NULL,
                  absent_streak = 0,
                  last_absent_at_ms = NULL`,
          params: [tenantId, readingId, nowMs],
        })),
      );
    },
    async markDeleteSubmitted(readingIds, nowMs) {
      const ids = dedupe(readingIds);
      if (ids.length === 0) return;
      // INSERT-or-update, not a bare UPDATE. A delete submitted for an id with
      // no ledger row (a pre-ledger reading, a purge racing a seed) still needs
      // its id kept: that id is the only thing that can address the vector if
      // the delete did not take.
      await db.batch(
        ids.map((readingId) => ({
          sql: `INSERT INTO vector_ledger (
                  tenant_id, reading_id, state, upserted_at_ms, deleted_at_ms,
                  absent_streak, last_absent_at_ms
                ) VALUES (?, ?, 'delete_submitted', ?, ?, 0, NULL)
                ON CONFLICT (tenant_id, reading_id) DO UPDATE SET
                  state = 'delete_submitted',
                  deleted_at_ms = excluded.deleted_at_ms,
                  absent_streak = 0,
                  last_absent_at_ms = NULL`,
          params: [tenantId, readingId, nowMs, nowMs],
        })),
      );
    },
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

/** Remove specific rows: the vector is confirmed gone. */
export async function clearLedgerRows(
  db: ControlPlaneDb,
  tenantId: TenantId,
  readingIds: readonly string[],
): Promise<void> {
  const ids = dedupe(readingIds);
  if (ids.length === 0) return;
  await db.batch(
    ids.map((readingId) => ({
      sql: `DELETE FROM vector_ledger WHERE tenant_id = ? AND reading_id = ?`,
      params: [tenantId, readingId],
    })),
  );
}

/**
 * Remove every row for a tenant — the fast path's one call.
 *
 * Only ever reached from a 200 namespaced `query` that returned nothing: no id
 * in a namespace can be live when the namespace itself answers nothing.
 */
export async function clearTenantLedger(
  db: ControlPlaneDb,
  tenantId: TenantId,
): Promise<number> {
  const result = await db.run(`DELETE FROM vector_ledger WHERE tenant_id = ?`, tenantId);
  return result.changes;
}

/** Persist an updated streak for one row. */
export async function recordAbsence(
  db: ControlPlaneDb,
  tenantId: TenantId,
  readingId: string,
  absentStreak: number,
  lastAbsentAtMs: number,
): Promise<void> {
  await db.run(
    `UPDATE vector_ledger SET absent_streak = ?, last_absent_at_ms = ?
      WHERE tenant_id = ? AND reading_id = ?`,
    absentStreak,
    lastAbsentAtMs,
    tenantId,
    readingId,
  );
}

/** Reset a row's streak: it was seen live, or the call carried no information. */
export async function resetAbsenceStreaks(
  db: ControlPlaneDb,
  tenantId: TenantId,
  readingIds: readonly string[],
): Promise<void> {
  const ids = dedupe(readingIds);
  if (ids.length === 0) return;
  await db.batch(
    ids.map((readingId) => ({
      sql: `UPDATE vector_ledger SET absent_streak = 0, last_absent_at_ms = NULL
             WHERE tenant_id = ? AND reading_id = ?`,
      params: [tenantId, readingId],
    })),
  );
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
  /** Rows to delete: the streak reached `VECTOR_LEDGER_REQUIRED_ABSENCES`. */
  clear: string[];
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
    if (next >= VECTOR_LEDGER_REQUIRED_ABSENCES) verdict.clear.push(entry.readingId);
    else verdict.advanced.push({ readingId: entry.readingId, absentStreak: next });
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
