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
 * **Fail closed on an unbound index.** With no `READINGS_INDEX` the vectors
 * phase throws (`index_unbound`) rather than advancing to R2. The check runs
 * *before* the "no ids to delete" short-circuit: an empty id set means "R2
 * yielded no ids", which is also what an already-emptied prefix looks like.
 *
 * **A wipe never reports success without addressing the index.** Before the
 * terminal transition it probes the tenant namespace and refuses to finish
 * while anything still answers, retrying on a minutes-scale delay because
 * `deleteByIds` propagates asynchronously. The retries are bounded
 * (`ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS`); past the bound it raises a
 * high-severity `account_wipe_namespace_residue` alert carrying the tenant id
 * and nothing else, and completes rather than looping a doomed job through the
 * DLQ every 15 minutes.
 *
 * **The gate is a kill switch, not a fallback.** With `TENANT_DATA_PLANE` off
 * (or an empty key root) both fan-out and job skip with `no_tenant_prefix`.
 * They never fall back to the pre-tenant global layout — an empty key root must
 * not be read as "wipe the bucket".
 *
 * **One writer at a time.** Progress writes are compare-and-set on the etag we
 * last read or wrote (the `index/list.json` idiom from
 * `src/modules/stores/list-index.ts`). A losing sibling fails loudly and
 * retries instead of clobbering the winner's cursor. The consumer runs at
 * `max_concurrency = 1`, so the CAS is a backstop against at-least-once
 * redelivery rather than the primary serialization.
 *
 * **Progress does not outlive the wipe.** `wipe/{tenantId}/progress.json` names
 * a deleted tenant, so the terminal transition CAS-writes `done` and then
 * DELETES the record rather than leaving a `phase:"done"` object behind. R2 has
 * no conditional delete; the CAS-write immediately before is what proves the
 * object being deleted is still ours.
 *
 * **Grace gates only the start.** `deleting_at_ms` + 7 days gates starting a
 * *new* wipe. Resume (in-progress, leftover objects, expired lease) proceeds
 * during grace, and `force` recorded on the progress record survives a DLQ so a
 * forced wipe is redriven without waiting out the 7 days.
 *
 * **Resumability is stateless beyond a cursor.** Reading ids are re-derived
 * from R2 on every pass rather than persisted; the progress record carries only
 * phase, offsets, the R2 cursor, and lease/probe bookkeeping. R2 is not
 * modified during the vectors phase, so the id list is stable across a
 * continuation and `vector_offset` keeps its meaning.
 *
 * ## The race this does not close
 *
 * A vector whose reading id is no longer derivable from R2 is unaddressable:
 * `deleteByIds` needs an id and there is nothing left to compute one from.
 * `processReading` closes the live half of this at the publisher — a consumer
 * that publishes against a tenant confirmed `deleting` deletes its own vector
 * directly (`ReadingVisibility.removeForDeletedTenant`) instead of waiting for
 * a wipe that has already collected its ids. What remains is a vector that was
 * already stranded before the wipe began (review finding F3): the terminal
 * probe can sample for it, but nothing can delete it. Closing that needs a
 * durable per-tenant vector-id ledger — issue #261, out of scope here.
 *
 * A second, accepted consequence of deleting the progress record: fan-out skips
 * a tenant with no record AND an empty prefix, because that pair is what an
 * already-wiped tenant looks like and `users.status` stays `deleting` until the
 * hard-delete. So a tenant with an empty prefix and stranded vectors is never
 * swept again — which changes nothing, since such a sweep would have no ids to
 * work with either.
 *
 * ## Mechanics worth knowing
 *
 * R2 `list()`/`delete()` cap at 1000 objects, so the prefix is paged with a
 * cursor stored on the progress record. Vectorize `deleteByIds` is async
 * (a mutationId, no immediate confirm) and is fired in ≤1000-id batches; we
 * record what it returns and never poll. The job heartbeats
 * `progress.updated_at_ms` from a live clock during the id collect and each
 * R2/vector page — not once at consume-start — so a long pass cannot expire the
 * 15-minute lease at the every-15-minute cron boundary. A delayed `msg.retry`
 * advances the lease from failure time by `delaySeconds` for the same reason.
 */
import { z } from "zod";
import { fromD1, type ControlPlaneDb } from "./control-plane/db";
import { parseTenantId, type TenantId } from "./control-plane/ids";
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

export const ACCOUNT_WIPE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Lost-message recovery window: one 15-minute cron interval, equal
 * to the in-flight lease and longer than the default exponential retry cap
 * (5 min). Jobs heartbeat `progress.updated_at_ms` from current time during
 * collect and each R2/vector page so a long collect cannot expire at that
 * boundary. Retry-After can delay the same message up to 12h
 * (`ACCOUNT_WIPE_RETRY_MAX_DELAY_SECONDS`); consume advances
 * `progress.updated_at_ms` from failure time by `delaySeconds` so cron does
 * not enqueue a sibling while that retry is still owed.
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
 * header's note on unaddressable vectors), so the wipe alerts an operator and
 * completes rather than failing in a loop.
 */
export const ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS = 3;
/** Operator alert: the namespace still answered after the probe bound. */
export const ACCOUNT_WIPE_NAMESPACE_RESIDUE_EVENT = "account_wipe_namespace_residue";
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

// Unknown keys are stripped, so a record written before the sweep phase was
// removed still parses; only a stored `phase:"sweep"` does not. That record
// reads as unparseable, which the fan-out and job paths already handle by
// CAS-claiming the etag and restarting the wipe from `vectors` — idempotent, and
// only reachable inside one deploy window.
const AccountWipeProgressSchema = z.object({
  version: z.literal(1),
  phase: z.enum(["vectors", "objects", "done"]),
  vector_offset: z.number().int().nonnegative(),
  r2_cursor: z.string().min(1).optional(),
  mutation_ids: z.array(z.string()),
  objects_deleted: z.number().int().nonnegative(),
  updated_at_ms: z.number().int().nonnegative(),
  // Optional so pre-force progress still parses; new writes always persist it.
  force: z.boolean().optional(),
  // Whole-index vector count sampled when this wipe started, for the terminal
  // delta log. Optional: absent on pre-existing progress and when the binding
  // has no describe().
  index_count_start: z.number().int().nonnegative().nullable().optional(),
  // Terminal probes that have failed to confirm this wipe, so the bound
  // survives the retry each failure causes. Counts hits and errors alike: the
  // bound is a total waiting budget, and waiting costs the same whichever
  // reason kept us from confirming.
  probe_attempts: z.number().int().nonnegative().optional(),
  // Sticky, set the moment any probe actually returns a vector. Without it the
  // final verdict comes from the LAST attempt alone, so two probes seeing real
  // residue followed by one transient error would report "unconfirmed — check
  // Vectorize health" and bury a finding already observed twice.
  probe_saw_residue: z.boolean().optional(),
});
type AccountWipeProgress = z.infer<typeof AccountWipeProgressSchema>;

export interface AccountWipeEnv {
  CONTROL_PLANE: D1Database;
  READINGS_BUCKET: R2Bucket;
  READINGS_INDEX?: VectorizeIndex;
  ACCOUNT_WIPE_JOBS?: Queue<AccountWipeEnvelopeV1>;
  TENANT_DATA_PLANE?: string;
}

export interface AccountWipeJobDeps {
  /** Consume-start clock; used for the grace gate only. */
  nowMs: number;
  /**
   * Live clock for lease heartbeats and retry-lease. Defaults to Date.now
   * so production heartbeats even when the queue handler passes a frozen
   * consume-start `nowMs`.
   */
  now?: () => number;
  maxObjectPages?: number;
  maxVectorBatches?: number;
}

function wipeJobNow(deps: AccountWipeJobDeps): number {
  return deps.now ? deps.now() : Date.now();
}

/** A sibling job owns this wipe: our conditional progress write lost. */
export class AccountWipeProgressConflictError extends Error {
  constructor(public readonly tenantId: string) {
    super(`account_wipe progress_conflict for ${tenantId}`);
    this.name = "AccountWipeProgressConflictError";
  }
}

/**
 * A conditional progress write succeeded but returned no etag to chain from.
 * Deliberately NOT a conflict: our write landed and our lease is still ours, so
 * the retry path must still extend it.
 */
export class AccountWipeProgressUnchainableError extends Error {
  constructor(public readonly tenantId: string) {
    super(`account_wipe progress_unchainable for ${tenantId}: R2 put returned no etag`);
    this.name = "AccountWipeProgressUnchainableError";
  }
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

export type AccountWipeSkipReason =
  | "grace_period"
  | "not_deleting"
  | "not_found"
  | "no_tenant_prefix";

export type AccountWipeResult =
  | { kind: "skipped"; reason: AccountWipeSkipReason }
  | {
      kind: "continue";
      objects_deleted: number;
      mutation_ids: string[];
      r2_cursor?: string;
    }
  | { kind: "complete"; objects_deleted: number; mutation_ids: string[] };

export function isAccountWipeQueue(name: string): boolean {
  return (ACCOUNT_WIPE_QUEUE_NAMES as readonly string[]).includes(name);
}

export function isAccountWipeDlq(name: string): boolean {
  return (ACCOUNT_WIPE_DLQ_NAMES as readonly string[]).includes(name);
}

export function accountWipeProgressKey(tenantId: string): string {
  const parsed = parseTenantId(tenantId);
  if (!parsed) throw new Error("malformed tenant id");
  return `wipe/${parsed}/progress.json`;
}

export function wipeGraceElapsed(deletingAtMs: number | null | undefined, nowMs: number): boolean {
  if (deletingAtMs == null) return false;
  return nowMs - deletingAtMs >= ACCOUNT_WIPE_GRACE_MS;
}

/** Incomplete or leftover progress is a resume, not a new wipe. */
export function wipeNeedsResume(
  progress: { phase: "vectors" | "objects" | "done" } | null,
  hasLeftoverObjects: boolean,
): boolean {
  if (!progress) return false;
  return progress.phase !== "done" || hasLeftoverObjects;
}

/** True while cron must not enqueue a sibling (includes a future retry-lease). */
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
  // tenant prefix to wipe. Do not write progress or enqueue — the job would
  // skip at no_tenant_prefix before the lease write, and cron would retry forever.
  if (!tenantDataPlaneEnabled(env)) {
    console.warn(JSON.stringify({ event: "account_wipe_fanout_skipped", reason: "no_tenant_prefix" }));
    return { enqueued: 0 };
  }
  const db = fromD1(env.CONTROL_PLANE);
  const rows = await listDeletingUsers(db);
  let enqueued = 0;
  for (const row of rows) {
    try {
      const tenantId = parseTenantId(row.id);
      if (!tenantId) continue;
      const record = await readProgressRecord(env.READINGS_BUCKET, tenantId);
      const progress = record.progress;
      const leftover =
        progress?.phase === "done"
          ? await tenantPrefixHasObjects(env.READINGS_BUCKET, tenantId, env)
          : false;
      if (!wipeNeedsResume(progress, leftover)) {
        // New wipe (no progress) or cleanly done-and-empty: grace gates start.
        if (record.etag !== null) {
          // Some object is sitting at this tenant's progress key with the wipe
          // finished and the prefix empty. Either an earlier run's terminal
          // delete did not land, or the body no longer parses (schema drift, a
          // partial write) — `readProgressRecord` returns a null progress with
          // a live etag for that case. Nothing else will ever clear either one:
          // this branch is the only place cron looks at such a tenant and it
          // used to `continue`, so once redelivery stopped, the object naming
          // the deleted tenant and listing their reading ids was permanent.
          //
          // Both are safe to delete here. A parseable `done` record has no
          // resume value left, and an unparseable one never had any.
          //
          // CAS before removing in BOTH cases — R2 has no conditional delete,
          // so the write is the only thing proving the object we are about to
          // delete is still the one we read. Skipping it for the unparseable
          // case (because there was no record to write back) would leave that
          // branch deleting blind: a job enqueued by a later tick could have
          // written a valid record in between, and we would drop its live lease
          // and cursor. An unparseable body has nothing worth preserving, so
          // write a terminal record over it purely to claim the etag.
          const stale = new WipeProgressWriter(env.READINGS_BUCKET, tenantId, record.etag);
          await stale.write(progress ?? { ...emptyProgress(deps.nowMs), phase: "done" });
          await stale.remove();
          continue;
        }
        if (!wipeGraceElapsed(row.deleting_at_ms, deps.nowMs)) continue;
        // No progress record AND nothing under the tenant prefix. Since the
        // terminal transition deletes the record, that pair is what an
        // already-wiped tenant looks like — and `users.status` stays 'deleting'
        // until the PR2 hard-delete, so without this the tenant is a permanent
        // cron candidate: every 15 minutes forever we would start a fresh wipe
        // and re-create `wipe/{tenantId}/progress.json`, the tenant-naming
        // object the terminal delete exists to remove.
        //
        // Known gap, accepted deliberately: a tenant whose R2 prefix is empty
        // but whose namespace still holds vectors is never swept again. R2 is
        // the only source of the reading ids `deleteByIds` needs, so such a
        // sweep could not address them anyway — the durable vector ledger
        // (issue #261, 195b move 2) is what closes it. Documented in
        // docs/operations.md.
        if (!(await tenantPrefixHasObjects(env.READINGS_BUCKET, tenantId, env))) {
          continue;
        }
      } else if (
        progress &&
        progress.phase !== "done" &&
        wipeLeaseHeld(progress.updated_at_ms, deps.nowMs)
      ) {
        continue;
      }
      // Touch before send so the in-flight skip is real for the next cron tick
      // and so leftover `done` recovery does not immediately re-enqueue.
      // Resume preserves force from progress so a force wipe that DLQ'd during
      // grace is redriven with force:true; new starts persist force:false.
      const force = progress?.force === true;
      let next: AccountWipeProgress = progress ?? emptyProgress(deps.nowMs, force);
      if (next.phase === "done") {
        next = reopenLeftoverProgress(next);
      }
      next.force = force;
      next.updated_at_ms = deps.nowMs;
      // CAS on what we just read: if a job claimed this tenant between the read
      // and here, the write loses and this user is skipped for the tick rather
      // than having its cursor overwritten by a fan-out that never ran it.
      await new WipeProgressWriter(env.READINGS_BUCKET, tenantId, record.etag).write(next);
      await queue.send(accountWipeEnvelopeV1({ tenantId, force }));
      enqueued += 1;
    } catch (error) {
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
  const tenantId = parseTenantId(envelope.tenantId);
  if (!tenantId) return { kind: "skipped", reason: "not_found" };

  const db = fromD1(env.CONTROL_PLANE);
  const user = await db.first<{ status: string; deleting_at_ms: number | null }>(
    "SELECT status, deleting_at_ms FROM users WHERE id = ?",
    tenantId,
  );
  if (!user) return { kind: "skipped", reason: "not_found" };
  if (user.status !== "deleting") return { kind: "skipped", reason: "not_deleting" };

  if (!tenantDataPlaneEnabled(env)) {
    return { kind: "skipped", reason: "no_tenant_prefix" };
  }
  const keyRoot = tenantKeyRoot({ tenantId }, true);
  if (keyRoot === "") return { kind: "skipped", reason: "no_tenant_prefix" };

  const layout = r2KeyLayout(keyRoot);
  const maxObjectPages = deps.maxObjectPages ?? ACCOUNT_WIPE_DEFAULT_OBJECT_PAGES;
  const maxVectorBatches = deps.maxVectorBatches ?? ACCOUNT_WIPE_DEFAULT_VECTOR_BATCHES;

  const record = await readProgressRecord(env.READINGS_BUCKET, tenantId);
  const stored = record.progress;
  const leftover =
    stored?.phase === "done" ? await prefixHasObjects(env.READINGS_BUCKET, keyRoot) : false;
  const resuming = wipeNeedsResume(stored, leftover);
  const force = envelope.force || stored?.force === true;
  // Grace only gates starting a new wipe. Resume (in-progress, leftover, expired
  // lease) proceeds even during grace; force:true still starts during grace.
  if (!force && !wipeGraceElapsed(user.deleting_at_ms, deps.nowMs) && !resuming) {
    return { kind: "skipped", reason: "grace_period" };
  }

  const now = () => wipeJobNow(deps);
  let progress = stored ?? emptyProgress(now(), force);
  progress.force = force;
  if (progress.phase === "done") {
    if (!leftover) {
      // A stored `done` record means a previous run's terminal delete did not
      // land (R2 error, or the isolate died between the write and the delete).
      // Finish that job here rather than returning complete and leaving it:
      // otherwise fan-out's `if (progress) continue` skips this tenant forever
      // and the object naming them, listing their reading ids, is permanent —
      // precisely the leak the terminal delete exists to prevent.
      //
      // CAS-write before removing, exactly as the terminal path does. R2 has no
      // conditional delete, so the write is what proves the record we read is
      // still the current one; without it a delivery racing a concurrent lease
      // extend or sibling would delete state written after our read.
      const doneWriter = new WipeProgressWriter(env.READINGS_BUCKET, tenantId, record.etag);
      await doneWriter.write(progress);
      await doneWriter.remove();
      return { kind: "complete", objects_deleted: progress.objects_deleted, mutation_ids: progress.mutation_ids };
    }
    // Union stored reading ids with an R2 re-list, then Vectorize-delete
    // before touching R2. Jumping to objects would empty the prefix and
    // leave missed/late vectors behind.
    progress = reopenLeftoverProgress(progress);
  }
  const writer = new WipeProgressWriter(env.READINGS_BUCKET, tenantId, record.etag);
  const heartbeat = async () => {
    progress.updated_at_ms = now();
    await writer.write(progress);
  };
  // Baseline for the terminal delta log, taken once per wipe before anything is
  // submitted. Best-effort: null when the binding has no describe().
  if (progress.index_count_start === undefined && env.READINGS_INDEX) {
    progress.index_count_start = await similarityStoreFor(
      env.READINGS_INDEX,
      { tenantId },
      env,
    ).indexVectorCount();
  }
  // Persist before any listing so a concurrent cron tick sees an in-flight lease
  // instead of launching a sibling job against the same prefix. Record force so
  // cron resume can honor a force wipe that DLQ'd during grace. Heartbeats
  // refresh this timestamp from current time during collect and pages.
  await heartbeat();

  if (progress.phase === "vectors") {
    // Re-derived from R2 on every pass rather than persisted. R2 is untouched
    // until the objects phase, so this list is stable across a continuation and
    // `vector_offset` keeps its meaning between deliveries.
    const ids = await collectReadingIds(env.READINGS_BUCKET, layout, heartbeat);
    await heartbeat();
    const vec = await submitVectorDeletes(progress, ids, env, tenantId, now, maxVectorBatches, writer);
    if (vec === "continue") {
      return {
        kind: "continue",
        objects_deleted: progress.objects_deleted,
        mutation_ids: progress.mutation_ids,
      };
    }
    progress.phase = "objects";
    await heartbeat();
  }

  if (progress.phase === "objects") {
    let pages = 0;
    let cursor = progress.r2_cursor;
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
          progress.r2_cursor = undefined;
          await heartbeat();
          if (pages >= maxObjectPages) {
            return {
              kind: "continue",
              objects_deleted: progress.objects_deleted,
              mutation_ids: progress.mutation_ids,
              r2_cursor: undefined,
            };
          }
          continue;
        }
        progress.r2_cursor = undefined;
        await heartbeat();
        break objects;
      }
      progress.objects_deleted += list.objects.length;
      pages += 1;
      cursor = list.truncated ? list.cursor : undefined;
      progress.r2_cursor = cursor;
      await heartbeat();
      await env.READINGS_BUCKET.delete(list.objects.map((obj) => obj.key));
      if (!cursor) {
        const again = await env.READINGS_BUCKET.list({ prefix: keyRoot, limit: 1 });
        if (again.objects.length === 0) {
          progress.r2_cursor = undefined;
          await heartbeat();
          break objects;
        }
        cursor = undefined;
        progress.r2_cursor = undefined;
      }
      if (pages >= maxObjectPages) {
        return {
          kind: "continue",
          objects_deleted: progress.objects_deleted,
          mutation_ids: progress.mutation_ids,
          r2_cursor: progress.r2_cursor,
        };
      }
    }
  }

  // Both phases are done — the objects loop only falls through here once the
  // prefix is confirmed empty; every partial pass returned `continue` above.
  //
  // Terminal assurance before we are allowed to claim success (F3). The probe
  // throws while the namespace still answers, so an unbound index, a
  // never-submitted delete, or a delete that did not take leaves the job
  // retrying instead of reporting a wipe that removed nothing.
  await assertNamespaceEmptied(progress, env, tenantId, writer);
  progress = {
    ...progress,
    phase: "done",
    r2_cursor: undefined,
    updated_at_ms: now(),
  };
  // CAS-write `done` first: it is the proof we still own this wipe, and R2 has
  // no conditional delete. A sibling that took over fails this write, so it
  // cannot have its live progress deleted out from under it by our remove().
  await writer.write(progress);
  await writer.remove();
  return {
    kind: "complete",
    objects_deleted: progress.objects_deleted,
    mutation_ids: progress.mutation_ids,
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
    try {
      // A progress conflict means a SIBLING owns this wipe and the record we
      // would extend is theirs, not ours. Writing it would bump the etag their
      // WipeProgressWriter is holding, so their next heartbeat would conflict
      // and abort too — the loser taking the winner down with it. Retry the
      // message without touching their lease; theirs is already live.
      if (!(error instanceof AccountWipeProgressConflictError)) {
        await extendWipeLeaseForRetry(env, parsed.envelope.tenantId, wipeJobNow(deps), delaySeconds);
      }
    } catch (leaseError) {
      console.error(
        JSON.stringify({
          event: "account_wipe_lease_extend_failed",
          tenant_id: parsed.envelope.tenantId,
          message: leaseError instanceof Error ? leaseError.message : String(leaseError),
        }),
      );
    }
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

function reopenLeftoverProgress(progress: AccountWipeProgress): AccountWipeProgress {
  return {
    ...progress,
    phase: "vectors",
    vector_offset: 0,
    r2_cursor: undefined,
    // Reopening is a fresh pass that will submit fresh deletes, so its probe
    // budget and count baseline must be fresh too. Carrying them over meant a
    // reopen that inherited a used-up `probe_attempts` tripped the bound on its
    // very first probe — declaring residue and alerting before the deletes it
    // had just submitted were given any time to propagate.
    probe_attempts: 0,
    probe_saw_residue: undefined,
    index_count_start: undefined,
  };
}

async function submitVectorDeletes(
  progress: AccountWipeProgress,
  ids: string[],
  env: AccountWipeEnv,
  tenantId: TenantId,
  now: () => number,
  maxVectorBatches: number,
  writer: WipeProgressWriter,
): Promise<"continue" | "done"> {
  // Fail closed BEFORE the emptiness test (F3). An empty id list means "R2
  // yielded no ids", not "this tenant has no vectors" — R2 is the only id
  // source and it may already be gone. Returning "done" here on an unbound
  // index let the wipe advance to the objects phase and report success without
  // ever addressing the index.
  if (!env.READINGS_INDEX) {
    throw new Error("account_wipe index_unbound");
  }
  if (progress.vector_offset >= ids.length) return "done";
  const store = similarityStoreFor(env.READINGS_INDEX, { tenantId }, env);
  let batches = 0;
  while (progress.vector_offset < ids.length && batches < maxVectorBatches) {
    const chunk = ids.slice(progress.vector_offset, progress.vector_offset + VECTORIZE_DELETE_MAX_IDS);
    const mutations = await store.deleteMany(chunk);
    for (const mutationId of mutations) {
      progress.mutation_ids.push(mutationId);
      console.info(
        JSON.stringify({
          event: "account_wipe_vector_delete_submitted",
          tenant_id: tenantId,
          mutation_id: mutationId,
          note: "Vectorize deletes are async; embeddings may take a short time to disappear",
        }),
      );
    }
    progress.vector_offset += chunk.length;
    progress.updated_at_ms = now();
    await writer.write(progress);
    batches += 1;
  }
  return progress.vector_offset < ids.length ? "continue" : "done";
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
 * possible, so the bound converts the gate into a high-severity operator alert
 * and lets the wipe finish. The alert carries the tenant id and nothing else:
 * an alert about a deleted account must not re-publish that account's reading
 * ids to the log.
 *
 * The `describe()` delta is logged beside it as coarse corroboration. It counts
 * the whole index rather than one namespace and Vectorize deletes are async, so
 * it is never a gate — a zero delta after submitting ids is a signal for an
 * operator, not grounds to fail the job.
 */
async function assertNamespaceEmptied(
  progress: AccountWipeProgress,
  env: AccountWipeEnv,
  tenantId: TenantId,
  writer: WipeProgressWriter,
): Promise<void> {
  if (!env.READINGS_INDEX) {
    throw new Error("account_wipe index_unbound");
  }
  const store = similarityStoreFor(env.READINGS_INDEX, { tenantId }, env);
  const countEnd = await store.indexVectorCount();
  const countStart = progress.index_count_start ?? null;
  const submitted = progress.mutation_ids.length;
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
  if (!probeErrored && remaining.length === 0) return;

  const attempts = (progress.probe_attempts ?? 0) + 1;
  // Sticky across attempts: once a probe has actually seen a vector, a later
  // transient error must not downgrade the verdict to "we could not check".
  const sawResidue = progress.probe_saw_residue === true || remaining.length > 0;
  if (attempts < ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS) {
    // Persist before throwing, so both the bound and the verdict survive the
    // retry this throw causes rather than resetting on every redelivery.
    progress.probe_attempts = attempts;
    progress.probe_saw_residue = sawResidue;
    await writer.write(progress);
    throw new AccountWipeNamespaceNotEmptyError(
      tenantId,
      remaining.length,
      attempts,
      probeErrored,
    );
  }
  // Bound exhausted. Alert and let the wipe finish — R2 is already empty and
  // every id we could derive has been submitted, so another 15-minute cycle
  // changes nothing. `outcome` is what the reader acts on: `residue` means some
  // probe genuinely saw vectors still there; `unconfirmed` means no probe ever
  // did and we never got a clean answer, which is a Vectorize health question
  // rather than a finding about this account.
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
}

async function extendWipeLeaseForRetry(
  env: AccountWipeEnv,
  tenantId: string,
  nowMs: number,
  delaySeconds: number,
): Promise<void> {
  // `nowMs` is failure time (when retry is requested), not consume-start.
  const parsed = parseTenantId(tenantId);
  if (!parsed) return;
  const record = await readProgressRecord(env.READINGS_BUCKET, parsed);
  if (!record.progress) return;
  // CAS on what we just read. If the wipe that failed was already superseded —
  // or completed and deleted its progress — this write loses and the caller
  // logs it, rather than resurrecting a record the owner is done with.
  await new WipeProgressWriter(env.READINGS_BUCKET, parsed, record.etag).write({
    ...record.progress,
    updated_at_ms: nowMs + delaySeconds * 1000,
  });
}

function emptyProgress(nowMs: number, force = false): AccountWipeProgress {
  return {
    version: 1,
    phase: "vectors",
    vector_offset: 0,
    mutation_ids: [],
    objects_deleted: 0,
    updated_at_ms: nowMs,
    force,
  };
}

interface ProgressRecord {
  progress: AccountWipeProgress | null;
  /** etag of the object we read; null when it was absent. */
  etag: string | null;
}

async function readProgressRecord(
  bucket: R2Bucket,
  tenantId: TenantId,
): Promise<ProgressRecord> {
  const obj = await bucket.get(accountWipeProgressKey(tenantId));
  if (!obj) return { progress: null, etag: null };
  try {
    const parsed = AccountWipeProgressSchema.safeParse(JSON.parse(await obj.text()));
    // An unparseable body is not a resume point, but it IS an object: keep its
    // etag so our first write replaces exactly what we read rather than racing.
    return { progress: parsed.success ? parsed.data : null, etag: obj.etag };
  } catch {
    return { progress: null, etag: obj.etag };
  }
}

/**
 * Compare-and-set writer for one tenant's `progress.json`, lifted from the
 * `index/list.json` idiom in `src/modules/stores/list-index.ts`: the put is
 * conditional on the etag we last read or wrote (`If-None-Match: *` when we
 * believe the object is absent). The consumer runs at `max_concurrency = 1`,
 * but at-least-once delivery can still put two deliveries of one tenant in
 * flight; without this the loser last-write-wins the winner's cursor and phase
 * (review finding F8).
 *
 * Unlike the list index we do NOT re-read and re-apply on conflict. A conflict
 * here means another job owns this wipe, and the right answer is to stop: the
 * error propagates to `consumeAccountWipeMessage`, which retries the message
 * after the owner has moved on. Re-applying would be the clobber we are
 * preventing.
 */
class WipeProgressWriter {
  private etag: string | null;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly tenantId: TenantId,
    initialEtag: string | null,
  ) {
    this.etag = initialEtag;
  }

  async write(progress: AccountWipeProgress): Promise<void> {
    const onlyIf: R2PutOptions["onlyIf"] =
      this.etag === null
        ? new Headers({ "If-None-Match": "*" })
        : { etagMatches: this.etag };
    const res = await this.bucket.put(
      accountWipeProgressKey(this.tenantId),
      JSON.stringify(progress),
      { httpMetadata: { contentType: "application/json" }, onlyIf },
    );
    if (res === null) throw new AccountWipeProgressConflictError(this.tenantId);
    // A put result with no etag would silently degrade every later write to
    // `{ etagMatches: undefined }` — an unconditional put, i.e. the
    // last-write-wins clobber this class exists to prevent, with no signal that
    // the guard has stopped guarding. Fail instead of writing blind.
    // Distinct from a conflict on purpose. This write LANDED — we merely lost
    // the etag to chain from. consumeAccountWipeMessage suppresses the lease
    // extend for a real conflict (a sibling owns the record, so touching it
    // would clobber theirs); doing that here would leave our own lease
    // un-extended and let cron enqueue a sibling against a wipe still owed a
    // retry. Fail closed rather than write blind, but as its own condition.
    if (typeof res.etag !== "string" || res.etag === "") {
      throw new AccountWipeProgressUnchainableError(this.tenantId);
    }
    this.etag = res.etag;
  }

  /**
   * Terminal delete (review finding F4). The progress object carries the
   * deleted tenant id in its key and their full reading-id list in its body, so
   * it must not outlive the wipe. R2 has no conditional delete; the caller
   * therefore CAS-writes the `done` state immediately before calling this, so a
   * sibling that has taken the wipe over fails that write and never reaches
   * here. A missing progress object is already the "no wipe started" state
   * (`readProgress` → null, `wipeNeedsResume(null, …)` → false), and leftover
   * recovery re-derives everything from an R2 re-list, so nothing downstream
   * depends on the `done` record surviving.
   */
  async remove(): Promise<void> {
    await this.bucket.delete(accountWipeProgressKey(this.tenantId));
    this.etag = null;
  }
}

async function collectReadingIds(
  bucket: R2Bucket,
  layout: ReturnType<typeof r2KeyLayout>,
  heartbeat?: () => Promise<void>,
): Promise<string[]> {
  // Still scans both prefixes to completion in this job (large-tenant paging
  // residual). Heartbeats after list.json and each inner list page so a long
  // collect cannot expire the lease at the */15 cron boundary.
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
