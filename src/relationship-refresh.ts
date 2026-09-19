import { RateLimitedError } from "./modules/http-retry";
import { DeferPaidWorkError } from "./control-plane/processing-leases";
import { processRelationshipJudge } from "./relationship-judge";
import { defaultServices, type Services } from "./services";
import { PROCESSING_DEFER_MAX_AGE_MS } from "./control-plane/constants";
/**
 * Founder-only nightly refresh (#175). Full read-only scans run in
 * bounded queue shards, then flagged ids are dispatched under a nightly cap.
 * Scan shards write only the tenant cursor; judge jobs use relationship-judge.ts.
 * A persisted pending batch reserves allowance before queue send. Uncertain
 * sends may redeliver the same judge identity (runAt + readingId); the judge
 * deduplicates that identity before paid work. The next cron recovers interrupted
 * continuations. Offline refresh-state.json remains owned by the operator.
 * Scan running checks overlay applyStaleness via services.now(): a zombie
 * (TTL-expired) running target stays candidatable. In-TTL running is skipped
 * at scan time only; a later judge that sees in-TTL running defers the same
 * identity instead of acking.
 */
import { z } from "zod";
import type { Env } from "./index";
import { withControlPlane, type ControlPlaneDb } from "./control-plane/db";
import { canonicalizeEmail } from "./control-plane/email";
import { parseTenantId, type TenantContext } from "./control-plane/ids";
import { withSqlSession } from "./modules/db/sql";
import { tenantKeyRoot } from "./modules/stores/reading-store";
import { r2KeyLayout } from "./modules/stores/layout";
import { pgReadingStoreFor } from "./modules/stores/postgres/reading-store";
import { pgSimilarityStoreFor } from "./modules/stores/postgres/similarity-store";
import { diffNeighbourhood, resolveJudgedAt, REFRESH_CANDIDATE_TOP_K } from "./modules/refresh-neighbours";
import { effectivelyRunning, pendingTtlSeconds } from "./modules/staleness";

export const REFRESH_CRON = "7 3 * * *";
export const REFRESH_SCAN_SIZE = 25;
const DEFAULT_MAX_JUDGEMENTS = 100;
const TargetSchema = z.object({ id: z.string().min(1), key_prefix: z.string().startsWith("readings/") });
const BaseEnvelope = z.object({ version: z.literal(1), tenantId: z.string().refine(v => parseTenantId(v) === v) });
export const RefreshEnvelopeSchema = z.discriminatedUnion("kind", [
  BaseEnvelope.extend({ kind: z.literal("scan"), token: z.string().min(1) }),
  BaseEnvelope.extend({ kind: z.literal("judge"), deferredAt: z.string().datetime().optional(), runAt: z.string().datetime(), readingId: z.string().min(1), keyPrefix: z.string().startsWith("readings/") }),
]);
export type RefreshEnvelope = z.infer<typeof RefreshEnvelopeSchema>;
const CursorSchema = z.object({
  version: z.literal(1), token: z.string().min(1), run_at: z.string().datetime(),
  budget_at: z.string().datetime(), limit: z.number().int().min(1).max(1000),
  dispatched: z.number().int().nonnegative(),
  targets: z.array(TargetSchema), scan_offset: z.number().int().nonnegative(),
  candidates: z.array(TargetSchema), judge_offset: z.number().int().nonnegative(),
  pending: z.array(TargetSchema).max(REFRESH_SCAN_SIZE),
  // A new night can arrive while an old reservation is awaiting confirmation.
  rollover: z.object({ budget_at: z.string().datetime(), limit: z.number().int().min(1).max(1000) }).optional(),
}).refine(c => c.scan_offset <= c.targets.length && c.judge_offset <= c.candidates.length && c.dispatched <= c.limit);
type Cursor = z.infer<typeof CursorSchema>;
type StoredCursor = { cursor: Cursor; etag: string };

function maxJudgements(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_JUDGEMENTS;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 1000) {
    throw new Error("REFRESH_MAX_JUDGEMENTS must be an integer from 1 to 1000");
  }
  return Number(raw);
}

// `db` is the caller's connection when it has one; otherwise a short-lived one.
export async function activeRefreshFounder(env: Env, db?: ControlPlaneDb): Promise<TenantContext | null> {
  if (env.TENANT_DATA_PLANE !== "1" || !env.FOUNDER_EMAIL) return null;
  const email = canonicalizeEmail(env.FOUNDER_EMAIL);
  const lookup = (cp: ControlPlaneDb) =>
    cp.first<{ id: string }>("SELECT id FROM users WHERE email_canonical = ? AND status = 'active'", email);
  const row = await (db ? lookup(db) : withControlPlane(env, lookup));
  const tenantId = row && parseTenantId(row.id);
  return tenantId ? { tenantId } : null;
}
function cursorKey(tenant: TenantContext): string {
  return r2KeyLayout(tenantKeyRoot(tenant, true)).refreshCursorKey();
}
async function readCursor(env: Env, tenant: TenantContext): Promise<StoredCursor | null> {
  const obj = await env.READINGS_BUCKET.get(cursorKey(tenant));
  return obj ? { cursor: CursorSchema.parse(await obj.json()), etag: obj.etag } : null;
}
async function saveCursor(env: Env, tenant: TenantContext, previous: StoredCursor | null, cursor: Cursor): Promise<boolean> {
  // Recheck suppression immediately before every write. CAS protects competing
  // cron/queue work; a removed cursor is never recreated by a stale consumer.
  if ((await activeRefreshFounder(env))?.tenantId !== tenant.tenantId) return false;
  return (await env.READINGS_BUCKET.put(cursorKey(tenant), JSON.stringify(CursorSchema.parse(cursor)), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: "*" },
  })) !== null;
}
function complete(c: Cursor): boolean {
  return c.scan_offset === c.targets.length && c.judge_offset === c.candidates.length && c.pending.length === 0;
}
function runnable(c: Cursor): boolean {
  return c.pending.length > 0 || c.scan_offset < c.targets.length ||
    (c.judge_offset < c.candidates.length && c.dispatched < c.limit);
}
async function enqueueScan(env: Env, tenant: TenantContext, c: Cursor): Promise<void> {
  if (runnable(c)) await env.RELATIONSHIP_REFRESH_JOBS!.send({ version: 1, kind: "scan", tenantId: tenant.tenantId, token: c.token });
}

export async function scheduleRelationshipRefresh(env: Env, nowMs: number, newId = () => crypto.randomUUID()): Promise<void> {
  if (env.RELATIONSHIP_REFRESH !== "1") return;
  const limit = maxJudgements(env.REFRESH_MAX_JUDGEMENTS);
  if (!env.RELATIONSHIP_REFRESH_JOBS) return;
  const tenant = await activeRefreshFounder(env);
  if (!tenant) return;
  const previous = await readCursor(env, tenant);
  const runAt = new Date(nowMs).toISOString();
  let c = previous?.cursor;
  const nextNight = !c || runAt.slice(0, 10) > c.budget_at.slice(0, 10);
  if (!c || (nextNight && complete(c))) {
    const library = await withSqlSession(env, (sql) => pgReadingStoreFor(sql, tenant).allListItems());
    c = {
      version: 1, token: newId(), run_at: runAt, budget_at: runAt, limit, dispatched: 0,
      targets: library.filter(r => r.status === "ready")
        .map(({ id, key_prefix }) => ({ id, key_prefix })).sort((a, b) => a.id.localeCompare(b.id)),
      scan_offset: 0, candidates: [], judge_offset: 0, pending: [],
    };
    if (!await saveCursor(env, tenant, previous, c)) return;
  } else if (nextNight && c.pending.length === 0) {
    c = { ...c, token: newId(), budget_at: runAt, limit, dispatched: 0, rollover: undefined };
    if (!await saveCursor(env, tenant, previous, c)) return;
  } else if (nextNight && (!c.rollover || runAt.slice(0, 10) > c.rollover.budget_at.slice(0, 10))) {
    c = { ...c, token: newId(), rollover: { budget_at: runAt, limit } };
    if (!await saveCursor(env, tenant, previous, c)) return;
  }
  // Repeated cron deliveries recover the same token; they never reset allowance.
  // A pending batch retains its original reservation until send is confirmed.
  await enqueueScan(env, tenant, c);
}

async function processScan(env: Env, job: Extract<RefreshEnvelope, { kind: "scan" }>, newId: () => string, nowIso: string): Promise<void> {
  const tenant = await activeRefreshFounder(env);
  if (!tenant || tenant.tenantId !== job.tenantId || !env.RELATIONSHIP_REFRESH_JOBS) return;
  const stored = await readCursor(env, tenant);
  if (!stored) return;
  if (stored.cursor.token !== job.token) {
    // A committed shard can lose its continuation send. Retry the current
    // cursor without repeating the shard or resetting its reserved allowance.
    await enqueueScan(env, tenant, stored.cursor);
    return;
  }
  const c = stored.cursor;
  let next: Cursor;
  if (c.pending.length > 0) {
    await env.RELATIONSHIP_REFRESH_JOBS.sendBatch(c.pending.map(target => ({ body: {
      version: 1, kind: "judge", tenantId: tenant.tenantId, runAt: c.run_at,
      readingId: target.id, keyPrefix: target.key_prefix,
    } })));
    next = { ...c, pending: [], token: newId(),
      ...(c.rollover ? { ...c.rollover, dispatched: 0, rollover: undefined } : {}),
    };
  } else if (c.scan_offset < c.targets.length) {
    const shard = c.targets.slice(c.scan_offset, c.scan_offset + REFRESH_SCAN_SIZE);
    const candidates = [...c.candidates];
    await withSqlSession(env, async (sql) => {
      const store = pgReadingStoreFor(sql, tenant);
      const similarity = pgSimilarityStoreFor(sql, tenant);
      const list = await store.allListItems();
      const live = new Map(list.map(r => [r.id, r]));
      for (const target of shard) {
        const row = live.get(target.id);
        if (!row || row.status !== "ready" || row.key_prefix !== target.key_prefix) continue;
        const manifest = (await store.loadReadingById(target.id))?.manifest ?? null;
        // Overlay applyStaleness for running only. A zombie attempt on a ready
        // manifest is still candidatable; in-TTL reprocess is skipped here.
        if (!manifest || manifest.id !== target.id || manifest.status !== "ready") continue;
        if (effectivelyRunning(manifest, pendingTtlSeconds(env.PENDING_TTL_SECONDS), nowIso)) continue;
        const matches = await similarity.queryByVectorId(target.id, REFRESH_CANDIDATE_TOP_K);
        if (matches === null) continue;
        const judged = resolveJudgedAt({ ...manifest, key_prefix: target.key_prefix });
        if (diffNeighbourhood({ ...manifest, key_prefix: target.key_prefix }, matches, list, judged.judged_at).length > 0) candidates.push(target);
      }
    });
    next = { ...c, candidates, scan_offset: c.scan_offset + shard.length, token: newId() };
  } else {
    const count = Math.min(REFRESH_SCAN_SIZE, c.limit - c.dispatched);
    const pending = c.candidates.slice(c.judge_offset, c.judge_offset + count);
    if (pending.length === 0) return;
    // Reserve before send; retries keep identical judge identities and cannot
    // reserve another batch beyond this night's cap.
    next = { ...c, pending, judge_offset: c.judge_offset + pending.length,
      dispatched: c.dispatched + pending.length, token: newId() };
  }
  if (!await saveCursor(env, tenant, stored, next)) return;
  await enqueueScan(env, tenant, next);
}

export async function consumeRelationshipRefresh(msg: Message<unknown>, env: Env, newId = () => crypto.randomUUID(), services: Services = defaultServices()): Promise<void> {
  if (env.RELATIONSHIP_REFRESH !== "1") { msg.ack(); return; }
  const parsed = RefreshEnvelopeSchema.safeParse(msg.body);
  if (!parsed.success) { console.error("relationship_refresh_invalid_envelope"); msg.ack(); return; }
  if (parsed.data.kind === "judge" && parsed.data.deferredAt &&
    Date.now() - Date.parse(parsed.data.deferredAt) >= PROCESSING_DEFER_MAX_AGE_MS) {
    console.warn("relationship_refresh_deferral_expired");
    msg.ack();
    return;
  }
  try {
    if (parsed.data.kind === "judge") await processRelationshipJudge(parsed.data, env, services);
    else await processScan(env, parsed.data, newId, services.now());
    msg.ack();
  } catch (error) {
    console.error(error);
    const delay = error instanceof RateLimitedError ? Math.ceil((error.retryAfterMs ?? 30_000) / 1000)
      : error instanceof DeferPaidWorkError ? error.delaySeconds : 30;
    const delaySeconds = Math.min(43_200, Math.max(1, delay));
    if (parsed.data.kind === "judge" &&
      (error instanceof RateLimitedError || error instanceof DeferPaidWorkError) && env.RELATIONSHIP_REFRESH_JOBS) {
      try {
        await env.RELATIONSHIP_REFRESH_JOBS.send({ ...parsed.data,
          deferredAt: parsed.data.deferredAt ?? new Date().toISOString(),
        }, { delaySeconds });
        msg.ack();
        return;
      } catch (enqueueError) { console.error(enqueueError); }
    }
    msg.retry({ delaySeconds });
  }
}
