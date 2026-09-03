/**
 * Deferred tenant R2 + Vectorize wipe (issue 195b / s1k.10.1 PR1).
 *
 * Accounts already marked `users.status='deleting'` by 195a stay fenced.
 * This module does not hard-delete the users row, tear down Durable Objects,
 * cascade D1, or decide email reuse — those are PR2. DELETE /api/account
 * stays the suppress path; wipe is a shared-queue job plus the existing
 * 15-minute cron sweep, not an inline handler.
 *
 * Grace: honor `deleting_at_ms`. Default N=7 days. A job payload
 * `{ force: true }` skips grace (no ops CLI in this PR).
 *
 * Vectorize `deleteByIds` is async (mutationId, no immediate confirm).
 * Embeddings may take a short time to disappear. We fire deletes in ≤1000
 * id batches, record whatever the API returns, and do not poll the index
 * as if it were synchronously empty. Vectors are submitted before any R2
 * delete so ids cannot dangle after the prefix is gone.
 *
 * R2 `list()`/`delete()` cap at 1000 objects. Wipe pages the tenant prefix
 * from `tenantKeyRoot` (production `u/{tenantId}/`). An empty prefix is a
 * no-op success. Continuation cursors live at `wipe/{tenantId}/progress.json`
 * outside the tenant prefix so a crash mid-page resumes. A second run on an
 * already-wiped prefix is a no-op success.
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
export const ACCOUNT_WIPE_IN_FLIGHT_MS = 15 * 60_000;
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
  phase: z.enum(["vectors", "objects", "done"]),
  vector_offset: z.number().int().nonnegative(),
  r2_cursor: z.string().min(1).optional(),
  mutation_ids: z.array(z.string()),
  objects_deleted: z.number().int().nonnegative(),
  updated_at_ms: z.number().int().nonnegative(),
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
      if (!wipeGraceElapsed(row.deleting_at_ms, deps.nowMs)) continue;
      const progress = await readProgress(env.READINGS_BUCKET, tenantId);
      if (progress?.phase === "done") {
        if (!(await tenantPrefixHasObjects(env.READINGS_BUCKET, tenantId, env))) continue;
      } else if (
        progress &&
        deps.nowMs - progress.updated_at_ms < ACCOUNT_WIPE_IN_FLIGHT_MS
      ) {
        continue;
      }
      // Touch before send so the in-flight skip is real for the next cron tick
      // and so leftover `done` recovery does not immediately re-enqueue.
      const next: AccountWipeProgress = progress ?? emptyProgress(deps.nowMs);
      if (next.phase === "done") {
        next.phase = "objects";
        next.r2_cursor = undefined;
      }
      next.updated_at_ms = deps.nowMs;
      await writeProgress(env.READINGS_BUCKET, tenantId, next);
      await queue.send(accountWipeEnvelopeV1({ tenantId }));
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
  if (!envelope.force && !wipeGraceElapsed(user.deleting_at_ms, deps.nowMs)) {
    return { kind: "skipped", reason: "grace_period" };
  }

  if (!tenantDataPlaneEnabled(env)) {
    return { kind: "skipped", reason: "no_tenant_prefix" };
  }
  const keyRoot = tenantKeyRoot({ tenantId }, true);
  if (keyRoot === "") return { kind: "skipped", reason: "no_tenant_prefix" };

  const layout = r2KeyLayout(keyRoot);
  const maxObjectPages = deps.maxObjectPages ?? ACCOUNT_WIPE_DEFAULT_OBJECT_PAGES;
  const maxVectorBatches = deps.maxVectorBatches ?? ACCOUNT_WIPE_DEFAULT_VECTOR_BATCHES;

  let progress = (await readProgress(env.READINGS_BUCKET, tenantId)) ?? emptyProgress(deps.nowMs);
  if (progress.phase === "done") {
    if (!(await prefixHasObjects(env.READINGS_BUCKET, keyRoot))) {
      return { kind: "complete", objects_deleted: progress.objects_deleted, mutation_ids: progress.mutation_ids };
    }
    progress = { ...progress, phase: "objects", r2_cursor: undefined };
  }
  // Persist before any listing so a concurrent cron tick sees an in-flight lease
  // instead of launching a sibling job against the same prefix.
  progress.updated_at_ms = deps.nowMs;
  await writeProgress(env.READINGS_BUCKET, tenantId, progress);

  if (progress.phase === "vectors") {
    const readingIds = await collectReadingIds(env.READINGS_BUCKET, layout);
    const remaining = readingIds.slice(progress.vector_offset);
    if (remaining.length > 0 && env.READINGS_INDEX) {
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
      progress.updated_at_ms = deps.nowMs;
      await writeProgress(env.READINGS_BUCKET, tenantId, progress);
      if (progress.vector_offset < readingIds.length) {
        return {
          kind: "continue",
          objects_deleted: progress.objects_deleted,
          mutation_ids: progress.mutation_ids,
        };
      }
    } else if (remaining.length > 0) {
      console.info(
        JSON.stringify({
          event: "account_wipe_vector_delete_skipped",
          tenant_id: tenantId,
          reason: "index_unbound",
          count: remaining.length,
        }),
      );
      progress.vector_offset = readingIds.length;
    }
    progress.phase = "objects";
    progress.updated_at_ms = deps.nowMs;
    await writeProgress(env.READINGS_BUCKET, tenantId, progress);
  }

  let pages = 0;
  let cursor = progress.r2_cursor;
  for (;;) {
    const list = await env.READINGS_BUCKET.list({
      prefix: keyRoot,
      limit: R2_LIST_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (list.objects.length === 0) {
      // A stored cursor can land on an empty page while objects remain earlier
      // in the prefix. Confirm emptiness without the cursor before `done`.
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
  return Math.max(1, Math.min(43_200, Math.ceil(ms / 1000)));
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

function emptyProgress(nowMs: number): AccountWipeProgress {
  return {
    version: 1,
    phase: "vectors",
    vector_offset: 0,
    mutation_ids: [],
    objects_deleted: 0,
    updated_at_ms: nowMs,
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
