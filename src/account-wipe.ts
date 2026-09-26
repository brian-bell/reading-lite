/**
 * Deferred tenant wipe (issue 195b; on PostgreSQL since slice 1c.2, ADR 0005).
 *
 * ## Scope
 *
 * It deletes exactly two things for a tenant already marked
 * `users.status='deleting'` by 195a: the tenant's reading rows in PostgreSQL,
 * embeddings included, and everything under their R2 key root. The *job*
 * touches no control-plane row but the wipe record, no Durable Object, and no
 * email: hard-deleting the `users` row, clearing the child rows and the
 * guards, and freeing the address are control-plane teardown
 * (`src/control-plane/account-teardown.ts`, issue 195 S4). Fan-out invokes that
 * as its own stage, for a tenant whose wipe has completed and whose prefix is
 * confirmed empty, never inside a delivery, so a teardown failure retries on
 * the next tick rather than dragging a finished wipe back through the queue.
 * `DELETE /api/account` is the suppress path and never enqueues; the wipe is a
 * shared-queue job plus the existing 15-minute cron.
 *
 * ## Invariants
 *
 * **Rows and embeddings before objects.** The `rows` phase deletes every
 * reading the tenant owns; revisions, URLs, relationships, attempts and
 * embeddings go by cascade, so a reading leaves search in the same transaction
 * it leaves the list. It also deletes the tenant's
 * `relationship_refresh_jobs` checkpoints, which hang off no reading row and
 * so cascade from nothing — deleting a reading does not take its checkpoint
 * with it, and nothing else but teardown would ever remove one. They cannot
 * spend in the meantime (both refresh writes require an `active` users row),
 * so this is about the wipe removing the account's data itself rather than
 * about provider cost. Only then does the `objects` phase page R2. A reading whose objects outlive its
 * row is invisible; the reverse would be a listed reading whose content 404s.
 *
 * **The rows phase is one transaction, phase advance included.** The deletes
 * and the `wipe_progress` CAS commit together, so no tenant is ever recorded
 * as past `rows` without its rows actually being gone, and a CAS lost to a
 * sibling delivery takes the deletes back with it. The CAS goes last for that
 * reason.
 *
 * **Completion means the rows are gone, not that a DELETE said so.** The
 * objects phase ends by sweeping rows once more — a publisher that passed its
 * tenant check before the account was fenced may have committed in between,
 * and the sweep is idempotent — and the terminal write is then gated on a
 * count of the tenant's remaining `readings` and `inbox_items`. A non-zero
 * count throws
 * `AccountWipeRowsRemainingError` instead of recording a completion, because
 * a completion is what control-plane teardown hard-deletes the account on.
 * Teardown asks the same question again under its own lock.
 *
 * **Fail closed on the database.** The rows are read through the job's
 * PostgreSQL session; if the database throws, the delivery retries before any
 * R2 object is deleted, and no wipe reports success around rows it never saw.
 *
 * Embeddings are rows that delete with their reading, so the wipe has no
 * separate vector phase (ADR 0005).
 *
 * **The gate is a kill switch, not a fallback.** With `TENANT_DATA_PLANE` off
 * (or an empty key root) both fan-out and job skip with `no_tenant_prefix`.
 * They never fall back to the pre-tenant global layout: an empty key root must
 * not be read as "wipe the bucket".
 *
 * **One writer at a time, decided by a version rather than a clock.** Progress
 * lives in `wipe_progress` (`src/control-plane/wipe-progress.ts`), and every
 * write is a conditional `UPDATE … WHERE tenant_id = ? AND lease_seq = ?` that
 * bumps the counter. A delivery whose write changes no rows does not fight: it
 * reports `lease_held` and acks, because the winner is already doing the work.
 * The consumer runs at `max_concurrency = 1`, so this is a backstop against
 * at-least-once redelivery and cron overlap. `updated_at` still heartbeats, as
 * advice to cron.
 *
 * **The completion record outlives the wipe, on purpose.** It holds no reading
 * id, only counts, flags and timestamps, and it is what fan-out asks "was this
 * tenant wiped?" and what teardown's hard delete of the `users` row gates on.
 * Completion is two pairs: `completed_at`/`residue` are the current state and
 * a reopen clears them; `first_completed_at`/`first_residue` are written once.
 *
 * **Grace gates only the start.** `deleting_at` + 7 days gates starting a
 * *new* wipe. Resume (in-progress, leftover objects, expired lease) proceeds
 * during grace, and `force` recorded on the progress record survives a DLQ so a
 * forced wipe is redriven without waiting out the 7 days. A tenant marked
 * `deleting` with a NULL `deleting_at` can never elapse grace, so it is logged
 * as `account_wipe_missing_deleting_at` (finding F6) and left for an operator
 * to force.
 *
 * **A wipe that cannot finish reaches the DLQ.** A `continue` result self-sends
 * a fresh message, which starts a fresh queue retry budget; `continuations`
 * counts the self-sends of one pass and `ACCOUNT_WIPE_MAX_CONTINUATIONS`
 * bounds them (finding F7).
 *
 * ## Mechanics worth knowing
 *
 * R2 `list()`/`delete()` cap at 1000 objects, so the prefix is paged with a
 * cursor stored on the progress record. `persist` always writes and is used
 * wherever a later delivery must see the state: the lease claim, a
 * `continue`'s cursor and continuation count, the terminal record. The phase
 * transition does not go through it — it rides in the rows transaction
 * instead. `heartbeat` writes at most once per
 * `ACCOUNT_WIPE_HEARTBEAT_INTERVAL_MS` and only tells cron the job is alive.
 * `objects_deleted` is counted before a page's delete and reaches the database
 * on the next write, so a crash between them undercounts; it is a reporting
 * figure, not an audited one.
 */
import {
  tearDownAccount,
  type AccountTeardownEnv,
  type PrefixVerdict,
} from "./control-plane/account-teardown";
import { fromSql, type ControlPlaneDb } from "./control-plane/db";
import { parseTenantId, type TenantId } from "./control-plane/ids";
import { fromTimestamp } from "./control-plane/pg-time";
import {
  AccountWipeProgressConflictError,
  emptyWipeProgress,
  listUnfinishedWipes,
  readWipeProgress,
  reopenWipeProgress,
  WipeProgressWriter,
  type WipeProgress,
  type WipePhase,
} from "./control-plane/wipe-progress";
import {
  accountWipeEnvelopeV1,
  logAccountWipeEnvelopeRejected,
  parseAccountWipeEnvelope,
  type AccountWipeEnvelopeV1,
} from "./control-plane/wipe-envelope";
import { tenantDataPlaneEnabled, tenantKeyRoot } from "./modules/stores/tenant-root";
import { sqlSessionFor, withSqlSession, type Sql } from "./modules/db/sql";
import {
  countTenantReadings,
  deleteTenantReadings,
} from "./modules/stores/postgres/manifest-rows";
import { countTenantInboxItems, deleteTenantInboxItems } from "./modules/stores/postgres/inbox-store";
import { RateLimitedError } from "./modules/http-retry";

export { AccountWipeProgressConflictError } from "./control-plane/wipe-progress";

export const ACCOUNT_WIPE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How long cron leaves a tenant alone after the last sign of life from its job.
 *
 * One 15-minute cron interval. Advisory only: a duplicate enqueued too early
 * loses the lease CAS and skips with `lease_held` rather than clobbering
 * anything, so this only keeps cron from producing duplicates it would have to
 * turn away.
 */
export const ACCOUNT_WIPE_IN_FLIGHT_MS = 15 * 60_000;
/** Cloudflare Queues cap on `msg.retry({ delaySeconds })`. */
export const ACCOUNT_WIPE_RETRY_MAX_DELAY_SECONDS = 43_200;
/**
 * How many `continue` self-sends one wipe pass may make (review finding F7).
 *
 * A `continue` acks the current message and sends a fresh one, which starts a
 * fresh queue retry budget. Without a bound, a wipe that deletes a page and then
 * fails resets that budget on every self-send and never dead-letters.
 *
 * A delivery deletes up to `ACCOUNT_WIPE_DEFAULT_OBJECT_PAGES` ×
 * `R2_LIST_LIMIT` = 20,000 objects, so 200 continuations carry a tenant of
 * order 4,000,000 objects: far above any plausible one, and a stuck wipe still
 * reaches the bound and dead-letters where it can be seen. The counter is per
 * pass; reopening a leftover wipe resets it.
 */
export const ACCOUNT_WIPE_MAX_CONTINUATIONS = 200;
/**
 * Minimum gap between advisory heartbeat writes. The lease is a version, so
 * the beat only has to be frequent enough that cron does not think the job
 * died: one minute is a fifteen-fold margin under `ACCOUNT_WIPE_IN_FLIGHT_MS`.
 * Everything a later delivery must see goes through `persist()` instead.
 */
export const ACCOUNT_WIPE_HEARTBEAT_INTERVAL_MS = 60_000;
/** Operator alert: `status='deleting'` with no `deleting_at` (finding F6). */
export const ACCOUNT_WIPE_MISSING_DELETING_AT_EVENT = "account_wipe_missing_deleting_at";
export const ACCOUNT_TEARDOWN_COMPLETE_EVENT = "account_teardown_complete";
export const ACCOUNT_TEARDOWN_SKIPPED_EVENT = "account_teardown_skipped";
export const ACCOUNT_TEARDOWN_FAILED_EVENT = "account_teardown_failed";
export const R2_LIST_LIMIT = 1000;
export const ACCOUNT_WIPE_DEFAULT_OBJECT_PAGES = 20;

export const ACCOUNT_WIPE_QUEUE_NAMES = [
  "reading-lite-wipe",
  "reading-lite-staging-wipe",
] as const;
export const ACCOUNT_WIPE_DLQ_NAMES = [
  "reading-lite-wipe-dlq",
  "reading-lite-staging-wipe-dlq",
] as const;

export interface AccountWipeEnv extends AccountTeardownEnv {
  HYPERDRIVE: Hyperdrive;
  READINGS_BUCKET: R2Bucket;
  ACCOUNT_WIPE_JOBS?: Queue<AccountWipeEnvelopeV1>;
  TENANT_DATA_PLANE?: string;
}

export interface AccountWipeJobDeps {
  /** Consume-start clock; used for the grace gate. */
  nowMs: number;
  /**
   * Clock for lease heartbeats. Defaults to `Date.now`. Since the lease CAS is
   * a version rather than a timestamp, a frozen clock here costs at most a
   * redundant cron enqueue that then skips.
   */
  now?: () => number;
  maxObjectPages?: number;
}

function wipeJobNow(deps: AccountWipeJobDeps): number {
  return deps.now ? deps.now() : Date.now();
}

/**
 * This pass has self-sent `continue` as often as it is allowed to (F7).
 *
 * Thrown instead of sending another message, so the delivery retries on the
 * ordinary schedule and dead-letters once `max_retries` is spent.
 */
export class AccountWipeContinuationBudgetError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly continuations: number,
  ) {
    super(
      `account_wipe continuation_budget_exhausted for ${tenantId}: ` +
        `${continuations}/${ACCOUNT_WIPE_MAX_CONTINUATIONS} self-sends in one pass`,
    );
    this.name = "AccountWipeContinuationBudgetError";
  }
}

/**
 * The sweep committed and reading rows or inbox items are still there.
 *
 * Thrown instead of recording a completion, because a completion is what
 * teardown hard-deletes the `users` row on. Ordinary retry: the next delivery
 * sweeps again, and a wipe that can never get to zero dead-letters where an
 * operator can see it.
 */
export class AccountWipeRowsRemainingError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly remaining: number,
  ) {
    super(
      `account_wipe rows_remaining for ${tenantId}: ${remaining} reading or inbox row(s) survived the sweep`,
    );
    this.name = "AccountWipeRowsRemainingError";
  }
}

export type AccountWipeSkipReason =
  | "grace_period"
  | "not_deleting"
  | "not_found"
  | "no_tenant_prefix"
  | "lease_held";

export type AccountWipeResult =
  | { kind: "skipped"; reason: AccountWipeSkipReason }
  | { kind: "continue"; rows_deleted: number; objects_deleted: number; r2_cursor?: string }
  | { kind: "complete"; rows_deleted: number; objects_deleted: number };

export function isAccountWipeQueue(name: string): boolean {
  return (ACCOUNT_WIPE_QUEUE_NAMES as readonly string[]).includes(name);
}

export function isAccountWipeDlq(name: string): boolean {
  return (ACCOUNT_WIPE_DLQ_NAMES as readonly string[]).includes(name);
}

export function wipeGraceElapsed(deletingAtMs: number | null | undefined, nowMs: number): boolean {
  if (deletingAtMs == null) return false;
  return nowMs - deletingAtMs >= ACCOUNT_WIPE_GRACE_MS;
}

/**
 * Incomplete or leftover progress is a resume, not a new wipe.
 *
 * `hasLeftover` is rows **or** objects, the same question the cron fan-out
 * asks. It was objects alone once, which left a finished wipe with rows
 * standing reporting complete; do not narrow it back.
 */
export function wipeNeedsResume(
  progress: { completedAtMs: number | null } | null,
  hasLeftover: boolean,
): boolean {
  if (!progress) return false;
  return progress.completedAtMs === null || hasLeftover;
}

/** True while cron should not enqueue a duplicate delivery. */
export function wipeLeaseHeld(updatedAtMs: number, nowMs: number): boolean {
  return nowMs - updatedAtMs < ACCOUNT_WIPE_IN_FLIGHT_MS;
}

export async function listDeletingUsers(
  db: ControlPlaneDb,
): Promise<Array<{ id: string; deleting_at_ms: number | null }>> {
  const rows = await db.all<{ id: string; deleting_at: string | null }>(
    `SELECT id, deleting_at FROM users WHERE status = 'deleting' ORDER BY id`,
  );
  return rows.map((row) => ({ id: row.id, deleting_at_ms: fromTimestamp(row.deleting_at) }));
}

/**
 * Finding F6. `deleting_at` is what grace is measured from, so a NULL one can
 * never elapse: the tenant sits in `deleting` and is never wiped, silently.
 * Warn rather than throw: blocking on it would strand every other tenant on the
 * tick, and an operator can force the wipe once they see it.
 */
function warnMissingDeletingAt(tenantId: string, deletingAtMs: number | null | undefined): void {
  if (deletingAtMs != null) return;
  console.warn(
    JSON.stringify({
      event: ACCOUNT_WIPE_MISSING_DELETING_AT_EVENT,
      tenant_id: tenantId,
      note:
        "users.status='deleting' with no deleting_at: the grace window can never elapse, " +
        "so this wipe will not start on its own. Force it or repair the row.",
    }),
  );
}

/**
 * Control-plane teardown for a tenant whose data-plane wipe is finished
 * (issue 195 S4). Called from fan-out rather than from the wipe delivery, so
 * that it is an independently resumable stage: a failure logs and the next
 * tick tries again.
 *
 * Never throws. Fan-out's job is to keep every *other* tenant moving.
 */
async function tearDownFinishedAccount(
  db: ControlPlaneDb,
  env: AccountWipeEnv,
  tenantId: TenantId,
  nowMs: number,
): Promise<void> {
  try {
    const result = await tearDownAccount(db, env, {
      tenantId,
      nowMs,
      // Asked again inside teardown, immediately before its final transaction,
      // not reused from fan-out's check, which is older by then.
      prefixVerdict: () => tenantPrefixVerdict(env.READINGS_BUCKET, tenantId, env),
    });
    if (result.kind === "torn_down") {
      console.log(
        JSON.stringify({
          event: ACCOUNT_TEARDOWN_COMPLETE_EVENT,
          tenant_id: tenantId,
          rows_deleted: result.rowsDeleted,
        }),
      );
      return;
    }
    // Fan-out only calls this for a tenant it has just seen as completed with an
    // empty prefix, so every other verdict means the row moved underneath us or
    // is inconsistent. Silence here would repeat forever on every tick.
    console.warn(
      JSON.stringify({
        event: ACCOUNT_TEARDOWN_SKIPPED_EVENT,
        tenant_id: tenantId,
        reason: result.kind,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: ACCOUNT_TEARDOWN_FAILED_EVENT,
        tenant_id: tenantId,
        message: error instanceof Error ? error.message : String(error),
        note: "control-plane teardown did not finish; the audit row is written and the next tick retries",
      }),
    );
  }
}

export async function fanOutDueAccountWipes(
  env: AccountWipeEnv,
  deps: { nowMs: number },
): Promise<{ enqueued: number }> {
  const queue = env.ACCOUNT_WIPE_JOBS;
  if (!queue) {
    console.warn(JSON.stringify({ event: "account_wipe_fanout_skipped", reason: "queue_unbound" }));
    return { enqueued: 0 };
  }
  // Same gate as processAccountWipeJob: with TENANT_DATA_PLANE off there is no
  // tenant prefix to wipe. Do not claim a lease or enqueue: the job would skip
  // at no_tenant_prefix, and cron would retry forever.
  if (!tenantDataPlaneEnabled(env)) {
    console.warn(JSON.stringify({ event: "account_wipe_fanout_skipped", reason: "no_tenant_prefix" }));
    return { enqueued: 0 };
  }
  return withSqlSession(env, (sql) => fanOutWith(fromSql(sql), env, queue, deps));
}

async function fanOutWith(
  db: ControlPlaneDb,
  env: AccountWipeEnv,
  queue: Queue<AccountWipeEnvelopeV1>,
  deps: { nowMs: number },
): Promise<{ enqueued: number }> {
  const rows = await listDeletingUsers(db);
  // One query for every live wipe, rather than one read per deleting tenant.
  const unfinished = await listUnfinishedWipes(db);
  let enqueued = 0;
  for (const row of rows) {
    try {
      const tenantId = parseTenantId(row.id);
      if (!tenantId) continue;
      warnMissingDeletingAt(row.id, row.deleting_at_ms);
      // A tenant absent from the unfinished set is either brand new or finished;
      // only the finished case needs the extra read, and only to decide whether
      // leftover objects reopen it.
      const stored = unfinished.get(tenantId) ?? (await readWipeProgress(db, tenantId));
      if (stored === null) {
        // Never wiped. Grace gates the start; the completion record, not the
        // prefix, tells "never wiped" from "already wiped".
        if (!wipeGraceElapsed(row.deleting_at_ms, deps.nowMs)) continue;
      } else if (stored.completedAtMs !== null) {
        // Finished. Reopen if anything the wipe owns turned up after the fact —
        // objects under the prefix, or reading or inbox rows a writer committed
        // past the fence. Rows have to count on their own: teardown refuses while any
        // stand (`rows_remain`), and if only objects reopened the wipe, a
        // tenant with a clean prefix and one stray row would be handed to
        // teardown, refused, and handed back on every tick forever, with
        // nothing in the system able to delete that row.
        //
        // Otherwise hand the tenant to control-plane teardown (S4). Once that
        // succeeds this tenant leaves `listDeletingUsers` and is never
        // enumerated again (finding F10). Teardown is deliberately not run
        // while leftovers are reopening the wipe.
        const leftover =
          (await tenantPrefixHasObjects(env.READINGS_BUCKET, tenantId, env)) ||
          (await tenantHasWipeRows(db, tenantId));
        if (!leftover) {
          await tearDownFinishedAccount(db, env, tenantId, deps.nowMs);
          continue;
        }
      } else if (wipeLeaseHeld(stored.updatedAtMs, deps.nowMs)) {
        continue;
      }
      // Claim before sending, so the next tick sees a live lease and a reopened
      // leftover is not immediately re-enqueued. Resume preserves force from the
      // record so a force wipe that DLQ'd during grace is redriven with
      // force:true; new starts persist force:false.
      const force = stored?.force === true;
      const next =
        stored === null
          ? emptyWipeProgress(deps.nowMs, force)
          : stored.completedAtMs !== null
            ? reopenWipeProgress(stored, force)
            : { ...stored, force };
      next.updatedAtMs = deps.nowMs;
      // CAS on what we just read: a delivery that claimed this tenant between
      // the read and here wins, and this user is skipped for the tick.
      await new WipeProgressWriter(db, tenantId, stored).write(next);
      await queue.send(accountWipeEnvelopeV1({ tenantId, force }));
      enqueued += 1;
    } catch (error) {
      if (error instanceof AccountWipeProgressConflictError) continue;
      console.error(
        JSON.stringify({
          event: "account_wipe_fanout_user_failed",
          user_id: row.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return { enqueued };
}

export async function processAccountWipeJob(
  envelope: AccountWipeEnvelopeV1,
  env: AccountWipeEnv,
  deps: AccountWipeJobDeps,
): Promise<AccountWipeResult> {
  // One session for the delivery: progress writes, the rows phase and the
  // user read share it, and it survives the R2 paging between them.
  const sql = sqlSessionFor(env);
  try {
    return await runAccountWipeJob(sql, envelope, env, deps);
  } catch (error) {
    if (error instanceof AccountWipeProgressConflictError) {
      // A sibling delivery owns this wipe. Ack rather than retry: the winner is
      // already making the progress this message would duplicate.
      console.warn(
        JSON.stringify({
          event: "account_wipe_lease_held",
          tenant_id: envelope.tenantId,
          note: "another delivery owns this wipe; conditional update changed no rows",
        }),
      );
      return { kind: "skipped", reason: "lease_held" };
    }
    throw error;
  } finally {
    await sql.end();
  }
}

async function runAccountWipeJob(
  sql: Sql,
  envelope: AccountWipeEnvelopeV1,
  env: AccountWipeEnv,
  deps: AccountWipeJobDeps,
): Promise<AccountWipeResult> {
  const tenantId = parseTenantId(envelope.tenantId);
  if (!tenantId) return { kind: "skipped", reason: "not_found" };

  const db = fromSql(sql);
  const user = await db.first<{ status: string; deleting_at: string | null }>(
    "SELECT status, deleting_at FROM users WHERE id = ?",
    tenantId,
  );
  if (!user) return { kind: "skipped", reason: "not_found" };
  if (user.status !== "deleting") return { kind: "skipped", reason: "not_deleting" };
  const deletingAtMs = fromTimestamp(user.deleting_at);
  warnMissingDeletingAt(tenantId, deletingAtMs);

  if (!tenantDataPlaneEnabled(env)) {
    return { kind: "skipped", reason: "no_tenant_prefix" };
  }
  const keyRoot = tenantKeyRoot({ tenantId }, true);
  if (keyRoot === "") return { kind: "skipped", reason: "no_tenant_prefix" };

  const maxObjectPages = deps.maxObjectPages ?? ACCOUNT_WIPE_DEFAULT_OBJECT_PAGES;

  const stored = await readWipeProgress(db, tenantId);
  // Same question fan-out asks, and for the same reason: a finished wipe with
  // rows or objects left is a wipe to reopen, not one to report complete.
  const leftover =
    stored !== null && stored.completedAtMs !== null
      ? (await prefixHasObjects(env.READINGS_BUCKET, keyRoot)) ||
        (await tenantHasWipeRows(db, tenantId))
      : false;
  const resuming = wipeNeedsResume(stored, leftover);
  const force = envelope.force || stored?.force === true;
  // Grace only gates starting a new wipe. Resume (in-progress, leftover, expired
  // lease) proceeds even during grace; force:true still starts during grace.
  if (!force && !wipeGraceElapsed(deletingAtMs, deps.nowMs) && !resuming) {
    return { kind: "skipped", reason: "grace_period" };
  }

  const now = () => wipeJobNow(deps);
  let progress: WipeProgress;
  if (stored === null) {
    progress = emptyWipeProgress(now(), force);
  } else if (stored.completedAtMs !== null) {
    if (!leftover) {
      // Already wiped and neither rows nor objects came back. Report the
      // stored outcome and
      // leave the completion record untouched: it is evidence now, not a
      // resume point, and rewriting it would move `completed_at`.
      return { kind: "complete", rows_deleted: 0, objects_deleted: stored.objectsDeleted };
    }
    progress = reopenWipeProgress(stored, force);
  } else {
    progress = { ...stored, force };
  }

  const writer = new WipeProgressWriter(db, tenantId, stored);
  let lastPersistMs = Number.NEGATIVE_INFINITY;
  const persist = async () => {
    progress.updatedAtMs = now();
    await writer.write(progress);
    lastPersistMs = progress.updatedAtMs;
  };
  const heartbeat = async () => {
    if (now() - lastPersistMs < ACCOUNT_WIPE_HEARTBEAT_INTERVAL_MS) return;
    await persist();
  };
  let rowsDeleted = 0;
  /**
   * The tenant's rows, in one transaction.
   *
   * Every reading the tenant owns — revisions, URLs, relationships, attempts
   * and embeddings by cascade — its inbox items, and its
   * `relationship_refresh_jobs` checkpoints; the last two hang off no reading
   * row and so cascade from nothing.
   * A leftover checkpoint cannot spend: `markRefreshDispatched` and
   * `saveRefreshResult` both write only against an `active` users row, and
   * the judge noops once the reading is gone. It is deleted here because
   * removing the account's data is the wipe's job — teardown deletes these
   * too, but a completion record that left them standing would be claiming
   * more than the wipe had actually done.
   *
   * `advance` puts the wipe's phase CAS in the same transaction, so a tenant
   * can never be recorded as past the `rows` phase without its rows actually
   * being gone. The CAS goes last: if a sibling delivery owns the wipe it
   * throws, and the deletes roll back with it rather than committing under the
   * owner. Idempotent, so the objects phase can sweep with it again.
   */
  const deleteRows = async (advance?: WipePhase) => {
    const next = advance === undefined ? null : { ...progress, phase: advance, updatedAtMs: now() };
    rowsDeleted += await sql.transaction(async (tx) => {
      const deleted = (await deleteTenantReadings(tx, tenantId)) + (await deleteTenantInboxItems(tx, tenantId));
      await tx.execute("DELETE FROM relationship_refresh_jobs WHERE tenant_id = $1", [tenantId]);
      if (next) await writer.write(next, fromSql(tx));
      return deleted;
    });
    if (next) {
      progress = next;
      lastPersistMs = next.updatedAtMs;
    }
  };
  const continueResult = async (): Promise<AccountWipeResult> => {
    // Bound the self-send before making it (F7). Persisted, so the count is the
    // pass's and not one delivery's.
    const next = progress.continuations + 1;
    if (next > ACCOUNT_WIPE_MAX_CONTINUATIONS) {
      throw new AccountWipeContinuationBudgetError(tenantId, progress.continuations);
    }
    progress.continuations = next;
    await persist();
    return {
      kind: "continue",
      rows_deleted: rowsDeleted,
      objects_deleted: progress.objectsDeleted,
      ...(progress.r2Cursor === undefined ? {} : { r2_cursor: progress.r2Cursor }),
    };
  };
  // Claim the lease before anything is deleted, so a concurrent cron tick sees
  // it and skips instead of launching a duplicate. Always written: this is the
  // claim itself, not a beat.
  await persist();

  if (progress.phase === "rows") {
    // The phase advance rides in the delete's transaction: a resuming delivery
    // that reads `objects` is reading a fact, not an intention.
    await deleteRows("objects");
  }

  if (progress.phase === "objects") {
    let pages = 0;
    let cursor = progress.r2Cursor;
    objects: for (;;) {
      const list = await env.READINGS_BUCKET.list({
        prefix: keyRoot,
        limit: R2_LIST_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      if (list.objects.length === 0) {
        // A stored cursor can land on an empty page while objects remain earlier
        // in the prefix. Confirm emptiness without the cursor before finishing.
        if (await prefixHasObjects(env.READINGS_BUCKET, keyRoot)) {
          cursor = undefined;
          progress.r2Cursor = undefined;
          await heartbeat();
          if (pages >= maxObjectPages) return continueResult();
          continue;
        }
        progress.r2Cursor = undefined;
        break objects;
      }
      progress.objectsDeleted += list.objects.length;
      pages += 1;
      cursor = list.truncated ? list.cursor : undefined;
      progress.r2Cursor = cursor;
      await heartbeat();
      await env.READINGS_BUCKET.delete(list.objects.map((obj) => obj.key));
      if (!cursor) {
        const again = await env.READINGS_BUCKET.list({ prefix: keyRoot, limit: 1 });
        if (again.objects.length === 0) {
          progress.r2Cursor = undefined;
          break objects;
        }
        cursor = undefined;
        progress.r2Cursor = undefined;
      }
      if (pages >= maxObjectPages) return continueResult();
    }
    // A publisher that passed its tenant check before the fence may have
    // committed after the rows phase. Its content is gone with the prefix;
    // sweep its rows too, before claiming completion.
    await deleteRows();
  }

  // Completion has to mean the tenant's rows are gone, not that a DELETE
  // reported a count. The sweep above committed; this asks the table. A row
  // that appears at all is a writer that got past the fence later than any
  // sweep can cover, so the delivery fails and retries rather than recording a
  // completion teardown would then hard-delete the account on.
  //
  // What holds the answer true is the status fence, not this transaction.
  // `claimUrl` is the only live inserter of a `readings` row and inbox stage
  // the only one of an `inbox_items` row, and each takes `users` FOR SHARE
  // and requires `active` in the same transaction as its insert:
  // `beginAccountDeletion`'s status UPDATE therefore waited on every insert
  // already in flight, and every later one reads `deleting` and gives up. Do not read the shared transaction as doing that job — under READ
  // COMMITTED the count takes no lock on `readings` and would not fence an
  // inserter on its own.
  //
  // What the shared transaction does buy is a sibling delivery: `complete` is
  // conditional on the lease this count was taken under, so a sibling that
  // took the wipe over makes the CAS throw and rolls the verdict back with it,
  // rather than stamping a completion over the owner's work.
  const completedAtMs = now();
  const done = await sql.transaction(async (tx) => {
    const remaining = (await countTenantReadings(tx, tenantId)) + (await countTenantInboxItems(tx, tenantId));
    if (remaining > 0) throw new AccountWipeRowsRemainingError(tenantId, remaining);
    return writer.complete(progress, completedAtMs, false, fromSql(tx));
  });
  return { kind: "complete", rows_deleted: rowsDeleted, objects_deleted: done.objectsDeleted };
}

export async function consumeAccountWipeMessage(
  msg: {
    body: unknown;
    ack: () => void;
    retry: (opts?: { delaySeconds?: number }) => void;
    attempts?: number;
  },
  env: AccountWipeEnv,
  deps: AccountWipeJobDeps,
): Promise<void> {
  const parsed = parseAccountWipeEnvelope(msg.body);
  if (!parsed.ok) {
    logAccountWipeEnvelopeRejected(parsed.reason);
    msg.ack();
    return;
  }
  try {
    const result = await processAccountWipeJob(parsed.envelope, env, deps);
    if (result.kind === "continue") {
      const queue = env.ACCOUNT_WIPE_JOBS;
      if (!queue) throw new Error("ACCOUNT_WIPE_JOBS unbound");
      await queue.send(parsed.envelope);
    }
    msg.ack();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "account_wipe_failed",
        tenant_id: parsed.envelope.tenantId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    const retryAfterMs = error instanceof RateLimitedError ? error.retryAfterMs : null;
    msg.retry({ delaySeconds: wipeRetryDelaySeconds(retryAfterMs, msg.attempts ?? 1) });
  }
}

export function wipeRetryDelaySeconds(retryAfterMs: number | null, attempts: number): number {
  const defaultMs = 30_000;
  const maxMs = 300_000;
  const ms =
    retryAfterMs !== null
      ? retryAfterMs
      : Math.min(maxMs, defaultMs * 2 ** Math.max(0, attempts - 1));
  return Math.max(1, Math.min(ACCOUNT_WIPE_RETRY_MAX_DELAY_SECONDS, Math.ceil(ms / 1000)));
}

export async function handleAccountWipeDeadLetter(msg: {
  body: unknown;
  ack: () => void;
}): Promise<void> {
  try {
    const parsed = parseAccountWipeEnvelope(msg.body);
    console.error(
      JSON.stringify({
        event: "account_wipe_dead_lettered",
        reason: parsed.ok ? "retries_exhausted" : parsed.reason,
        tenant_id: parsed.ok ? parsed.envelope.tenantId : undefined,
      }),
    );
  } catch (error) {
    console.error(error);
  } finally {
    msg.ack();
  }
}

/**
 * Reading rows or inbox items the tenant still owns, as a yes/no: the rows
 * teardown refuses over (`rows_remain`), so the rows that must reopen a
 * finished wipe.
 *
 * Fail-closed: an answer we could not read counts as "yes". Both callers use
 * it to decide whether a finished wipe comes back for another pass, and
 * another pass is idempotent, where wrongly concluding "nothing left" hands
 * the tenant to a teardown that will refuse it forever.
 */
async function tenantHasWipeRows(db: ControlPlaneDb, tenantId: TenantId): Promise<boolean> {
  const row = await db.first<{ remaining: number }>(
    `SELECT (SELECT count(*) FROM readings WHERE tenant_id = ?)
          + (SELECT count(*) FROM inbox_items WHERE tenant_id = ?) AS remaining`,
    tenantId,
    tenantId,
  );
  return !row || row.remaining > 0;
}

async function prefixHasObjects(bucket: R2Bucket, keyRoot: string): Promise<boolean> {
  const leftover = await bucket.list({ prefix: keyRoot, limit: 1 });
  return leftover.objects.length > 0;
}

async function tenantPrefixHasObjects(
  bucket: R2Bucket,
  tenantId: TenantId,
  env: { TENANT_DATA_PLANE?: string },
): Promise<boolean> {
  return (await tenantPrefixVerdict(bucket, tenantId, env)) === "not_empty";
}

/**
 * The same question, but keeping "we could not look" apart from "it is empty".
 *
 * Fan-out only decides whether to re-enqueue, so collapsing the two into
 * `false` costs it nothing. Teardown hard-deletes a `users` row on the answer,
 * and after that the tenant's leftover objects can never be found through
 * `listDeletingUsers` again, so it needs the distinction.
 */
async function tenantPrefixVerdict(
  bucket: R2Bucket,
  tenantId: TenantId,
  env: { TENANT_DATA_PLANE?: string },
): Promise<PrefixVerdict> {
  if (!tenantDataPlaneEnabled(env)) return "unknown";
  const keyRoot = tenantKeyRoot({ tenantId }, true);
  if (keyRoot === "") return "unknown";
  return (await prefixHasObjects(bucket, keyRoot)) ? "not_empty" : "empty";
}
