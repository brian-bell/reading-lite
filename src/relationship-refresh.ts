import { RateLimitedError } from "./modules/http-retry";
import { DeferPaidWorkError } from "./control-plane/processing-leases";
import { TenantProviderKeyError } from "./control-plane/tenant-provider-keys";
import { ProviderAccountError } from "./control-plane/paid-dispatch";
import { processRelationshipJudge } from "./relationship-judge";
import { processTensionJudge } from "./tension-judge";
import { processTensionRepair } from "./tension-repair";
import { defaultServices, type Services } from "./services";
import { PROCESSING_DEFER_MAX_AGE_MS } from "./control-plane/constants";
/**
 * Founder-only nightly refresh (#175). Full read-only scans run in
 * bounded queue shards, then flagged ids are dispatched under a nightly cap.
 * The same scan collects every floored ready-neighbour pair that clears the
 * tension pre-filter and is not already judged; those pairs dispatch after the
 * connection judges, under their own nightly cap (reading-lite-mtdh). It also
 * collects every pair one of its readings names that the free one-sided
 * repairs would change; those dispatch first, uncapped, so a dangling tension
 * is gone before its holder's connection judge re-measures it, and a pair one
 * mirror would settle is never judged (reading-lite-qxfh).
 * Scan shards write only the tenant cursor; judge jobs use relationship-judge.ts,
 * tension jobs tension-judge.ts and repair jobs tension-repair.ts.
 * A persisted pending batch reserves allowance before queue send. Uncertain
 * sends may redeliver the same judge identity (runAt + readingId, or runAt +
 * pair); the judge deduplicates that identity before paid work. The next cron
 * recovers interrupted continuations. Undispatched tension pairs never hold
 * back the next night's scan: a pair left over is still unjudged, so the fresh
 * scan finds it again. The operator's offline run marker (the corpus_refresh_state
 * row) is separate and owned by `ops corpus refresh-neighbours`.
 * Scan running checks overlay applyStaleness via services.now(): a zombie
 * (TTL-expired) running target stays candidatable. In-TTL running is skipped
 * at scan time only; a later judge that sees in-TTL running defers the same
 * identity instead of acking.
 */
import { z } from "zod";
import type { Env } from "./index";
import { fromSql, withControlPlane, type ControlPlaneDb } from "./control-plane/db";
import { canonicalizeEmail } from "./control-plane/email";
import { parseTenantId, type TenantContext } from "./control-plane/ids";
import { withSqlSession, type Sql } from "./modules/db/sql";
import { tenantKeyRoot } from "./modules/stores/tenant-root";
import { r2KeyLayout } from "./modules/stores/layout";
import { pgReadingStoreFor } from "./modules/stores/postgres/reading-store";
import { pgSimilarityStoreFor } from "./modules/stores/postgres/similarity-store";
import { diffNeighbourhood, flooredNeighbours, resolveJudgedAt, REFRESH_CANDIDATE_TOP_K } from "./modules/refresh-neighbours";
import { orderPair, pairTensionRepairs, tensionPairEligible, tensionPartnerIds, type RawManifest } from "./modules/tension-judgement/refresh";
import type { Manifest } from "./schemas/manifest";
import { effectivelyRunning, pendingTtlSeconds } from "./modules/staleness";

export const REFRESH_CRON = "7 3 * * *";
export const REFRESH_SCAN_SIZE = 25;
const DEFAULT_MAX_JUDGEMENTS = 100;
const TargetSchema = z.object({ id: z.string().min(1), key_prefix: z.string().startsWith("readings/") });
// A tension pair, canonical: a.id < b.id.
const PairSchema = z.object({ a: TargetSchema, b: TargetSchema }).refine(p => p.a.id < p.b.id);
// A pair a repair job reconciles, by id alone: one side may be purged.
const IdPairSchema = z.object({ a: z.string().min(1), b: z.string().min(1) }).refine(p => p.a < p.b);
const Cap = z.number().int().min(1).max(1000);
const BaseEnvelope = z.object({ version: z.literal(1), tenantId: z.string().refine(v => parseTenantId(v) === v) });
export const RefreshEnvelopeSchema = z.discriminatedUnion("kind", [
  BaseEnvelope.extend({ kind: z.literal("scan"), token: z.string().min(1) }),
  BaseEnvelope.extend({ kind: z.literal("judge"), deferredAt: z.string().datetime().optional(), runAt: z.string().datetime(), readingId: z.string().min(1), keyPrefix: z.string().startsWith("readings/") }),
  BaseEnvelope.extend({ kind: z.literal("tension"), deferredAt: z.string().datetime().optional(), runAt: z.string().datetime(), a: TargetSchema, b: TargetSchema }),
  BaseEnvelope.extend({ kind: z.literal("repair"), deferredAt: z.string().datetime().optional(), runAt: z.string().datetime(), a: z.string().min(1), b: z.string().min(1) }),
]);
export type RefreshEnvelope = z.infer<typeof RefreshEnvelopeSchema>;
const CursorSchema = z.object({
  version: z.literal(1), token: z.string().min(1), run_at: z.string().datetime(),
  budget_at: z.string().datetime(), limit: Cap,
  dispatched: z.number().int().nonnegative(),
  targets: z.array(TargetSchema), scan_offset: z.number().int().nonnegative(),
  candidates: z.array(TargetSchema), judge_offset: z.number().int().nonnegative(),
  pending: z.array(TargetSchema).max(REFRESH_SCAN_SIZE),
  // The tension fields default so a cursor written before them still parses.
  // With no tension_limit, that night dispatches no tension pairs; the next
  // night's allowance sets one.
  tension_limit: Cap.optional(),
  tension_dispatched: z.number().int().nonnegative().default(0),
  tension_candidates: z.array(PairSchema).default([]),
  tension_offset: z.number().int().nonnegative().default(0),
  tension_pending: z.array(PairSchema).max(REFRESH_SCAN_SIZE).default([]),
  // Free repairs are uncapped: every one a scan collects dispatches that night.
  repair_candidates: z.array(IdPairSchema).default([]),
  repair_offset: z.number().int().nonnegative().default(0),
  repair_pending: z.array(IdPairSchema).max(REFRESH_SCAN_SIZE).default([]),
  // A new night can arrive while an old reservation is awaiting confirmation.
  rollover: z.object({ budget_at: z.string().datetime(), limit: Cap, tension_limit: Cap.optional() }).optional(),
}).refine(c => c.scan_offset <= c.targets.length && c.judge_offset <= c.candidates.length && c.dispatched <= c.limit &&
  c.tension_offset <= c.tension_candidates.length && c.tension_dispatched <= (c.tension_limit ?? 0) &&
  c.repair_offset <= c.repair_candidates.length &&
  // One reservation at a time: a batch of any kind confirms before the next is reserved.
  [c.pending, c.tension_pending, c.repair_pending].filter(p => p.length > 0).length <= 1);
type Cursor = z.infer<typeof CursorSchema>;
type StoredCursor = { cursor: Cursor; etag: string };

function maxJudgements(name: "REFRESH_MAX_JUDGEMENTS" | "REFRESH_MAX_TENSION_JUDGEMENTS", raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_JUDGEMENTS;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 1000) {
    throw new Error(`${name} must be an integer from 1 to 1000`);
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
async function saveCursor(env: Env, db: ControlPlaneDb, tenant: TenantContext, previous: StoredCursor | null, cursor: Cursor): Promise<boolean> {
  // Recheck suppression immediately before every write. CAS protects competing
  // cron/queue work; a removed cursor is never recreated by a stale consumer.
  if ((await activeRefreshFounder(env, db))?.tenantId !== tenant.tenantId) return false;
  return (await env.READINGS_BUCKET.put(cursorKey(tenant), JSON.stringify(CursorSchema.parse(cursor)), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: "*" },
  })) !== null;
}
// Complete for a fresh scan: leftover tension pairs are not waited for (see
// the header), but uncapped repairs and a reserved batch of any kind are.
function complete(c: Cursor): boolean {
  return c.scan_offset === c.targets.length && c.judge_offset === c.candidates.length &&
    c.repair_offset === c.repair_candidates.length &&
    c.pending.length === 0 && c.tension_pending.length === 0 && c.repair_pending.length === 0;
}
function repairsLeft(c: Cursor): boolean {
  return c.repair_offset < c.repair_candidates.length;
}
function judgesLeft(c: Cursor): boolean {
  return c.judge_offset < c.candidates.length && c.dispatched < c.limit;
}
function tensionsLeft(c: Cursor): boolean {
  return c.tension_offset < c.tension_candidates.length && c.tension_dispatched < (c.tension_limit ?? 0);
}
function runnable(c: Cursor): boolean {
  return c.pending.length > 0 || c.tension_pending.length > 0 || c.repair_pending.length > 0 ||
    c.scan_offset < c.targets.length || repairsLeft(c) || judgesLeft(c) || tensionsLeft(c);
}
// A new night's full scan of every ready reading, sorted for stable shards.
function freshCursor(library: { id: string; key_prefix: string; status: string }[], runAt: string, token: string,
  limit: number, tensionLimit: number | undefined): Cursor {
  return {
    version: 1, token, run_at: runAt, budget_at: runAt, limit, dispatched: 0,
    targets: library.filter(r => r.status === "ready")
      .map(({ id, key_prefix }) => ({ id, key_prefix })).sort((a, b) => a.id.localeCompare(b.id)),
    scan_offset: 0, candidates: [], judge_offset: 0, pending: [],
    tension_limit: tensionLimit, tension_dispatched: 0, tension_candidates: [], tension_offset: 0, tension_pending: [],
    repair_candidates: [], repair_offset: 0, repair_pending: [],
  };
}
async function enqueueScan(env: Env, tenant: TenantContext, c: Cursor): Promise<void> {
  if (runnable(c)) await env.RELATIONSHIP_REFRESH_JOBS!.send({ version: 1, kind: "scan", tenantId: tenant.tenantId, token: c.token });
}

// One session for the whole cron delivery (or scan shard): the founder lookup,
// its recheck before every cursor write, and the library reads all share it,
// as scheduled work is meant to.
export async function scheduleRelationshipRefresh(env: Env, nowMs: number, newId = () => crypto.randomUUID()): Promise<void> {
  if (env.RELATIONSHIP_REFRESH !== "1") return;
  const limit = maxJudgements("REFRESH_MAX_JUDGEMENTS", env.REFRESH_MAX_JUDGEMENTS);
  const tensionLimit = maxJudgements("REFRESH_MAX_TENSION_JUDGEMENTS", env.REFRESH_MAX_TENSION_JUDGEMENTS);
  if (!env.RELATIONSHIP_REFRESH_JOBS) return;
  await withSqlSession(env, async (sql) => {
    const db = fromSql(sql);
    const tenant = await activeRefreshFounder(env, db);
    if (!tenant) return;
    const previous = await readCursor(env, tenant);
    const runAt = new Date(nowMs).toISOString();
    let c = previous?.cursor;
    const nextNight = !c || runAt.slice(0, 10) > c.budget_at.slice(0, 10);
    if (!c || (nextNight && complete(c))) {
      const library = await pgReadingStoreFor(sql, tenant).allListItems();
      c = freshCursor(library, runAt, newId(), limit, tensionLimit);
      if (!await saveCursor(env, db, tenant, previous, c)) return;
    } else if (nextNight && c.pending.length === 0 && c.tension_pending.length === 0 && c.repair_pending.length === 0) {
      c = { ...c, token: newId(), budget_at: runAt, limit, dispatched: 0,
        tension_limit: tensionLimit, tension_dispatched: 0, rollover: undefined };
      if (!await saveCursor(env, db, tenant, previous, c)) return;
    } else if (nextNight && (!c.rollover || runAt.slice(0, 10) > c.rollover.budget_at.slice(0, 10))) {
      c = { ...c, token: newId(), rollover: { budget_at: runAt, limit, tension_limit: tensionLimit } };
      if (!await saveCursor(env, db, tenant, previous, c)) return;
    }
    // Repeated cron deliveries recover the same token; they never reset allowance.
    // A pending batch retains its original reservation until send is confirmed.
    await enqueueScan(env, tenant, c);
  });
}

async function processScan(env: Env, job: Extract<RefreshEnvelope, { kind: "scan" }>, newId: () => string, nowIso: string): Promise<void> {
  await withSqlSession(env, (sql) => processScanWith(sql, env, job, newId, nowIso));
}

async function processScanWith(sql: Sql, env: Env, job: Extract<RefreshEnvelope, { kind: "scan" }>, newId: () => string, nowIso: string): Promise<void> {
  const db = fromSql(sql);
  const tenant = await activeRefreshFounder(env, db);
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
  // A confirmed send is where a new night's recorded allowance takes effect.
  // When that leaves the connection work complete, the new night starts its
  // fresh scan here, as the cron would have without a pending batch, rather
  // than spending its tension allowance on the old scan's leftover pairs.
  const confirmed = async (sent: Cursor): Promise<Cursor> => {
    if (!sent.rollover) return sent;
    const { budget_at, limit, tension_limit } = sent.rollover;
    if (complete(sent)) {
      const library = await pgReadingStoreFor(sql, tenant).allListItems();
      return freshCursor(library, budget_at, sent.token, limit, tension_limit ?? sent.tension_limit);
    }
    return { ...sent, budget_at, limit, dispatched: 0,
      tension_limit: tension_limit ?? sent.tension_limit, tension_dispatched: 0, rollover: undefined };
  };
  let next: Cursor;
  if (c.pending.length > 0) {
    await env.RELATIONSHIP_REFRESH_JOBS.sendBatch(c.pending.map(target => ({ body: {
      version: 1, kind: "judge", tenantId: tenant.tenantId, runAt: c.run_at,
      readingId: target.id, keyPrefix: target.key_prefix,
    } })));
    next = await confirmed({ ...c, pending: [], token: newId() });
  } else if (c.tension_pending.length > 0) {
    await env.RELATIONSHIP_REFRESH_JOBS.sendBatch(c.tension_pending.map(pair => ({ body: {
      version: 1, kind: "tension", tenantId: tenant.tenantId, runAt: c.run_at, a: pair.a, b: pair.b,
    } })));
    next = await confirmed({ ...c, tension_pending: [], token: newId() });
  } else if (c.repair_pending.length > 0) {
    await env.RELATIONSHIP_REFRESH_JOBS.sendBatch(c.repair_pending.map(pair => ({ body: {
      version: 1, kind: "repair", tenantId: tenant.tenantId, runAt: c.run_at, a: pair.a, b: pair.b,
    } })));
    next = await confirmed({ ...c, repair_pending: [], token: newId() });
  } else if (c.scan_offset < c.targets.length) {
    const shard = c.targets.slice(c.scan_offset, c.scan_offset + REFRESH_SCAN_SIZE);
    const candidates = [...c.candidates];
    const tensionCandidates = [...c.tension_candidates];
    const seenPairs = new Set(tensionCandidates.map(p => orderPair(p.a.id, p.b.id).key));
    const repairCandidates = [...c.repair_candidates];
    const seenRepairs = new Set(repairCandidates.map(p => orderPair(p.a, p.b).key));
    const store = pgReadingStoreFor(sql, tenant);
    const similarity = pgSimilarityStoreFor(sql, tenant);
    const list = await store.allListItems();
    const live = new Map(list.map(r => [r.id, r]));
    const readyIds = new Set(list.flatMap(r => r.status === "ready" ? [r.id] : []));
    const ttl = pendingTtlSeconds(env.PENDING_TTL_SECONDS);
    // A reading can be a target and several targets' neighbour in one shard.
    const loaded = new Map<string, Manifest | null>();
    const manifestOf = async (id: string) => {
      if (!loaded.has(id)) loaded.set(id, (await store.loadReadingById(id))?.manifest ?? null);
      return loaded.get(id)!;
    };
    // The partner is null when it is not ready: gone, failed, or pending.
    const repairsFor = (target: Manifest, partnerId: string, partner: Manifest | null) =>
      pairTensionRepairs(target.id, partnerId, new Map<string, RawManifest>(
        [[target.id, target], ...(partner ? [[partnerId, partner] as const] : [])]), readyIds);
    for (const target of shard) {
      const row = live.get(target.id);
      if (!row || row.status !== "ready" || row.key_prefix !== target.key_prefix) continue;
      const manifest = await manifestOf(target.id);
      // Overlay applyStaleness for running only. A zombie attempt on a ready
      // manifest is still candidatable; in-TTL reprocess is skipped here.
      if (!manifest || manifest.id !== target.id || manifest.status !== "ready") continue;
      if (effectivelyRunning(manifest, ttl, nowIso)) continue;
      const matches = await similarity.queryByVectorId(target.id, REFRESH_CANDIDATE_TOP_K);
      if (matches === null) continue;
      const judged = resolveJudgedAt({ ...manifest, key_prefix: target.key_prefix });
      if (diffNeighbourhood({ ...manifest, key_prefix: target.key_prefix }, matches, list, judged.judged_at).length > 0) candidates.push(target);
      // Free repairs for every pair the target names, including a partner
      // that is gone: its dangling entry is what tier 1 keeps flagging.
      for (const partnerId of new Set(tensionPartnerIds(manifest))) {
        if (partnerId === target.id) continue;
        const pair = orderPair(target.id, partnerId);
        if (seenRepairs.has(pair.key)) continue;
        const loadedPartner = readyIds.has(partnerId) ? await manifestOf(partnerId) : null;
        const partner = loadedPartner?.id === partnerId && loadedPartner.status === "ready" ? loadedPartner : null;
        if (readyIds.has(partnerId) && (!partner || effectivelyRunning(partner, ttl, nowIso))) continue;
        if (repairsFor(manifest, partnerId, partner).length === 0) continue;
        seenRepairs.add(pair.key);
        repairCandidates.push({ a: pair.a, b: pair.b });
      }
      // Tension pairs: the same floored ready neighbourhood the diff judged.
      const ready = matches.filter(m => live.get(m.id)?.status === "ready");
      for (const neighbour of flooredNeighbours(target.id, ready)) {
        const pair = orderPair(target.id, neighbour.id);
        if (seenPairs.has(pair.key)) continue;
        const partner = await manifestOf(neighbour.id);
        if (!partner || partner.id !== neighbour.id || partner.status !== "ready") continue;
        if (effectivelyRunning(partner, ttl, nowIso) || !tensionPairEligible(manifest, partner)) continue;
        // A one-sided judgement a mirror settles for free is not paid for again.
        if (repairsFor(manifest, neighbour.id, partner).some(r => r.kind !== "drop")) continue;
        seenPairs.add(pair.key);
        const side = (id: string) => id === target.id ? target : { id, key_prefix: live.get(id)!.key_prefix };
        tensionCandidates.push({ a: side(pair.a), b: side(pair.b) });
      }
    }
    next = { ...c, candidates, tension_candidates: tensionCandidates, repair_candidates: repairCandidates,
      scan_offset: c.scan_offset + shard.length, token: newId() };
  } else if (repairsLeft(c)) {
    // Repairs go first and are uncapped: they call no provider, and a holder
    // repaired before its connection judge runs no longer shows the drift.
    const repair_pending = c.repair_candidates.slice(c.repair_offset, c.repair_offset + REFRESH_SCAN_SIZE);
    next = { ...c, repair_pending, repair_offset: c.repair_offset + repair_pending.length, token: newId() };
  } else if (judgesLeft(c)) {
    // Reserve before send; retries keep identical judge identities and cannot
    // reserve another batch beyond this night's cap.
    const pending = c.candidates.slice(c.judge_offset, c.judge_offset + Math.min(REFRESH_SCAN_SIZE, c.limit - c.dispatched));
    next = { ...c, pending, judge_offset: c.judge_offset + pending.length,
      dispatched: c.dispatched + pending.length, token: newId() };
  } else if (tensionsLeft(c)) {
    // Connection judges go first; tension pairs then reserve against their own cap.
    const tension_pending = c.tension_candidates.slice(c.tension_offset,
      c.tension_offset + Math.min(REFRESH_SCAN_SIZE, c.tension_limit! - c.tension_dispatched));
    next = { ...c, tension_pending, tension_offset: c.tension_offset + tension_pending.length,
      tension_dispatched: c.tension_dispatched + tension_pending.length, token: newId() };
  } else {
    return;
  }
  if (!await saveCursor(env, db, tenant, stored, next)) return;
  await enqueueScan(env, tenant, next);
}

export async function consumeRelationshipRefresh(msg: Message<unknown>, env: Env, newId = () => crypto.randomUUID(), services: Services = defaultServices()): Promise<void> {
  if (env.RELATIONSHIP_REFRESH !== "1") { msg.ack(); return; }
  const parsed = RefreshEnvelopeSchema.safeParse(msg.body);
  if (!parsed.success) { console.error("relationship_refresh_invalid_envelope"); msg.ack(); return; }
  if (parsed.data.kind !== "scan" && parsed.data.deferredAt &&
    Date.now() - Date.parse(parsed.data.deferredAt) >= PROCESSING_DEFER_MAX_AGE_MS) {
    console.warn("relationship_refresh_deferral_expired");
    msg.ack();
    return;
  }
  try {
    if (parsed.data.kind === "judge") await processRelationshipJudge(parsed.data, env, services);
    else if (parsed.data.kind === "tension") await processTensionJudge(parsed.data, env, services);
    else if (parsed.data.kind === "repair") await processTensionRepair(parsed.data, env, services);
    else await processScan(env, parsed.data, newId, services.now());
    msg.ack();
  } catch (error) {
    console.error(error);
    if (error instanceof TenantProviderKeyError || error instanceof ProviderAccountError) {
      msg.ack();
      return;
    }
    const delay = error instanceof RateLimitedError ? Math.ceil((error.retryAfterMs ?? 30_000) / 1000)
      : error instanceof DeferPaidWorkError ? error.delaySeconds : 30;
    const delaySeconds = Math.min(43_200, Math.max(1, delay));
    if (parsed.data.kind !== "scan" &&
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
