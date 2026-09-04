/**
 * Deferred tenant R2 + Vectorize wipe (issue 195b / s1k.10.1).
 *
 * The invariants this module holds, what the vector ledger closed, and the one
 * stranding that survives it.
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
 * before that phase's first R2 delete. This no longer protects an id *source* —
 * the ledger holds the ids and R2 cannot lose them — but it still keeps the
 * user-visible order right: a reading whose vector is gone while its objects
 * remain is missing from search, whereas the reverse is a listed reading whose
 * detail page 404s.
 *
 * **The ledger is the id source, and the termination condition.** Every vector
 * writer records the reading id in D1 `vector_ledger` (migration `0010`,
 * `src/control-plane/vector-ledger.ts`) BEFORE it upserts. The wipe submits
 * `deleteByIds` for the tenant's `live` rows, marks them `delete_submitted`,
 * and finishes only when the namespace probes clean AND no row of either state
 * remains — cleared under the confirmation rule S6 measured, never on a single
 * unconfirmed read. "The R2 prefix is empty" is no longer evidence of anything
 * about the index.
 *
 * **The wipe seeds the ledger itself, before anything is deleted.** The ledger
 * can only name vectors it has rows for, and a corpus that predates it has
 * none. So the first thing a wipe does is page its own key root, derive every
 * reading id it finds, and insert the missing rows — R2 is intact at that
 * moment, being the very thing about to be deleted, so the wipe holds exactly
 * the inputs an operator's `ops corpus seed-vector-ledger` would.
 *
 * The invariant that buys is local and inductive: **no object is deleted before
 * its reading id is in the ledger.** No global comparison to get right, no
 * proxy set to be wrong about, no operator in the critical path, and nothing
 * that can refuse a healthy tenant.
 *
 * It replaced a pre-flight coverage CHECK that compared the ledger against the
 * `ready` rows of `index/list.json` and refused when it fell short. That was
 * unsound in the direction that mattered: a reading whose vector outlived its
 * `ready` status — reprocessed to `failed` (the failure path publishes with a
 * null similarity store and deliberately leaves the vector alone), dropped from
 * the list index, partially purged — has a live vector and no `ready` row, so
 * it passed the check and was stranded anyway. The check's own failure mode was
 * the one it existed to prevent. The key space has no such blind spot: every
 * reading with any object left carries its id in that object's key.
 *
 * **Fail closed on an unbound index.** With no `READINGS_INDEX` the job throws
 * (`index_unbound`) before either phase runs, so no R2 object is deleted while
 * nothing can delete the matching vectors — including on a delivery that resumes
 * straight into `objects` and would otherwise never reach a vector call. The
 * vectors phase repeats the check *before* reading the ledger, and the terminal
 * confirmation repeats it again, so no path reaches R2 without one.
 * Cron fan-out has no such check, so with the binding gone it still claims a
 * lease and enqueues; every delivery then throws. That is loud rather than
 * destructive, which is the side to err on.
 *
 * **A wipe never reports success while a ledger row survives.** Before the
 * terminal transition it confirms the deletes actually landed and clears the
 * rows they covered. The rule is measured, not assumed (report
 * `rl-195-s6-staging-gate` §5, which supersedes the design's sketch wherever
 * the two differ): one namespaced `query` as a fast path, per-id `getByIds`
 * as the fallback, two spaced absences from *successful* responses before any
 * row clears, and no first attempt until 120s after `deleteByIds` returned —
 * S6 measured propagation at 30-90s, so an immediate probe was guaranteed to
 * hit and burned one of the attempts on no information (defect D2). The
 * attempts are bounded (`ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS`); past the bound it
 * raises a high-severity `account_wipe_namespace_residue` alert carrying the
 * tenant id and nothing else, records `residue` on the completion record, and
 * completes rather than looping a doomed job through the DLQ every 15 minutes.
 * The ledger rows are deliberately LEFT in place in that case: they are the
 * only remaining handle on the vectors nobody could confirm gone, and S5's
 * residue scan reads them.
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
 * the terminal write clears the R2 cursor, so the record that survives holds no
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
 * **Resumability is stateless beyond one cursor.** The record carries phase,
 * the R2 list cursor, and lease/probe/continuation bookkeeping — nothing else.
 * The vectors phase needs no cursor at all: it reads `state = 'live'` ledger
 * rows and flips each batch to `delete_submitted` as it submits, so the query
 * advances itself and, unlike the forward-only `vector_cursor` it replaces,
 * cannot skip an id that appears below where the last pass stopped.
 *
 * ## The races this closes, and the one it does not
 *
 * Four strandings used to share one cause: `deleteByIds` needs an id, ids came
 * only from R2, and R2 was emptied by this very job. All four are closed by the
 * ledger writing the id BEFORE the upsert, at every writer site — the publisher
 * (`reading-visibility.ts`), the single-reading purge (`reading-purge.ts`), and
 * the three offline writers (`corpus backfill-vectors`, `corpus
 * migrate-founder`, `batch/write-phase`) that check no `users.status` and could
 * upsert into a tenant whose wipe was already past its vectors phase. The
 * publisher fence (`ReadingVisibility.removeForDeletedTenant`) still runs and
 * is still worth having — it deletes promptly rather than waiting for a later
 * pass — but the wipe no longer depends on it, and its two escape hatches (a
 * D1 recheck that fails open, an isolate that dies between the upsert and the
 * recheck) no longer strand anything: the row is already written.
 *
 * **What the ledger does not fix is the past, and one piece of that is a gate
 * on #195 rather than a footnote.**
 *
 * Two shapes survive this slice, and they are not equally benign.
 *
 * The first is unrecoverable: a reading purged from R2 before this slice whose
 * vector delete failed has no ledger row and never will, because there is
 * nothing left to derive one from. `ops corpus seed-vector-ledger` covers every
 * reading an existing corpus still *has*; a vector already orphaned when the
 * ledger arrived is unseedable by construction. That is the honest residual of
 * review finding F3.
 *
 * The second IS recoverable and must be recovered. Until the fix in this same
 * change, `batch/write-phase` wrote tenant vectors under BARE reading ids
 * (`makeVectorizeClient.upsert` attaches a namespace but never composed
 * `tenantVectorId`). Any tenant that ever ran `ops corpus ingest` or
 * `corpus recover --batch` under `--tenant` therefore has vectors this wipe
 * cannot address: `deleteByIds` submits the composed id and misses them. Every
 * wipe for such a tenant will spend its attempts, alert, and complete with
 * `residue = 1` while those embeddings survive account deletion — indefinitely,
 * until they are repaired.
 *
 * That population also has a live-tenant cost that has nothing to do with
 * deletion: a bare-id vector and a composed one for the same reading are two
 * distinct matches to a namespaced query, so the reading turns up twice in its
 * own neighbourhood and duplicates land in `manifest.similarity`. It is NOT
 * auto-healed here — see `WriteDeps.vectorNamespace` in
 * `scripts/corpus-lib/batch/write-phase.ts` for why deleting the bare id from
 * the batch writer would destroy retained legacy vectors instead. S5 owns both
 * halves: the wipe residue and the search duplication.
 *
 * **So `residue = 1` on such a tenant is not a healthy outcome to be filed
 * away.** It is that known gap, and repairing it in production is a gate on
 * #195's acceptance bullet 3 ("a repeatable residue scan reports zero
 * tenant-owned data"), not optional cleanup. Slice S5 owns the audit and
 * repair; this header is the warning not to read the flag as noise before then.
 *
 * The other thing the ledger cannot do is prove absence. Vectorize has no scan;
 * the confirmation rule is per-id evidence plus a namespace sample, and both
 * are sampling. What it CAN do is name every id it is responsible for, which is
 * the difference between residue that can be re-swept and residue that cannot.
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
 * losing a beat costs a re-list or an idempotent re-submit rather than lost
 * work.
 *
 * One thing a lost beat does cost, named rather than hidden behind "never
 * correctness": `objects_deleted` is incremented before a page's delete and
 * only reaches D1 on the next write, so an isolate that dies after the delete
 * but before that write leaves those objects genuinely gone and uncounted. The
 * completion record's tally can undercount. Nothing branches on it — it is a
 * reporting figure — but do not read it as an audited count of what was
 * destroyed.
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
  applyAbsenceObservation,
  chunkForGetByIds,
  clearLedgerRows,
  clearTenantLedger,
  confirmBackoffSeconds,
  countLedgerRows,
  d1VectorLedger,
  earliestConfirmableAtMs,
  insertMissingLedgerRows,
  listDeleteSubmittedEntries,
  listLiveLedgerIds,
  recordAbsences,
  resetAbsenceStreaks,
  type GetByIdsObservation,
} from "./control-plane/vector-ledger";
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
 * How many terminal confirmation passes may fail before the wipe stops waiting.
 *
 * Four, and `max_retries` on both wipe consumers (wrangler.toml) must stay
 * STRICTLY ABOVE it — currently by two. Not every retry spends an attempt: the
 * +120s first-confirmation deferral retries without counting one, and so does
 * any transient D1/R2/Vectorize error, so an equal budget dead-letters a
 * healthy wipe before the bound ever trips.
 * `test/unit/deploy/account-wipe-wrangler.test.ts` pins the inequality;
 * raising this without raising `max_retries` in the same commit fails it.
 *
 * Sized off the measured schedule, not picked round (report
 * `rl-195-s6-staging-gate` §5.2): the first attempt is at +120s and the
 * backoff runs 120s → 240s → 480s, so four attempts reach ~t+16 minutes of
 * real patience against a propagation latency measured at 30-90s. Three
 * attempts on the old flat 300s schedule reached ~10 minutes, one of which was
 * always spent on a premature first probe (defect D2).
 *
 * Past the bound the likely cause is not lag but a vector nobody can confirm —
 * a pre-ledger stranding, or an index that has stopped answering — which no
 * amount of retrying fixes, so the wipe alerts an operator, records `residue`,
 * keeps the ledger rows, and completes rather than failing in a loop.
 */
export const ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS = 4;
/**
 * How many ledger rows one delivery will confirm.
 *
 * `getByIds` is capped at 20 ids a request, so this is 25 requests. Bounded
 * because a confirmation pass is the last thing standing between a wipe and its
 * terminal write; a tenant with tens of thousands of rows should make partial
 * progress across deliveries rather than time the isolate out.
 */
export const ACCOUNT_WIPE_CONFIRM_BATCH = 500;
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
 * prefix or re-submitting an idempotent `deleteByIds` — never un-deleted data,
 * though it can undercount `objects_deleted` (see the header).
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
/**
 * R2 pages the seed step walks per delivery.
 *
 * Five, not the objects phase's twenty, because a seed page costs far more than
 * a list call. A page of up to `R2_LIST_LIMIT` keys can yield that many
 * distinct reading ids — a run of `index/by-id/{id}` keys is exactly one id per
 * object — and each `VECTOR_LEDGER_WRITE_CHUNK` of them is its own D1
 * statement. Twenty pages would therefore put ~1000 D1 statements in one
 * invocation on a large tenant, on top of the vectors and objects phases that
 * may run in the same delivery: the same Workers subrequest ceiling that cut
 * ACCOUNT_WIPE_DEFAULT_VECTOR_BATCHES to 5. Five pages keeps the step near 250
 * statements and still covers 5000 objects a delivery, with `continue`
 * self-sends carrying the rest.
 */
export const ACCOUNT_WIPE_DEFAULT_SEED_PAGES = 5;
/**
 * Vector batches per delivery.
 *
 * Five, not twenty, because each batch is now more than one call. A batch reads
 * up to `VECTORIZE_DELETE_MAX_IDS` ledger rows, submits one `deleteByIds`, and
 * marks them `delete_submitted` in `ceil(1000 / VECTOR_LEDGER_WRITE_CHUNK)`
 * statements — so twenty batches put ~1000 D1 statements in a single
 * invocation, at or over the Workers subrequest ceiling for a large tenant, and
 * the failure mode is silent retry churn. Five keeps a delivery near 250
 * statements and still moves 5000 ids; `continue` self-sends carry the rest,
 * bounded by ACCOUNT_WIPE_MAX_CONTINUATIONS.
 */
export const ACCOUNT_WIPE_DEFAULT_VECTOR_BATCHES = 5;

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
  maxSeedPages?: number;
}

function wipeJobNow(deps: AccountWipeJobDeps): number {
  return deps.now ? deps.now() : Date.now();
}

/**
 * Ledger rows survived this delivery's confirmation pass.
 *
 * Retryable on the measured propagation schedule rather than the fast
 * exponential every other failure uses, so it carries its own delay: the
 * doubling backoff after a real attempt, or simply the wait remaining before
 * the first attempt is allowed to count.
 */
export class AccountWipeNamespaceNotEmptyError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly remaining: number,
    public readonly attempts: number,
    public readonly retryAfterSeconds: number,
    /**
     * True when nothing was actually observed — the confirmation calls failed,
     * or none of the rows was old enough to count yet. Kept distinct from a
     * genuine sighting because the two mean different things to whoever reads
     * the alert at the end: "vectors were still there" versus "we never got an
     * answer".
     */
    public readonly unconfirmed = false,
  ) {
    super(
      unconfirmed
        ? `account_wipe ledger_unconfirmed for ${tenantId}: ${remaining} row(s) unconfirmed ` +
            `(attempt ${attempts}/${ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS}, retry in ${retryAfterSeconds}s)`
        : `account_wipe ledger_not_empty for ${tenantId}: ${remaining} row(s) remain ` +
            `(attempt ${attempts}/${ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS}, retry in ${retryAfterSeconds}s)`,
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

/**
 * The reading id a tenant-relative R2 key belongs to, or null.
 *
 * The wipe itself no longer walks R2 for ids — the ledger holds them — but this
 * is still the corpus-walking rule, and `ops corpus seed-vector-ledger` is the
 * one thing that must reproduce it exactly when it back-fills the ledger for an
 * existing corpus. It stays here, single-homed, rather than being re-spelled
 * there: a seeding walk that disagreed with this by one character would leave a
 * hole in the ledger, and a ledger with a hole is worse than no ledger because
 * the wipe would terminate on a false empty.
 *
 * `parseReadingId` enforces the Crockford alphabet (no I, L, O, U), which is
 * why the seeding command reads existing ids rather than generating any — S6's
 * own drill lost a seeding pass to exactly that (observation O1).
 */
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

  // SEED FIRST, before a single delete or a single object is removed.
  //
  // The ledger can only name vectors it has rows for, and a corpus that
  // predates it has none. So the wipe establishes that coverage itself rather
  // than asserting it: it pages its own key root, derives every reading id it
  // finds, and inserts the missing rows. R2 is intact at this moment — it is
  // the very thing about to be deleted — so the wipe holds exactly the inputs
  // an operator's `ops corpus seed-vector-ledger` would.
  //
  // The invariant this buys is local and inductive: NO OBJECT IS DELETED BEFORE
  // ITS READING ID IS IN THE LEDGER. There is no global comparison to get
  // right, no proxy set to be wrong about, and no operator in the critical
  // path.
  //
  // It replaced a pre-flight coverage CHECK that compared the ledger against
  // the `ready` rows of `index/list.json` and refused when it fell short. That
  // was unsound in the direction that mattered: a reading whose vector outlived
  // its `ready` status — reprocessed to `failed` (the failure path publishes
  // with a null similarity store and deliberately leaves the vector alone),
  // dropped from the list index, partially purged — has a live vector and no
  // `ready` row, so it passed the check and was stranded anyway. The check's
  // own failure mode was the one it existed to prevent. The key space has no
  // such blind spot: every reading with any object left carries its id in that
  // object's key.
  if (progress.seedCompletedAtMs === null) {
    const seed = await seedLedgerFromCorpus(
      progress,
      env.READINGS_BUCKET,
      db,
      tenantId,
      keyRoot,
      deps.maxSeedPages ?? ACCOUNT_WIPE_DEFAULT_SEED_PAGES,
      persist,
      now,
    );
    if (seed === "continue") return continueResult();
    progress.seedCompletedAtMs = now();
    progress.seedCursor = undefined;
    // Always persisted: a resuming delivery reads this to know it need not
    // re-page a corpus it has already covered.
    await persist();
  }

  if (progress.phase === "vectors") {
    // Ids come from the ledger, never from R2. Each batch flips to
    // `delete_submitted` as it is submitted, so the "still live" query advances
    // itself across deliveries with no cursor to keep — and an id written by a
    // late publisher lands in the same query rather than below a forward-only
    // window.
    const vec = await submitVectorDeletes(
      progress,
      db,
      env,
      tenantId,
      maxVectorBatches,
      heartbeat,
      now,
    );
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
    // Always written, once per pass, before the confirmation gate. The
    // confirmation now usually throws a retry (the first attempt is not allowed
    // to count until +120s), and the heartbeat above is throttled, so without
    // this the pass's `objects_deleted` would be dropped on the floor every
    // time rather than only on a crash. Still a reporting figure, still capable
    // of undercounting across a crash — but no longer guaranteed to.
    await persist();
  }

  // A `live` row that appeared after the vectors phase passed — a publisher, or
  // an operator's offline writer, landing inside this pass — has never been
  // submitted to `deleteByIds`. Go back to the vectors phase for it rather than
  // confirming around it: this delivery's phase is `objects`, so a plain retry
  // would re-enter below the vectors block and the row would be confirmed
  // forever without anything ever asking Vectorize to delete it.
  //
  // The self-send is bounded by ACCOUNT_WIPE_MAX_CONTINUATIONS like every other
  // one, so a tenant that somehow keeps acquiring vectors dead-letters where it
  // can be seen instead of cycling.
  if ((await countLedgerRows(db, tenantId)).live > 0) {
    progress.phase = "vectors";
    return continueResult();
  }

  // Both phases are done — the objects loop only falls through here once the
  // prefix is confirmed empty; every partial pass returned `continue` above.
  //
  // Terminal assurance before we are allowed to claim success (F3). The ledger
  // is the gate: it throws while any row survives, so an unbound index, a
  // never-submitted delete, or a delete that did not take leaves the job
  // retrying instead of reporting a wipe that removed nothing. It returns true
  // only when the attempt bound is spent and the wipe finishes unconfirmed.
  const residue = await assertLedgerEmptied(progress, env, db, tenantId, writer, now);
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
    // An unconfirmed ledger is asynchronous propagation, not a fault, so it
    // waits on its own measured schedule (the doubling 120/240/480s backoff, or
    // simply the remainder of the +120s first-attempt delay) rather than the
    // 30s exponential every other failure uses. The error carries the number:
    // it is the only thing that knows which of the two cases this is.
    const delaySeconds =
      error instanceof AccountWipeNamespaceNotEmptyError
        ? Math.min(ACCOUNT_WIPE_RETRY_MAX_DELAY_SECONDS, error.retryAfterSeconds)
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

/**
 * Record every reading id derivable from this tenant's R2 into the ledger.
 *
 * Insert-only: it never deletes a row and never resets one. A row an earlier
 * pass already moved to `delete_submitted` keeps its state, its delete stamp
 * and its absent streak, so re-seeding on a resume costs nothing and restarts
 * no confirmation clock.
 *
 * Over-records on purpose. A `failed` or `pending` reading has no vector, and a
 * row for it costs one no-op `deleteByIds` that then clears on the first
 * confirmation. A MISSING row costs a vector nobody can ever address. The two
 * errors are not comparable, so the walk takes the widest id source available —
 * the same three the operator command uses: `index/list.json`, `index/by-id/`,
 * and the `readings/` key layout.
 *
 * Paged on the same budget as the objects phase and resumable on its own
 * cursor, so a corpus larger than one delivery continues rather than timing
 * out. `index/list.json` is read on the first delivery only (when there is no
 * cursor yet): re-reading it on every continuation would re-derive ids the walk
 * has already covered.
 */
async function seedLedgerFromCorpus(
  progress: WipeProgress,
  bucket: R2Bucket,
  db: ControlPlaneDb,
  tenantId: TenantId,
  keyRoot: string,
  maxPages: number,
  persist: () => Promise<void>,
  now: () => number,
): Promise<"continue" | "done"> {
  const layout = r2KeyLayout(keyRoot);
  let created = 0;
  const record = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    created += await insertMissingLedgerRows(db, tenantId, ids, now());
  };

  if (progress.seedCursor === undefined) {
    // The list index names readings whose objects may already be partly gone,
    // so it can carry ids the key walk below will not find. Read once, at the
    // start of the walk.
    const listObj = await bucket.get(layout.listIndexKey());
    if (listObj) {
      // The READ is outside the catch, deliberately. A transient R2 error is
      // not a corrupt index, and treating it as one would silently narrow
      // coverage in exactly the case this read exists for — readings whose
      // objects are already partly purged, which the key walk below cannot
      // find. Let it propagate: the delivery retries and seeds properly.
      const raw = await listObj.text();
      let ids: string[] = [];
      try {
        const parsed = ListIndexSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          for (const item of parsed.data.items) {
            const id = parseReadingId(item.id);
            if (id) ids.push(id);
          }
        }
      } catch {
        // Genuinely unparseable, which is a different thing and not fatal: the
        // key walk below is the wider source, and refusing to seed over a
        // damaged index would strand the corpus it describes.
        ids = [];
      }
      await record(ids);
    }
    await persist();
  }

  let pages = 0;
  let cursor = progress.seedCursor;
  for (;;) {
    const list = await bucket.list({
      prefix: keyRoot,
      limit: R2_LIST_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    const ids: string[] = [];
    for (const obj of list.objects) {
      const id = readingIdFromRelativeKey(layout.relativeKey(obj.key));
      if (id) ids.push(id);
    }
    await record(ids);
    cursor = list.truncated ? list.cursor : undefined;
    progress.seedCursor = cursor;
    pages += 1;
    // PERSISTED per page, not heartbeated. The heartbeat is throttled to a
    // minute, so a delivery that trips the subrequest ceiling part-way through
    // a large tenant would otherwise write no cursor at all and make zero
    // forward progress — burning the retry budget and dead-lettering while
    // repeating the same first pages. One full-row UPDATE per page is a cheap
    // price for guaranteeing the walk advances.
    await persist();
    if (cursor === undefined) break;
    if (pages >= maxPages) {
      logSeeded(tenantId, created, "continue");
      return "continue";
    }
  }
  logSeeded(tenantId, created, "done");
  return "done";
}

/**
 * What the seed step had to create.
 *
 * The observability the retired coverage alert was really providing: a nonzero
 * count on a tenant an operator believes they seeded means the ledger was
 * incomplete, and that is worth knowing even though the wipe has just fixed it.
 * Zero is the healthy steady state once every writer ledgers before upserting.
 */
function logSeeded(tenantId: TenantId, created: number, outcome: "continue" | "done"): void {
  console.info(
    JSON.stringify({
      event: "account_wipe_ledger_seeded",
      tenant_id: tenantId,
      rows_created: created,
      outcome,
      note:
        "reading ids derived from R2 and inserted before any delete. A nonzero count means the " +
        "ledger did not already cover this corpus — expected on a corpus predating the ledger, " +
        "worth investigating on one that should have been complete.",
    }),
  );
}

/**
 * Submit `deleteByIds` for this tenant's `live` ledger rows.
 *
 * The ledger is both the id source and the cursor. Each batch is marked
 * `delete_submitted` immediately after the submission returns, so the next
 * `state = 'live'` read excludes it and a delivery that dies mid-phase resumes
 * exactly where it stopped without persisting anything on the progress record.
 *
 * The mark happens AFTER the submit, not before, because `deleted_at_ms` is
 * what the +120s first-confirmation delay is measured from and it must record
 * when the delete was actually asked for. A crash in that gap leaves the row
 * `live`, so the next pass re-submits — `deleteByIds` is idempotent and a
 * re-submit costs one call.
 */
async function submitVectorDeletes(
  progress: WipeProgress,
  db: ControlPlaneDb,
  env: AccountWipeEnv,
  tenantId: TenantId,
  maxVectorBatches: number,
  heartbeat: () => Promise<void>,
  now: () => number,
): Promise<"continue" | "done"> {
  // Fail closed BEFORE reading the ledger. An empty `live` set is now a real
  // answer rather than "R2 yielded no ids", but an unbound index still must not
  // let the wipe advance to the objects phase and report success without ever
  // addressing Vectorize.
  if (!env.READINGS_INDEX) {
    throw new Error("account_wipe index_unbound");
  }
  const store = similarityStoreFor(env.READINGS_INDEX, { tenantId }, env);
  const ledger = d1VectorLedger(db, tenantId);
  for (let batches = 0; batches < maxVectorBatches; batches++) {
    const ids = await listLiveLedgerIds(db, tenantId, VECTORIZE_DELETE_MAX_IDS);
    if (ids.length === 0) return "done";
    const mutations = await store.deleteMany(ids);
    await ledger.markDeleteSubmitted(ids, now());
    for (const mutationId of mutations) {
      progress.mutationIds.push(mutationId);
      console.info(
        JSON.stringify({
          event: "account_wipe_vector_delete_submitted",
          tenant_id: tenantId,
          mutation_id: mutationId,
          submitted: ids.length,
          note: "Vectorize deletes are async; the ledger rows clear only once the deletes are confirmed",
        }),
      );
    }
    await heartbeat();
  }
  // Out of batches. Ask once more rather than assume: a final batch that
  // happened to empty the ledger should finish the phase here instead of
  // costing a whole continuation.
  const remaining = await listLiveLedgerIds(db, tenantId, 1);
  return remaining.length > 0 ? "continue" : "done";
}

/**
 * The wipe may not report success while a ledger row survives.
 *
 * The confirmation rule is `src/control-plane/vector-ledger.ts`'s, applied here
 * against the live index. In order:
 *
 * 1. **Nothing before +120s.** If no row is old enough for an absence to count
 *    (`earliestConfirmableAtMs`), the delivery retries after the remaining wait
 *    WITHOUT spending an attempt. The old code probed immediately, inside the
 *    30-90s propagation window S6 measured, so the hit was guaranteed and the
 *    attempt bought nothing (defect D2). This is the fix.
 * 2. **Fast path: one namespaced `query`.** If the namespace answers nothing,
 *    no id in it can be live, and the whole tenant's ledger clears in one call
 *    rather than `ceil(n / 20)` (S6 §5.3). That probe was in lockstep with
 *    `getByIds` in every sample S6 took, and it is already the wipe's shipped
 *    terminal gate. A probe that THROWS is not a probe that came back empty: it
 *    falls through to the per-id path rather than clearing anything.
 * 3. **Fallback: per-id `getByIds`, 20 at a time.** A chunk that throws is no
 *    information — it resets the streaks it covered and confirms nothing. A
 *    chunk that succeeds is per-id evidence: ids returned are live, ids
 *    requested and not returned are candidate absences, and nothing is inferred
 *    about an id that was not requested.
 *
 * `describe()`, `vectorCount` and `processedUpToMutation` appear nowhere in
 * this path — S6 §3.5 measured all three going backwards between replicas.
 *
 * @returns true when the attempt bound was spent without clearing the ledger.
 */
async function assertLedgerEmptied(
  progress: WipeProgress,
  env: AccountWipeEnv,
  db: ControlPlaneDb,
  tenantId: TenantId,
  writer: WipeProgressWriter,
  now: () => number,
): Promise<boolean> {
  if (!env.READINGS_INDEX) {
    throw new Error("account_wipe index_unbound");
  }
  const store = similarityStoreFor(env.READINGS_INDEX, { tenantId }, env);
  logVectorCountDelta(progress, tenantId, await store.indexVectorCount());
  const before = await countLedgerRows(db, tenantId);
  const counts = before;
  const pending = await listDeleteSubmittedEntries(db, tenantId, ACCOUNT_WIPE_CONFIRM_BATCH);
  const nowMs = now();
  // Rule 1. Deliberately outside the attempt accounting: waiting is not a
  // failed observation, and charging it as one is exactly defect D2.
  if (pending.length > 0) {
    const due = earliestConfirmableAtMs(pending, nowMs);
    if (due !== null) {
      const waitSeconds = Math.max(1, Math.ceil((due - nowMs) / 1000));
      throw new AccountWipeNamespaceNotEmptyError(
        tenantId,
        counts.total,
        progress.probeAttempts,
        waitSeconds,
        true,
      );
    }
  }

  // Rule 2, the namespace probe — UNCONDITIONAL, including when the ledger is
  // empty, and that is the point rather than an oversight.
  //
  // An empty ledger is not proof of an empty namespace. It is also exactly what
  // an UNSEEDED tenant looks like: a corpus that predates this slice has
  // vectors and no rows, and merging auto-deploys production before anyone can
  // run `ops corpus seed-vector-ledger`. Short-circuiting to success on
  // `total === 0` would let such a wipe report clean having asked Vectorize
  // nothing at all — which is precisely the failure the original terminal probe
  // (review finding F3) was added to catch, reintroduced by the change that was
  // supposed to strengthen it. So the probe stays the floor: the ledger says
  // WHICH vectors to delete, the probe says whether any remain.
  let sawLiveVector = false;
  let probeErrored = false;
  let remaining: Awaited<ReturnType<typeof store.probeNamespace>> = [];
  // Stamped BEFORE the call, not after. `clearTenantLedger` clears every row
  // whose delete was submitted at or before this instant, on the strength of
  // this probe — so the instant has to be one the probe's evidence actually
  // covers. A delete submitted by a concurrent purge WHILE the probe was in
  // flight would take a stamp below an after-the-fact sample and be cleared on
  // evidence gathered before that vector's delete was even asked for.
  const probedAtMs = now();
  try {
    remaining = await store.probeNamespace();
  } catch (error) {
    probeErrored = true;
    console.warn(
      JSON.stringify({
        event: "account_wipe_probe_failed",
        tenant_id: tenantId,
        message: error instanceof Error ? error.message : String(error),
        note: "namespace probe gave no answer; falling back to per-id getByIds confirmation",
      }),
    );
  }
  if (!probeErrored && remaining.length === 0) {
    // Empty namespace, so nothing in it can be live and the fast path clears
    // the tenant's confirmed rows in one call (S6 §5.3). `live` rows are left
    // alone by `clearTenantLedger`: a vector nobody has submitted a delete for
    // is not something an empty probe says anything about, and the caller sends
    // such a pass back to the vectors phase anyway.
    const cleared = await clearTenantLedger(db, tenantId, probedAtMs);
    if (cleared > 0) {
      console.info(
        JSON.stringify({
          event: "account_wipe_ledger_cleared",
          tenant_id: tenantId,
          rows_cleared: cleared,
          via: "namespace_probe",
          note: "an empty namespaced query cannot coexist with a live vector in that namespace",
        }),
      );
    }
    // Clear the sticky flag on the way out (defect D1): `probe_saw_residue` set
    // by an earlier attempt must not survive onto the completion record of a
    // wipe that came back clean.
    // Re-read rather than assume the clear emptied the table: a delete
    // submitted after the probe was taken is deliberately left behind, and a
    // wipe with a row left is not finished.
    if ((await countLedgerRows(db, tenantId)).total === 0) {
      progress.probeSawResidue = false;
      return false;
    }
  }
  sawLiveVector = !probeErrored && remaining.length > 0;

  // Rule 3, the per-id fallback. It can only clear rows the ledger knows about,
  // so for an unseeded tenant it finds nothing to do and the pass falls through
  // to the residue alert below — loudly, which is the right outcome.
  if (pending.length > 0) {
    const byId = new Map(pending.map((entry) => [entry.readingId, entry]));
    for (const chunk of chunkForGetByIds(pending.map((entry) => entry.readingId))) {
      let observation: GetByIdsObservation;
      try {
        observation = { ok: true, requested: chunk, present: await store.getByIds(chunk) };
      } catch (error) {
        observation = {
          ok: false,
          requested: chunk,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (observation.ok && observation.present.length > 0) sawLiveVector = true;
      const verdict = applyAbsenceObservation(pending, observation, nowMs);
      await clearLedgerRows(db, tenantId, verdict.clear);
      await resetAbsenceStreaks(db, tenantId, verdict.reset);
      await recordAbsences(db, tenantId, verdict.advanced, nowMs);
      for (const advanced of verdict.advanced) {
        // Keep the in-memory view honest for the rest of this pass. Chunks are
        // disjoint today, so nothing reads it again — but an id observed twice
        // in one pass must not double-count a single instant into a clear.
        const entry = byId.get(advanced.readingId);
        if (entry) {
          entry.absentStreak = advanced.absentStreak;
          entry.lastAbsentAtMs = nowMs;
        }
      }
    }
  }

  // The namespace still answered (or never answered at all), so this pass has
  // not confirmed the wipe however few ledger rows are left. There is
  // deliberately no early return on an empty ledger here: a clean namespace is
  // the only thing that ends a wipe cleanly, and it was checked above.
  const after = await countLedgerRows(db, tenantId);
  // The bound exists to stop a STUCK wipe, not to time-limit a slow one, so a
  // pass that cleared rows does not spend an attempt.
  //
  // Honest about what that does and does not buy: this exemption keeps a
  // progressing wipe off the RESIDUE ALERT, but it does not give it unlimited
  // deliveries. Every confirmation pass still ends in a throw, and throws are
  // bounded by the queue's own `max_retries`. A tenant needing many per-id
  // passes (ACCOUNT_WIPE_CONFIRM_BATCH rows, two spaced absences each) will
  // dead-letter mid-confirmation and be picked up by the next cron tick — slow
  // and noisy, but correct, and it resumes exactly where it stopped because the
  // cleared rows are gone from the ledger. The namespace fast path is what
  // keeps that off the normal road.
  const clearedThisPass = before.total - after.total;
  const attempts = clearedThisPass > 0 ? progress.probeAttempts : progress.probeAttempts + 1;
  // Sticky, but only within a pass that ends dirty: once a call has actually
  // seen a vector, a later transient failure must not downgrade the verdict to
  // "we could not check". Every clean return above clears it (defect D1), so on
  // the completion record the flag is meaningful only alongside `residue = 1`.
  const sawResidue = progress.probeSawResidue || sawLiveVector;
  if (attempts < ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS || clearedThisPass > 0) {
    // Persist before throwing, so both the bound and the verdict survive the
    // retry this throw causes rather than resetting on every redelivery.
    progress.probeAttempts = attempts;
    progress.probeSawResidue = sawResidue;
    await writer.write(progress);
    throw new AccountWipeNamespaceNotEmptyError(
      tenantId,
      after.total,
      attempts,
      confirmBackoffSeconds(attempts),
      !sawResidue,
    );
  }
  progress.probeAttempts = attempts;
  progress.probeSawResidue = sawResidue;
  // Bound exhausted. Alert and let the wipe finish — R2 is already empty and
  // every ledgered id has been submitted, so another 15-minute cycle changes
  // nothing. The ledger rows STAY: they are the only handle left on vectors
  // nobody could confirm gone, and S5's residue scan reads them. `outcome` is
  // what the reader acts on: `residue` means a call genuinely saw vectors still
  // there; `unconfirmed` means no call ever did and we never got a clean
  // answer, which is a Vectorize health question rather than a finding about
  // this account. Both land as `residue = 1` on the completion record;
  // `probe_saw_residue` beside it keeps them apart.
  console.error(
    JSON.stringify({
      severity: "high",
      event: ACCOUNT_WIPE_NAMESPACE_RESIDUE_EVENT,
      tenant_id: tenantId,
      probe_attempts: attempts,
      ledger_rows_remaining: after.total,
      outcome: sawResidue ? "residue" : "unconfirmed",
      note: sawResidue
        ? "vectors still answered after the confirmation bound. Ids this wipe could not confirm " +
          "are retained in vector_ledger and stay addressable — but a vector the ledger cannot " +
          "NAME is not among them: a pre-S3 stranding, or a bare-id vector from an older " +
          "`corpus ingest`/`recover --batch` run under --tenant, is invisible to deleteByIds " +
          "and its row (if any) will have been cleared as absent. Do not read this as healthy: " +
          "see the residual list in src/account-wipe.ts, and slice S5's audit. Wipe completed."
        : "no confirmation call ever came back clean, so the wipe could not be confirmed; " +
          "check Vectorize health. The ledger rows are retained. Wipe completed.",
    }),
  );
  return true;
}

/**
 * Coarse whole-index delta, logged beside the confirmation and read by nothing.
 *
 * Kept, but with its caveat widened (S6 defect D3). The existing note covered
 * asynchronous propagation, which can only make the delta look too small. S6
 * §3.5 measured a second cause the note did not admit: `describe()` is served
 * from replicas at different processing frontiers and its `vectorCount` goes
 * *backwards* between samples seconds apart, so the delta can also be falsely
 * positive, or negative, or zero on a wipe that deleted everything — the drill
 * logged `delta 0` while four vectors were genuinely in flight.
 *
 * It survives the rewrite rather than being dropped because it is the only
 * whole-index signal in the wipe and it costs one call, and because the real
 * termination signal is now the ledger rather than this number. It is a
 * breadcrumb for an operator reading a log after the fact, and the note now
 * says plainly that no reading of it means anything on its own.
 */
function logVectorCountDelta(
  progress: WipeProgress,
  tenantId: TenantId,
  countEnd: number | null,
): void {
  const countStart = progress.indexCountStart;
  const delta = countStart !== null && countEnd !== null ? countStart - countEnd : null;
  console.info(
    JSON.stringify({
      event: "account_wipe_vector_count_delta",
      tenant_id: tenantId,
      index_count_start: countStart,
      index_count_end: countEnd,
      delta,
      submitted_batches: progress.mutationIds.length,
      note:
        "whole-index count, not per-namespace, and NOT a signal. Two independent reasons it can " +
        "read wrong: Vectorize deletes propagate asynchronously, and describe() is served from " +
        "replicas at different processing frontiers whose counts move backwards between samples " +
        "(measured, report rl-195-s6-staging-gate §3.5). Any delta — positive, zero or negative — " +
        "is consistent with a clean wipe. The termination signal is vector_ledger.",
    }),
  );
}
