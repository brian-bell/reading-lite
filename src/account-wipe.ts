/**
 * Deferred tenant R2 + Vectorize wipe (issue 195b / s1k.10.1 PR1).
 *
 * Accounts already marked `users.status='deleting'` by 195a stay fenced.
 * This module does not hard-delete the users row, tear down Durable Objects,
 * cascade D1, or decide email reuse — those are PR2. DELETE /api/account
 * stays the suppress path; wipe is a shared-queue job plus the existing
 * 15-minute cron sweep, not an inline handler.
 *
 * Grace: honor `deleting_at_ms`. Default N=7 days. Grace only gates *starting*
 * a new wipe (no `progress.json`, or a cleanly done empty prefix). A job
 * payload `{ force: true }` skips grace to start (no ops CLI in this PR).
 * Cron resumes in-progress or leftover wipes even during grace, and preserves
 * `force` recorded on `progress.json` so a force job that DLQ'd during grace
 * is redriven without waiting 7 days. Do not start a brand-new wipe during
 * grace with `force: false`.
 *
 * Vectorize `deleteByIds` is async (mutationId, no immediate confirm).
 * Embeddings may take a short time to disappear. We fire deletes in ≤1000
 * id batches, record whatever the API returns, and do not poll the index
 * as if it were synchronously empty. Vectors are submitted before any R2
 * delete so ids cannot dangle after the prefix is gone. Collected reading ids
 * are persisted on `progress.json`. After the prefix is empty we re-submit
 * `deleteByIds` for those stored ids (async, no wait) so a `processReading`
 * that already passed its tenant check cannot leave a late upsert behind once
 * `index/list.json` is gone. Leftover recovery unions stored ids with an R2
 * re-list. Brand-new intake stays 195a-fenced — this is not a publisher drain.
 * If `READINGS_INDEX` is unbound while reading ids remain, the job throws
 * (`index_unbound`) instead of skipping to R2 — wiping the prefix would strand
 * namespaced embeddings and delete the only ID source leftover recovery can
 * rescan.
 *
 * R2 `list()`/`delete()` cap at 1000 objects. Wipe pages the tenant prefix
 * from `tenantKeyRoot` (production `u/{tenantId}/`). An empty prefix is a
 * no-op success. Continuation cursors live at `wipe/{tenantId}/progress.json`
 * outside the tenant prefix so a crash mid-page resumes. A second run on an
 * already-wiped prefix is a no-op success. Leftover recovery (`phase=done`
 * with objects still under the tenant prefix) resets to `vectors` at
 * `vector_offset=0`, unions stored `reading_ids` with an R2 re-list, and
 * re-submits those ids to `deleteByIds` after R2 is emptied.
 *
 * When TENANT_DATA_PLANE is off, `tenantKeyRoot` is empty (pre-tenant global
 * layout). Prefix wipe refuses that root rather than emptying the bucket.
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
 * Lost-message recovery window: one 15-minute cron interval, and longer than
 * the default exponential retry cap (5 min). Retry-After can delay the same
 * message up to 12h (`ACCOUNT_WIPE_RETRY_MAX_DELAY_SECONDS`); consume
 * advances `progress.updated_at_ms` by `delaySeconds` so cron does not
 * enqueue a sibling while that retry is still owed.
 */
export const ACCOUNT_WIPE_IN_FLIGHT_MS = 15 * 60_000;
/** Cloudflare Queues cap on `msg.retry({ delaySeconds })`. */
export const ACCOUNT_WIPE_RETRY_MAX_DELAY_SECONDS = 43_200;
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

const AccountWipeProgressSchema = z.object({
  version: z.literal(1),
  phase: z.enum(["vectors", "objects", "sweep", "done"]),
  vector_offset: z.number().int().nonnegative(),
  r2_cursor: z.string().min(1).optional(),
  mutation_ids: z.array(z.string()),
  objects_deleted: z.number().int().nonnegative(),
  updated_at_ms: z.number().int().nonnegative(),
  // Optional so pre-force progress still parses; new writes always persist it.
  force: z.boolean().optional(),
  // Collected reading ids survive R2 deletion so a late vector upsert of a
  // known id can still be deleteByIds'd after the prefix is empty.
  reading_ids: z.array(z.string()).optional(),
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
  nowMs: number;
  maxObjectPages?: number;
  maxVectorBatches?: number;
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
  progress: { phase: "vectors" | "objects" | "sweep" | "done" } | null,
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
      const progress = await readProgress(env.READINGS_BUCKET, tenantId);
      const leftover =
        progress?.phase === "done"
          ? await tenantPrefixHasObjects(env.READINGS_BUCKET, tenantId, env)
          : false;
      if (!wipeNeedsResume(progress, leftover)) {
        // New wipe (no progress) or cleanly done-and-empty: grace gates start.
        if (progress) continue;
        if (!wipeGraceElapsed(row.deleting_at_ms, deps.nowMs)) continue;
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
      await writeProgress(env.READINGS_BUCKET, tenantId, next);
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

  const stored = await readProgress(env.READINGS_BUCKET, tenantId);
  const leftover =
    stored?.phase === "done" ? await prefixHasObjects(env.READINGS_BUCKET, keyRoot) : false;
  const resuming = wipeNeedsResume(stored, leftover);
  const force = envelope.force || stored?.force === true;
  // Grace only gates starting a new wipe. Resume (in-progress, leftover, expired
  // lease) proceeds even during grace; force:true still starts during grace.
  if (!force && !wipeGraceElapsed(user.deleting_at_ms, deps.nowMs) && !resuming) {
    return { kind: "skipped", reason: "grace_period" };
  }

  let progress = stored ?? emptyProgress(deps.nowMs, force);
  progress.force = force;
  if (progress.phase === "done") {
    if (!leftover) {
      return { kind: "complete", objects_deleted: progress.objects_deleted, mutation_ids: progress.mutation_ids };
    }
    // Union stored reading ids with an R2 re-list, then Vectorize-delete
    // before touching R2. Jumping to objects would empty the prefix and
    // leave missed/late vectors behind.
    progress = reopenLeftoverProgress(progress);
  }
  // Persist before any listing so a concurrent cron tick sees an in-flight lease
  // instead of launching a sibling job against the same prefix. Record force so
  // cron resume can honor a force wipe that DLQ'd during grace.
  progress.updated_at_ms = deps.nowMs;
  await writeProgress(env.READINGS_BUCKET, tenantId, progress);

  if (progress.phase === "vectors") {
    const fromR2 = await collectReadingIds(env.READINGS_BUCKET, layout);
    progress.reading_ids = mergeReadingIds(progress.reading_ids, fromR2);
    progress.updated_at_ms = deps.nowMs;
    await writeProgress(env.READINGS_BUCKET, tenantId, progress);
    const vec = await submitStoredVectorDeletes(progress, env, tenantId, deps.nowMs, maxVectorBatches);
    if (vec === "continue") {
      return {
        kind: "continue",
        objects_deleted: progress.objects_deleted,
        mutation_ids: progress.mutation_ids,
      };
    }
    progress.phase = "objects";
    progress.updated_at_ms = deps.nowMs;
    await writeProgress(env.READINGS_BUCKET, tenantId, progress);
  }

  if (progress.phase === "objects") {
    if (!progress.reading_ids?.length) {
      const fromR2 = await collectReadingIds(env.READINGS_BUCKET, layout);
      progress.reading_ids = mergeReadingIds(progress.reading_ids, fromR2);
      progress.updated_at_ms = deps.nowMs;
      await writeProgress(env.READINGS_BUCKET, tenantId, progress);
    }
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
        // in the prefix. Confirm emptiness without the cursor before sweep.
        if (await prefixHasObjects(env.READINGS_BUCKET, keyRoot)) {
          cursor = undefined;
          progress.r2_cursor = undefined;
          progress.updated_at_ms = deps.nowMs;
          await writeProgress(env.READINGS_BUCKET, tenantId, progress);
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
        progress.phase = "sweep";
        progress.vector_offset = 0;
        progress.r2_cursor = undefined;
        progress.updated_at_ms = deps.nowMs;
        await writeProgress(env.READINGS_BUCKET, tenantId, progress);
        break objects;
      }
      await env.READINGS_BUCKET.delete(list.objects.map((obj) => obj.key));
      progress.objects_deleted += list.objects.length;
      pages += 1;
      cursor = list.truncated ? list.cursor : undefined;
      progress.r2_cursor = cursor;
      progress.updated_at_ms = deps.nowMs;
      await writeProgress(env.READINGS_BUCKET, tenantId, progress);
      if (!cursor) {
        const again = await env.READINGS_BUCKET.list({ prefix: keyRoot, limit: 1 });
        if (again.objects.length === 0) {
          progress.phase = "sweep";
          progress.vector_offset = 0;
          progress.r2_cursor = undefined;
          progress.updated_at_ms = deps.nowMs;
          await writeProgress(env.READINGS_BUCKET, tenantId, progress);
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

  if (progress.phase === "sweep") {
    const sweep = await submitStoredVectorDeletes(progress, env, tenantId, deps.nowMs, maxVectorBatches);
    if (sweep === "continue") {
      return {
        kind: "continue",
        objects_deleted: progress.objects_deleted,
        mutation_ids: progress.mutation_ids,
      };
    }
    progress = {
      ...progress,
      phase: "done",
      r2_cursor: undefined,
      updated_at_ms: deps.nowMs,
    };
    await writeProgress(env.READINGS_BUCKET, tenantId, progress);
    return {
      kind: "complete",
      objects_deleted: progress.objects_deleted,
      mutation_ids: progress.mutation_ids,
    };
  }

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
    const delaySeconds = wipeRetryDelaySeconds(retryAfterMs, msg.attempts ?? 1);
    try {
      await extendWipeLeaseForRetry(env, parsed.envelope.tenantId, deps.nowMs, delaySeconds);
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
  };
}

function mergeReadingIds(stored: string[] | undefined, collected: string[]): string[] {
  const ids = new Set<string>();
  for (const raw of [...(stored ?? []), ...collected]) {
    const id = parseReadingId(raw);
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

async function submitStoredVectorDeletes(
  progress: AccountWipeProgress,
  env: AccountWipeEnv,
  tenantId: TenantId,
  nowMs: number,
  maxVectorBatches: number,
): Promise<"continue" | "done"> {
  const ids = progress.reading_ids ?? [];
  const remaining = ids.slice(progress.vector_offset);
  if (remaining.length === 0) return "done";
  if (!env.READINGS_INDEX) {
    throw new Error("account_wipe index_unbound");
  }
  const store = similarityStoreFor(env.READINGS_INDEX, { tenantId }, env);
  const batchLimit = Math.min(remaining.length, maxVectorBatches * VECTORIZE_DELETE_MAX_IDS);
  const toDelete = remaining.slice(0, batchLimit);
  const mutations = await store.deleteMany(toDelete);
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
  progress.vector_offset += toDelete.length;
  progress.updated_at_ms = nowMs;
  await writeProgress(env.READINGS_BUCKET, tenantId, progress);
  return progress.vector_offset < ids.length ? "continue" : "done";
}

async function extendWipeLeaseForRetry(
  env: AccountWipeEnv,
  tenantId: string,
  nowMs: number,
  delaySeconds: number,
): Promise<void> {
  const parsed = parseTenantId(tenantId);
  if (!parsed) return;
  const progress = await readProgress(env.READINGS_BUCKET, parsed);
  if (!progress) return;
  await writeProgress(env.READINGS_BUCKET, parsed, {
    ...progress,
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
    reading_ids: [],
  };
}

async function readProgress(
  bucket: R2Bucket,
  tenantId: TenantId,
): Promise<AccountWipeProgress | null> {
  const obj = await bucket.get(accountWipeProgressKey(tenantId));
  if (!obj) return null;
  try {
    const parsed = AccountWipeProgressSchema.safeParse(JSON.parse(await obj.text()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeProgress(
  bucket: R2Bucket,
  tenantId: TenantId,
  progress: AccountWipeProgress,
): Promise<void> {
  await bucket.put(accountWipeProgressKey(tenantId), JSON.stringify(progress), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function collectReadingIds(bucket: R2Bucket, layout: ReturnType<typeof r2KeyLayout>): Promise<string[]> {
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
  await scanPrefixForIds(bucket, layout.byIdKey(""), layout, ids);
  await scanPrefixForIds(bucket, layout.readingsPrefix(), layout, ids);
  return [...ids].sort();
}

async function scanPrefixForIds(
  bucket: R2Bucket,
  prefix: string,
  layout: ReturnType<typeof r2KeyLayout>,
  ids: Set<string>,
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
  } while (cursor);
}
