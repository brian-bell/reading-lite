/**
 * Deferred tenant R2 + Vectorize wipe (issue 195b / s1k.10.1).
 *
 * The invariants this module holds, and the one race it still does not close.
 *
 * ## Scope
 *
 * It deletes exactly two things for a tenant already marked
 * `users.status='deleting'` by 195a: their Vectorize vectors and everything
 * under their R2 key root. It does not hard-delete the users row, tear down
 * Durable Objects, cascade D1, or decide email reuse — that is control-plane
 * teardown, a later slice. `DELETE /api/account` is the suppress path and never
 * enqueues; the wipe is a shared-queue job plus the existing 15-minute cron.
 *
 * ## Invariants
 *
 * **Vectors before objects.** Every vector delete for a phase is submitted
 * before that phase's first R2 delete. Reading ids come only from R2 (the list
 * index and the key layout), so emptying the prefix first would strand the
 * embeddings permanently.
 *
 * **Fail closed on an unbound index.** With no `READINGS_INDEX` the job throws
 * (`index_unbound`) before either phase runs, so no R2 object is deleted while
 * nothing can delete the matching vectors — including on a delivery that resumes
 * straight into `objects` and would otherwise never reach a vector call. The
 * vectors phase repeats the check *before* its "no ids to delete" short-circuit
 * — an empty id set means "R2 yielded no ids", which is also what an
 * already-emptied prefix looks like — and the terminal probe repeats it again.
 * Cron fan-out has no such check, so with the binding gone it still claims a
 * lease and enqueues; every delivery then throws. That is loud rather than
 * destructive, which is the side to err on.
 *
 * **A wipe never reports success without addressing the index.** Before the
 * terminal transition it probes the tenant namespace and refuses to finish
 * while anything still answers, retrying on a minutes-scale delay because
 * `deleteByIds` propagates asynchronously. The retries are bounded
 * (`ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS`); past the bound it raises a
 * high-severity `account_wipe_namespace_residue` alert carrying the tenant id
 * and nothing else, records `residue` on the completion record, and completes
 * rather than looping a doomed job through the DLQ every 15 minutes.
 *
 * **The gate is a kill switch, not a fallback.** With `TENANT_DATA_PLANE` off
 * (or an empty key root) both fan-out and job skip with `no_tenant_prefix`.
 * They never fall back to the pre-tenant global layout — an empty key root must
 * not be read as "wipe the bucket".
 *
 * **One writer at a time, decided by a version rather than a clock.** Progress
 * lives in D1 (`src/control-plane/wipe-progress.ts`), and every write is a
 * conditional `UPDATE … WHERE tenant_id = ? AND lease_seq = ?` that bumps the
 * counter. A delivery whose write changes no rows does not fight: it reports
 * `lease_held` and acks, because the winner is already doing the work. The
 * consumer runs at `max_concurrency = 1`, so this is a backstop against
 * at-least-once redelivery and cron overlap rather than the primary
 * serialization. `updated_at_ms` is still written and still heartbeats, but it
 * is now advice — it only stops cron enqueuing a duplicate it would turn away.
 * That is what retired two cases the R2 etag CAS had to special-case: a job
 * running on a frozen consume-start clock, and a delayed retry (up to 12h)
 * whose lease used to be pushed into the future so cron would not race it.
 *
 * **The completion record outlives the wipe, on purpose.** The R2 object it
 * replaces was deleted at the terminal transition (finding F4) because its key
 * named a deleted tenant and its body listed their reading ids. The D1 row is
 * keyed by a tenant whose `users` row is still present until S4's teardown, and
 * the terminal write clears both cursors, so the record that survives holds no
 * reading id — only counts, flags, `completed_at_ms`, and `residue`. Keeping it
 * is what lets fan-out ask "was this tenant wiped?" instead of inferring it from
 * an empty R2 prefix, and it is the gate S4's hard delete of the `users` row
 * reads. The foreign key deliberately does not cascade for that reason.
 *
 * Completion is two pairs. `completed_at_ms`/`residue` are the current state and
 * a reopen clears them, so a teardown gate does not fire while a reopened pass
 * is still running. `first_completed_at_ms`/`first_residue` are written once and
 * never moved, so a reopen that fails or dead-letters cannot leave the row
 * claiming this tenant was never wiped.
 *
 * **Grace gates only the start.** `deleting_at_ms` + 7 days gates starting a
 * *new* wipe. Resume (in-progress, leftover objects, expired lease) proceeds
 * during grace, and `force` recorded on the progress record survives a DLQ so a
 * forced wipe is redriven without waiting out the 7 days. A tenant marked
 * `deleting` with a NULL `deleting_at_ms` can never elapse grace, so rather than
 * stalling in silence it is logged as `account_wipe_missing_deleting_at`
 * (finding F6) and left for an operator to force.
 *
 * **A wipe that cannot finish reaches the DLQ.** A `continue` result self-sends
 * a fresh message, which starts a fresh queue retry budget; a wipe that deletes
 * one page and then fails would otherwise reset that budget forever and never
 * dead-letter (finding F7). `continuations` counts the self-sends of one pass
 * and `ACCOUNT_WIPE_MAX_CONTINUATIONS` bounds them, generously enough that no
 * real tenant reaches it (see the constant) and tightly enough that a stuck one
 * does.
 *
 * **Resumability is stateless beyond two cursors.** Reading ids are re-derived
 * from R2 on every pass rather than persisted; the record carries only phase,
 * the two cursors, and lease/probe/continuation bookkeeping. Both cursors are
 * values, not indices — `vector_cursor` is the last reading id submitted, so an
 * id disappearing between deliveries, or appearing above the cursor, cannot
 * shift a window past an id that was never sent. (An id that first becomes
 * derivable from R2 *below* the cursor is still missed; see the race below.)
 *
 * ## The race this does not close
 *
 * A vector whose reading id is no longer derivable from R2 is unaddressable:
 * `deleteByIds` needs an id and there is nothing left to compute one from.
 *
 * `processReading` narrows the live half of this at the publisher: a consumer
 * that publishes against a tenant confirmed `deleting` deletes its own vector
 * directly (`ReadingVisibility.removeForDeletedTenant`) instead of waiting for a
 * wipe that has already collected its ids. **Narrows, not closes.** That recheck
 * fails open on a D1 lookup error, and an isolate that dies between the upsert
 * and the recheck never runs the compensation at all; in either case a wipe
 * whose vectors phase is already past will empty the reading's R2 objects and
 * leave the vector with no id source. The terminal probe can sample for such a
 * vector but cannot delete it, and so can a stranding that predates the wipe
 * entirely (review finding F3).
 *
 * A third, narrower instance of the same shape: a reading that first becomes
 * derivable from R2 *between* two vectors-phase deliveries, and whose (random)
 * id sorts below `vector_cursor`, is never submitted by this wipe — the resume
 * window only looks forward. It needs a tenant with more than one delivery's
 * worth of vectors and a publish landing inside that window.
 *
 * And a fourth: the fence lives in `processReading`, so it covers the publisher
 * and nothing else. The offline vector writers — `corpus-backfill-vectors`,
 * `corpus-migrate-founder`, and `batch/write-phase` — check no `users.status`
 * and can upsert into a tenant whose wipe is already past its vectors phase.
 * Nothing catches that today; the terminal probe still *sees* an upsert that
 * lands before it (refusing to finish, then alerting and recording `residue`) —
 * it just cannot delete it. It takes an operator running one of those
 * `--execute` against an account being deleted.
 *
 * All four close the same way: a durable per-tenant vector-id ledger, which
 * takes R2 out of the id-source role entirely — issue #261, out of scope here.
 *
 * What is no longer part of that list is the *evidence*. While progress lived in
 * R2 and was deleted on completion, a tenant with an emptied prefix and stranded
 * vectors was indistinguishable from one that had never been wiped, so fan-out
 * had to skip it forever to avoid restarting a wipe every 15 minutes. The D1
 * record persists instead: the tenant is known-wiped, `residue` says whether the
 * namespace was ever confirmed clean, and the residue scan and S4's teardown gate
 * can both read it. Re-sweeping such a tenant still needs #261's ledger, because
 * there is still no id to delete by — but the finding is now written down rather
 * than inferred from an absence.
 *
 * ## Mechanics worth knowing
 *
 * R2 `list()`/`delete()` cap at 1000 objects, so the prefix is paged with a
 * cursor stored on the progress record. Vectorize `deleteByIds` is async
 * (a mutationId, no immediate confirm) and is fired in ≤1000-id batches; we
 * record what it returns and never poll.
 *
 * Writes come in two flavours. `persist` always writes and is used wherever a
 * later delivery must see the state: the lease claim, a phase transition, a
 * `continue`'s cursor and continuation count, probe bookkeeping, the terminal
 * record. `heartbeat` writes at most once per
 * `ACCOUNT_WIPE_HEARTBEAT_INTERVAL_MS` and exists only to tell cron the job is
 * alive — a full-row D1 UPDATE per R2 page cost hundreds of writes a delivery
 * on a large tenant, and since the lease is a version rather than a clock,
 * losing a beat costs a re-list or an idempotent re-submit, never correctness.
 */
import { fromD1, type ControlPlaneDb } from "./control-plane/db";
import { parseTenantId, type TenantId } from "./control-plane/ids";
import {
  AccountWipeProgressConflictError,
  emptyWipeProgress,
  listUnfinishedWipes,
  readWipeProgress,
  reopenWipeProgress,
  WipeProgressWriter,
  type WipeProgress,
} from "./control-plane/wipe-progress";
import {
  accountWipeEnvelopeV1,
  logAccountWipeEnvelopeRejected,
  parseAccountWipeEnvelope,
  type AccountWipeEnvelopeV1,
} from "./control-plane/wipe-envelope";
import {
  BY_ID_PREFIX,
  READINGS_PREFIX,
  r2KeyLayout,
} from "./modules/stores/layout";
import {
  tenantDataPlaneEnabled,
  tenantKeyRoot,
} from "./modules/stores/reading-store";
import {
  similarityStoreFor,
  VECTORIZE_DELETE_MAX_IDS,
} from "./modules/stores/similarity-store";
import { RateLimitedError } from "./modules/http-retry";
import { ListIndexSchema } from "./schemas/api";
import { parseReadingId } from "./services";

export { AccountWipeProgressConflictError } from "./control-plane/wipe-progress";

export const ACCOUNT_WIPE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How long cron leaves a tenant alone after the last sign of life from its job.
 *
 * One 15-minute cron interval. Advisory only since progress moved to D1: a
 * duplicate enqueued too early loses the lease CAS and skips with `lease_held`
 * rather than clobbering anything, so this only keeps cron from producing
 * duplicates it would have to turn away.
 */
export const ACCOUNT_WIPE_IN_FLIGHT_MS = 15 * 60_000;
/** Cloudflare Queues cap on `msg.retry({ delaySeconds })`. */
export const ACCOUNT_WIPE_RETRY_MAX_DELAY_SECONDS = 43_200;
/**
 * Retry delay for a terminal probe that still sees vectors. Minutes, not the
 * 30s exponential every other failure uses: `deleteByIds` propagates
 * asynchronously, so a hit immediately after submitting is the expected case
 * rather than a fault. On the fast schedule a real wipe would burn
 * `max_retries = 3` in about three and a half minutes and dead-letter before
 * propagation had any chance to land.
 */
export const ACCOUNT_WIPE_PROBE_RETRY_DELAY_SECONDS = 300;
/**
 * How many terminal probes may fail before the wipe stops waiting.
 *
 * Deliberately equal to the queue's `max_retries = 3` (wrangler.toml, both wipe
 * consumers) so the bound is consumed inside one message's own retry budget:
 * at 5 minutes a go that allows ~10 minutes for propagation and the wipe
 * resolves without ever dead-lettering. A larger bound would not buy more
 * patience — it would just push attempts past `max_retries` into the DLQ and
 * make every healthy wipe raise a dead-letter alarm before cron picked it up
 * again 15 minutes later.
 *
 * Past the bound the likely cause is not lag but a vector whose reading id is
 * no longer derivable from R2, which no amount of retrying can fix (see the
 * header's note on unaddressable vectors), so the wipe alerts an operator,
 * records `residue` on the completion record, and completes rather than failing
 * in a loop.
 */
export const ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS = 3;
/**
 * How many `continue` self-sends one wipe pass may make (review finding F7).
 *
 * A `continue` acks the current message and sends a fresh one, which starts a
 * fresh queue retry budget. Without a bound, a wipe that deletes a page and then
 * fails resets that budget on every self-send and never dead-letters — it just
 * cycles, forever, invisibly.
 *
 * The bound is sized off a delivery's own limits rather than picked round: a
 * delivery moves up to `ACCOUNT_WIPE_DEFAULT_OBJECT_PAGES` × `R2_LIST_LIMIT`
 * objects (20,000) or `ACCOUNT_WIPE_DEFAULT_VECTOR_BATCHES` ×
 * `VECTORIZE_DELETE_MAX_IDS` ids (20,000), so 200 continuations covers roughly
 * four million of either. No real tenant reaches that; a stuck one reaches it in
 * a bounded number of cycles and then dead-letters where it can be seen. The
 * counter is per pass — reopening a leftover wipe resets it.
 */
export const ACCOUNT_WIPE_MAX_CONTINUATIONS = 200;
/**
 * Minimum gap between advisory heartbeat writes.
 *
 * A heartbeat is a full-row conditional D1 UPDATE. Beating on every id-collect
 * page, every vector batch and two or three times per R2 delete page put
 * hundreds of D1 writes inside one delivery for a large tenant, each one
 * re-serializing the whole row. Since the lease is a version and no longer
 * load-bearing for correctness, the beat only has to be frequent enough that
 * cron does not think the job died: one minute is a fifteen-fold margin under
 * `ACCOUNT_WIPE_IN_FLIGHT_MS`.
 *
 * Throttling only ever loses *advisory* state. Everything a later delivery must
 * see — the lease claim, a phase transition, a `continue`'s cursor and
 * continuation count, probe bookkeeping, and the terminal record — goes through
 * `persist()`, which always writes. A crash between beats costs re-listing a
 * prefix or re-submitting an idempotent `deleteByIds`, never correctness.
 *
 * One consequence worth naming: a delivery that has lost the lease now finds
 * out at the next persist rather than at the next page, so it can keep deleting
 * for up to this long after a sibling took over. Both are deleting the same
 * tenant's prefix, so the outcome is identical either way.
 */
export const ACCOUNT_WIPE_HEARTBEAT_INTERVAL_MS = 60_000;
/** Operator alert: the namespace still answered after the probe bound. */
export const ACCOUNT_WIPE_NAMESPACE_RESIDUE_EVENT = "account_wipe_namespace_residue";
/** Operator alert: `status='deleting'` with no `deleting_at_ms` (finding F6). */
export const ACCOUNT_WIPE_MISSING_DELETING_AT_EVENT = "account_wipe_missing_deleting_at";
export const R2_LIST_LIMIT = 1000;
export const ACCOUNT_WIPE_DEFAULT_OBJECT_PAGES = 20;
export const ACCOUNT_WIPE_DEFAULT_VECTOR_BATCHES = 20;

export const ACCOUNT_WIPE_QUEUE_NAMES = [
  "reading-lite-wipe",
  "reading-lite-staging-wipe",
] as const;
export const ACCOUNT_WIPE_DLQ_NAMES = [
  "reading-lite-wipe-dlq",
  "reading-lite-staging-wipe-dlq",
] as const;

export interface AccountWipeEnv {
  CONTROL_PLANE: D1Database;
  READINGS_BUCKET: R2Bucket;
  READINGS_INDEX?: VectorizeIndex;
  ACCOUNT_WIPE_JOBS?: Queue<AccountWipeEnvelopeV1>;
  TENANT_DATA_PLANE?: string;
}

export interface AccountWipeJobDeps {
  /** Consume-start clock; used for the grace gate. */
  nowMs: number;
  /**
   * Clock for lease heartbeats. Defaults to `Date.now`. Since the lease CAS is
   * a version rather than a timestamp, a frozen clock here costs at most a
   * redundant cron enqueue that then skips — it can no longer lose a cursor.
   */
  now?: () => number;
  maxObjectPages?: number;
  maxVectorBatches?: number;
}

function wipeJobNow(deps: AccountWipeJobDeps): number {
  return deps.now ? deps.now() : Date.now();
}

/**
 * The tenant namespace still returned a vector after the wipe emptied R2.
 * Retryable on the propagation-lag schedule, not the fast exponential — see
 * ACCOUNT_WIPE_PROBE_RETRY_DELAY_SECONDS.
 */
export class AccountWipeNamespaceNotEmptyError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly remaining: number,
    public readonly attempts: number,
    /** True when the probe threw rather than returning matches. */
    public readonly unconfirmed = false,
  ) {
    // Say which of the two this was. "0 still answering" would assert residue
    // nobody observed, and these intermediate retries are what an operator
    // actually watches while the wipe is still running — the residue vs
    // unconfirmed distinction cannot wait for the final alert.
    super(
      unconfirmed
        ? `account_wipe namespace_unconfirmed for ${tenantId}: probe failed ` +
            `(attempt ${attempts}/${ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS})`
        : `account_wipe namespace_not_empty for ${tenantId}: ${remaining} still answering ` +
            `(probe attempt ${attempts}/${ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS})`,
    );
    this.name = "AccountWipeNamespaceNotEmptyError";
  }
}

/**
 * This pass has self-sent `continue` as often as it is allowed to (F7).
 *
 * Thrown instead of sending another message, so the delivery retries on the
 * ordinary schedule and dead-letters once `max_retries` is spent, which is the
 * whole point: a wipe that cannot finish should become visible rather than
 * cycling forever on a budget it keeps resetting.
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

export type AccountWipeSkipReason =
  | "grace_period"
  | "not_deleting"
  | "not_found"
  | "no_tenant_prefix"
  | "lease_held";

export type AccountWipeResult =
  | { kind: "skipped"; reason: AccountWipeSkipReason }
  | {
      kind: "continue";
      objects_deleted: number;
      mutation_ids: string[];
      r2_cursor?: string;
    }
  | { kind: "complete"; objects_deleted: number; mutation_ids: string[]; residue: boolean };

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

/** Incomplete or leftover progress is a resume, not a new wipe. */
export function wipeNeedsResume(
  progress: { completedAtMs: number | null } | null,
  hasLeftoverObjects: boolean,
): boolean {
  if (!progress) return false;
  return progress.completedAtMs === null || hasLeftoverObjects;
}

/** True while cron should not enqueue a duplicate delivery. */
export function wipeLeaseHeld(updatedAtMs: number, nowMs: number): boolean {
  return nowMs - updatedAtMs < ACCOUNT_WIPE_IN_FLIGHT_MS;
}

export function readingIdFromRelativeKey(relativeKey: string): string | null {
  if (relativeKey.startsWith(BY_ID_PREFIX)) {
    const rest = relativeKey.slice(BY_ID_PREFIX.length);
    const id = rest.split("/")[0] ?? "";
    return parseReadingId(id);
  }
  if (!relativeKey.startsWith(READINGS_PREFIX)) return null;
  const match = /T\d{6}Z-(rd_[0-9A-HJKMNP-TV-Z]{10})(?:\/|$)/.exec(relativeKey);
  return match ? parseReadingId(match[1] ?? "") : null;
}

export async function listDeletingUsers(
  db: ControlPlaneDb,
): Promise<Array<{ id: string; deleting_at_ms: number | null }>> {
  return db.all<{ id: string; deleting_at_ms: number | null }>(
    `SELECT id, deleting_at_ms FROM users WHERE status = 'deleting' ORDER BY id`,
  );
}

/**
 * Finding F6. `deleting_at_ms` is what grace is measured from, so a NULL one can
 * never elapse: the tenant sits in `deleting` and is never wiped, silently. Warn
 * rather than throw — the inconsistency is upstream of this module, blocking on
 * it would strand every other tenant on the tick, and an operator can force the
 * wipe once they see it.
 */
function warnMissingDeletingAt(tenantId: string, deletingAtMs: number | null | undefined): void {
  if (deletingAtMs != null) return;
  console.warn(
    JSON.stringify({
      event: ACCOUNT_WIPE_MISSING_DELETING_AT_EVENT,
      tenant_id: tenantId,
      note:
        "users.status='deleting' with no deleting_at_ms: the grace window can never elapse, " +
        "so this wipe will not start on its own. Force it or repair the row.",
    }),
  );
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
  // tenant prefix to wipe. Do not claim a lease or enqueue — the job would skip
  // at no_tenant_prefix, and cron would retry forever.
  if (!tenantDataPlaneEnabled(env)) {
    console.warn(JSON.stringify({ event: "account_wipe_fanout_skipped", reason: "no_tenant_prefix" }));
    return { enqueued: 0 };
  }
  const db = fromD1(env.CONTROL_PLANE);
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
        // Never wiped. Grace gates the start — and, unlike the R2-backed
        // version, no prefix probe is needed to tell "never wiped" from
        // "already wiped": the completion record answers that directly.
        if (!wipeGraceElapsed(row.deleting_at_ms, deps.nowMs)) continue;
      } else if (stored.completedAtMs !== null) {
        // Finished. Reopen only if objects turned up under the prefix after the
        // fact; otherwise leave the completion record exactly as it is.
        if (!(await tenantPrefixHasObjects(env.READINGS_BUCKET, tenantId, env))) continue;
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
      // the read and here wins, and this user is skipped for the tick rather
      // than having its cursor overwritten by a fan-out that never ran it.
      await new WipeProgressWriter(db, tenantId, stored).write(next);
      await queue.send(accountWipeEnvelopeV1({ tenantId, force }));
      enqueued += 1;
    } catch (error) {
      if (error instanceof AccountWipeProgressConflictError) {
        // Someone else claimed this tenant between our read and our write. Not
        // an error: skip the user for this tick.
        continue;
      }
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
  try {
    return await runAccountWipeJob(envelope, env, deps);
  } catch (error) {
    if (error instanceof AccountWipeProgressConflictError) {
      // A sibling delivery owns this wipe. Ack rather than retry: the winner is
      // already making the progress this message would duplicate, and a retry
      // would only spend budget losing the same CAS again.
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
  }
}

async function runAccountWipeJob(
  envelope: AccountWipeEnvelopeV1,
  env: AccountWipeEnv,
  deps: AccountWipeJobDeps,
): Promise<AccountWipeResult> {
  const tenantId = parseTenantId(envelope.tenantId);
  if (!tenantId) return { kind: "skipped", reason: "not_found" };

  const db = fromD1(env.CONTROL_PLANE);
  const user = await db.first<{ status: string; deleting_at_ms: number | null }>(
    "SELECT status, deleting_at_ms FROM users WHERE id = ?",
    tenantId,
  );
  if (!user) return { kind: "skipped", reason: "not_found" };
  if (user.status !== "deleting") return { kind: "skipped", reason: "not_deleting" };
  warnMissingDeletingAt(tenantId, user.deleting_at_ms);

  if (!tenantDataPlaneEnabled(env)) {
    return { kind: "skipped", reason: "no_tenant_prefix" };
  }
  const keyRoot = tenantKeyRoot({ tenantId }, true);
  if (keyRoot === "") return { kind: "skipped", reason: "no_tenant_prefix" };

  const layout = r2KeyLayout(keyRoot);
  const maxObjectPages = deps.maxObjectPages ?? ACCOUNT_WIPE_DEFAULT_OBJECT_PAGES;
  const maxVectorBatches = deps.maxVectorBatches ?? ACCOUNT_WIPE_DEFAULT_VECTOR_BATCHES;

  const stored = await readWipeProgress(db, tenantId);
  const leftover =
    stored !== null && stored.completedAtMs !== null
      ? await prefixHasObjects(env.READINGS_BUCKET, keyRoot)
      : false;
  const resuming = wipeNeedsResume(stored, leftover);
  const force = envelope.force || stored?.force === true;
  // Grace only gates starting a new wipe. Resume (in-progress, leftover, expired
  // lease) proceeds even during grace; force:true still starts during grace.
  if (!force && !wipeGraceElapsed(user.deleting_at_ms, deps.nowMs) && !resuming) {
    return { kind: "skipped", reason: "grace_period" };
  }

  const now = () => wipeJobNow(deps);
  let progress: WipeProgress;
  if (stored === null) {
    progress = emptyWipeProgress(now(), force);
  } else if (stored.completedAtMs !== null) {
    if (!leftover) {
      // Already wiped and nothing came back. Report the stored outcome and
      // leave the completion record untouched — it is evidence now, not a
      // resume point, and rewriting it would move `completed_at_ms`.
      return {
        kind: "complete",
        objects_deleted: stored.objectsDeleted,
        mutation_ids: stored.mutationIds,
        residue: stored.residue,
      };
    }
    // Re-derive the ids from an R2 re-list and Vectorize-delete before touching
    // R2. Jumping straight to objects would empty the prefix and leave the ids
    // this pass has not yet submitted with no source to derive them from.
    progress = reopenWipeProgress(stored, force);
  } else {
    progress = { ...stored, force };
  }

  // Fail closed on an unbound index, before either phase runs. The vectors phase
  // and the terminal probe each enforce this on their own, but neither covers a
  // delivery that resumes straight into `objects`: that path would empty the
  // tenant prefix and only then discover it has no way to delete the vectors —
  // having just destroyed the only source of their ids. Deliberately placed
  // BELOW the grace gate and the already-complete return above: neither touches
  // R2 objects or Vectorize, and throwing over them would trade a safe skip for
  // a dead-lettered job.
  if (!env.READINGS_INDEX) {
    throw new Error("account_wipe index_unbound");
  }

  const writer = new WipeProgressWriter(db, tenantId, stored);
  // `persist` always writes; `heartbeat` writes at most once an interval. Use
  // persist wherever a later delivery must see the state, heartbeat where the
  // only purpose is telling cron this job is still alive.
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
  const continueResult = async (): Promise<AccountWipeResult> => {
    // Bound the self-send before making it (F7). Persisted, so the count is the
    // pass's and not one delivery's.
    const next = progress.continuations + 1;
    if (next > ACCOUNT_WIPE_MAX_CONTINUATIONS) {
      throw new AccountWipeContinuationBudgetError(tenantId, progress.continuations);
    }
    progress.continuations = next;
    // Always persisted: the next delivery resumes from this cursor, and the
    // budget only bounds anything if it survives the self-send.
    await persist();
    return {
      kind: "continue",
      objects_deleted: progress.objectsDeleted,
      mutation_ids: progress.mutationIds,
      ...(progress.r2Cursor === undefined ? {} : { r2_cursor: progress.r2Cursor }),
    };
  };
  // Baseline for the terminal delta log, taken once per pass before anything is
  // submitted. Best-effort: null when the binding has no describe().
  if (!progress.indexCountSampled) {
    progress.indexCountStart = await similarityStoreFor(
      env.READINGS_INDEX,
      { tenantId },
      env,
    ).indexVectorCount();
    progress.indexCountSampled = true;
  }
  // Claim the lease before any listing, so a concurrent cron tick sees it and
  // skips instead of launching a duplicate against the same prefix. Record force
  // so cron resume can honor a force wipe that DLQ'd during grace. Always
  // written: this is the claim itself, not a beat.
  await persist();

  if (progress.phase === "vectors") {
    // Re-derived from R2 on every pass rather than persisted. The wipe itself
    // does not touch R2 until the objects phase, but a consumer still committing
    // a terminal manifest for this tenant can add or remove an id between
    // deliveries — which is why `vector_cursor` resumes by value rather than by
    // index (see submitVectorDeletes).
    const ids = await collectReadingIds(env.READINGS_BUCKET, layout, heartbeat);
    await heartbeat();
    const vec = await submitVectorDeletes(progress, ids, env, tenantId, maxVectorBatches, heartbeat);
    if (vec === "continue") return continueResult();
    progress.phase = "objects";
    // Always persisted: a phase transition is what a resuming delivery reads.
    await persist();
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
        await heartbeat();
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
          await heartbeat();
          break objects;
        }
        cursor = undefined;
        progress.r2Cursor = undefined;
      }
      if (pages >= maxObjectPages) return continueResult();
    }
  }

  // Both phases are done — the objects loop only falls through here once the
  // prefix is confirmed empty; every partial pass returned `continue` above.
  //
  // Terminal assurance before we are allowed to claim success (F3). The probe
  // throws while the namespace still answers, so an unbound index, a
  // never-submitted delete, or a delete that did not take leaves the job
  // retrying instead of reporting a wipe that removed nothing. It returns true
  // only when the bound is spent and the wipe finishes unconfirmed.
  const residue = await assertNamespaceEmptied(progress, env, tenantId, writer);
  const done = await writer.complete(progress, now(), residue);
  return {
    kind: "complete",
    objects_deleted: done.objectsDeleted,
    mutation_ids: done.mutationIds,
    residue: done.residue,
  };
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
    // A dirty terminal probe is asynchronous propagation, not a fault, so it
    // waits minutes rather than the 30s exponential every other failure uses.
    const delaySeconds =
      error instanceof AccountWipeNamespaceNotEmptyError
        ? ACCOUNT_WIPE_PROBE_RETRY_DELAY_SECONDS
        : wipeRetryDelaySeconds(retryAfterMs, msg.attempts ?? 1);
    // No lease extension here any more. The lease is a version in D1, not a
    // timestamp, so a cron tick during a long `Retry-After` costs at most a
    // duplicate delivery that claims the lease and does the work — after which
    // this message's retry loses the CAS and skips. Nothing to protect.
    msg.retry({ delaySeconds });
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

async function prefixHasObjects(bucket: R2Bucket, keyRoot: string): Promise<boolean> {
  const leftover = await bucket.list({ prefix: keyRoot, limit: 1 });
  return leftover.objects.length > 0;
}

async function tenantPrefixHasObjects(
  bucket: R2Bucket,
  tenantId: TenantId,
  env: { TENANT_DATA_PLANE?: string },
): Promise<boolean> {
  if (!tenantDataPlaneEnabled(env)) return false;
  const keyRoot = tenantKeyRoot({ tenantId }, true);
  if (keyRoot === "") return false;
  return prefixHasObjects(bucket, keyRoot);
}

async function submitVectorDeletes(
  progress: WipeProgress,
  ids: string[],
  env: AccountWipeEnv,
  tenantId: TenantId,
  maxVectorBatches: number,
  heartbeat: () => Promise<void>,
): Promise<"continue" | "done"> {
  // Fail closed BEFORE the emptiness test (F3). An empty id list means "R2
  // yielded no ids", not "this tenant has no vectors" — R2 is the only id
  // source and it may already be gone. Returning "done" here on an unbound
  // index let the wipe advance to the objects phase and report success without
  // ever addressing the index.
  if (!env.READINGS_INDEX) {
    throw new Error("account_wipe index_unbound");
  }
  // Resume by value. `ids` is sorted and re-derived per delivery, so slicing by
  // a stored index would drop whichever id fell on the boundary when the set
  // changed in between; "sorted after the last id submitted" cannot. It does
  // still miss an id that first appears below the cursor — a forward-only window
  // cannot see backwards — which the header lists with the other strandings
  // #261's ledger closes.
  const cursor = progress.vectorCursor;
  const pending = cursor === undefined ? ids : ids.filter((id) => id > cursor);
  if (pending.length === 0) return "done";
  const store = similarityStoreFor(env.READINGS_INDEX, { tenantId }, env);
  let batches = 0;
  let sent = 0;
  while (sent < pending.length && batches < maxVectorBatches) {
    const chunk = pending.slice(sent, sent + VECTORIZE_DELETE_MAX_IDS);
    const mutations = await store.deleteMany(chunk);
    for (const mutationId of mutations) {
      progress.mutationIds.push(mutationId);
      console.info(
        JSON.stringify({
          event: "account_wipe_vector_delete_submitted",
          tenant_id: tenantId,
          mutation_id: mutationId,
          note: "Vectorize deletes are async; embeddings may take a short time to disappear",
        }),
      );
    }
    sent += chunk.length;
    progress.vectorCursor = chunk[chunk.length - 1];
    // Advisory: losing this cursor to a crash re-submits ids to `deleteByIds`,
    // which is idempotent. A `continue` persists it before the self-send.
    await heartbeat();
    batches += 1;
  }
  return sent < pending.length ? "continue" : "done";
}

/**
 * The wipe may not report success while its tenant namespace still answers (F3).
 *
 * Vectorize exposes no list/scan, so absence is unprovable: this is nearest-K
 * sampling and a clean probe is evidence, not a guarantee. What it does catch is
 * the failure the review named — a wipe that deleted nothing at all and called
 * it done — plus a delete that was never submitted or did not take.
 *
 * A hit is retried, not failed outright, and on a minutes-scale delay
 * (`ACCOUNT_WIPE_PROBE_RETRY_DELAY_SECONDS`), because `deleteByIds` propagates
 * asynchronously and the first probe after submitting is expected to be dirty.
 * The retries are bounded (`ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS`): past that the
 * cause is not lag but a vector whose reading id is no longer derivable from
 * R2, which is unaddressable by construction. Retrying that forever would loop
 * the tenant through the DLQ and cron every 15 minutes with no progress
 * possible, so the bound converts the gate into a high-severity operator alert,
 * returns `true`, and lets the wipe finish with `residue` recorded. The alert
 * carries the tenant id and nothing else: an alert about a deleted account must
 * not re-publish that account's reading ids to the log.
 *
 * The `describe()` delta is logged beside it as coarse corroboration. It counts
 * the whole index rather than one namespace and Vectorize deletes are async, so
 * it is never a gate — a zero delta after submitting ids is a signal for an
 * operator, not grounds to fail the job.
 *
 * @returns true when the bound was spent without a clean confirmation.
 */
async function assertNamespaceEmptied(
  progress: WipeProgress,
  env: AccountWipeEnv,
  tenantId: TenantId,
  writer: WipeProgressWriter,
): Promise<boolean> {
  if (!env.READINGS_INDEX) {
    throw new Error("account_wipe index_unbound");
  }
  const store = similarityStoreFor(env.READINGS_INDEX, { tenantId }, env);
  const countEnd = await store.indexVectorCount();
  const countStart = progress.indexCountStart;
  const submitted = progress.mutationIds.length;
  const delta = countStart !== null && countEnd !== null ? countStart - countEnd : null;
  // Corroboration only, and weak corroboration at that: this counts the whole
  // shared index rather than one namespace, both samples come from the same job
  // run seconds apart, and Vectorize deletes propagate asynchronously while
  // other tenants keep upserting. A non-positive delta is therefore the normal
  // reading even for a perfectly clean wipe, which is why it is one field of an
  // info line and not an alert — a high-severity warning that fires on every
  // wipe would train an operator to ignore the channel the residue alert below
  // depends on.
  console.info(
    JSON.stringify({
      event: "account_wipe_vector_count_delta",
      tenant_id: tenantId,
      index_count_start: countStart,
      index_count_end: countEnd,
      delta,
      submitted_batches: submitted,
      note: "whole-index count, not per-namespace, sampled seconds apart; Vectorize deletes are async, so a non-positive delta is not by itself a fault",
    }),
  );
  // A probe that FAILS is not a probe that HIT. A transient Vectorize query
  // error must not take the fast 30s exponential and dead-letter in ~3.5
  // minutes a wipe that is otherwise finished, so it takes the same slow,
  // bounded path as a dirty probe — but it is tracked separately, because the
  // two mean different things to whoever reads the alert at the end: "vectors
  // are still there" versus "we never got an answer".
  let remaining: Awaited<ReturnType<typeof store.probeNamespace>> = [];
  let probeErrored = false;
  try {
    remaining = await store.probeNamespace();
  } catch (error) {
    probeErrored = true;
    console.warn(
      JSON.stringify({
        event: "account_wipe_probe_failed",
        tenant_id: tenantId,
        message: error instanceof Error ? error.message : String(error),
        note: "could not confirm the namespace is empty; retrying on the propagation schedule",
      }),
    );
  }
  if (!probeErrored && remaining.length === 0) return false;

  const attempts = progress.probeAttempts + 1;
  // Sticky across attempts: once a probe has actually seen a vector, a later
  // transient error must not downgrade the verdict to "we could not check".
  const sawResidue = progress.probeSawResidue || remaining.length > 0;
  if (attempts < ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS) {
    // Persist before throwing, so both the bound and the verdict survive the
    // retry this throw causes rather than resetting on every redelivery.
    progress.probeAttempts = attempts;
    progress.probeSawResidue = sawResidue;
    await writer.write(progress);
    throw new AccountWipeNamespaceNotEmptyError(
      tenantId,
      remaining.length,
      attempts,
      probeErrored,
    );
  }
  progress.probeAttempts = attempts;
  progress.probeSawResidue = sawResidue;
  // Bound exhausted. Alert and let the wipe finish — R2 is already empty and
  // every id we could derive has been submitted, so another 15-minute cycle
  // changes nothing. `outcome` is what the reader acts on: `residue` means some
  // probe genuinely saw vectors still there; `unconfirmed` means no probe ever
  // did and we never got a clean answer, which is a Vectorize health question
  // rather than a finding about this account. Both land as `residue = 1` on the
  // completion record; `probe_saw_residue` beside it keeps them apart.
  console.error(
    JSON.stringify({
      severity: "high",
      event: ACCOUNT_WIPE_NAMESPACE_RESIDUE_EVENT,
      tenant_id: tenantId,
      probe_attempts: attempts,
      outcome: sawResidue ? "residue" : "unconfirmed",
      note: sawResidue
        ? "tenant namespace still answered after the probe bound; vectors whose reading id is " +
          "no longer derivable from R2 are unaddressable (deleteByIds needs the id). " +
          "Wipe completed; residue needs the vector ledger (issue #261)."
        : "the namespace probe never returned a clean answer, so the wipe could not be " +
          "confirmed; check Vectorize health. Wipe completed.",
    }),
  );
  return true;
}

async function collectReadingIds(
  bucket: R2Bucket,
  layout: ReturnType<typeof r2KeyLayout>,
  heartbeat?: () => Promise<void>,
): Promise<string[]> {
  // Still scans both prefixes to completion in this job (large-tenant paging
  // residual). Heartbeats after list.json and each inner list page so a long
  // collect keeps cron quiet — no longer a correctness requirement, since a
  // duplicate cron delivery now loses the lease CAS rather than clobbering.
  const ids = new Set<string>();
  const listObj = await bucket.get(layout.listIndexKey());
  if (listObj) {
    try {
      const parsed = ListIndexSchema.safeParse(JSON.parse(await listObj.text()));
      if (parsed.success) {
        for (const item of parsed.data.items) {
          const id = parseReadingId(item.id);
          if (id) ids.add(id);
        }
      }
    } catch {
      // Corrupt list index is not a wipe failure; R2 listing still finds ids.
    }
  }
  await heartbeat?.();
  await scanPrefixForIds(bucket, layout.byIdKey(""), layout, ids, heartbeat);
  await scanPrefixForIds(bucket, layout.readingsPrefix(), layout, ids, heartbeat);
  return [...ids].sort();
}

async function scanPrefixForIds(
  bucket: R2Bucket,
  prefix: string,
  layout: ReturnType<typeof r2KeyLayout>,
  ids: Set<string>,
  heartbeat?: () => Promise<void>,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const list = await bucket.list({
      prefix,
      limit: R2_LIST_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    for (const obj of list.objects) {
      const id = readingIdFromRelativeKey(layout.relativeKey(obj.key));
      if (id) ids.add(id);
    }
    cursor = list.truncated ? list.cursor : undefined;
    await heartbeat?.();
  } while (cursor);
}
