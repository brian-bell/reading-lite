/** Hosted tension judgement (reading-lite-mtdh): the pairwise sibling of
 * relationship-judge.ts, with the same guarantees. It never activates a
 * reading attempt or writes a failed manifest. Paid dispatch uses the same
 * leases and spend admission as reading processing; the pair's latest-job
 * checkpoint (tension_refresh_jobs) prevents another delivery repeating an
 * uncertain charge, and a saved judgement is replayed without another provider
 * call. Only `tensions` and `tensions_judged` change, on BOTH readings, in one
 * compare-and-replace that locks the pair in sorted id order: half a judged
 * pair is never written. A reading's version is the hash of the manifest its
 * rows project.
 * Eligibility (overlap pre-filter, not already judged) is decided again on
 * the live pair, so a pair the scan collected but the operator judged since,
 * or whose citation the connection judge removed, costs nothing.
 * Running predicates overlay applyStaleness: a zombie (TTL-expired) attempt is
 * not running. In-TTL running defers with DeferPaidWorkError before any
 * checkpoint write so consumeRelationshipRefresh re-enqueues the same identity.
 */
import type { Env } from "./index";
import { sha256Hex, type Services } from "./services";
import type { RefreshEnvelope } from "./relationship-refresh";
import { activeRefreshFounder } from "./relationship-refresh";
import { fromSql } from "./control-plane/db";
import { createPaidFetch, spendRpcFor } from "./control-plane/paid-dispatch";
import { acquireProcessingLeases, throwIfDeferred, DeferPaidWorkError, releaseProcessingLeases, presentLeaseBeforePaidDispatch, startProcessingLeaseHeartbeat } from "./control-plane/processing-leases";
import { readTensionJob, markTensionDispatched, saveTensionResult, markTensionRateLimited, releaseTensionClaim, type SavedTensionResult, type TensionPairKey } from "./control-plane/tension-refresh-jobs";
import { withSqlSession, type Sql } from "./modules/db/sql";
import type { TenantContext } from "./control-plane/ids";
import { pgReadingStoreFor } from "./modules/stores/postgres/reading-store";
import { pgReadingWriterFor } from "./modules/stores/postgres/reading-writer";
import { judgeTension } from "./modules/tension-judgement";
import { buildTensionJudgementInput, deriveTensionSides, isPairJudged, mergeTensionSide, tensionPairEligible } from "./modules/tension-judgement/refresh";
import type { TensionJudgement } from "./schemas/reading-summary";
import { retryDepsFromEnv, RateLimitedError } from "./modules/http-retry";
import { ManifestSchema, type Manifest } from "./schemas/manifest";
import { effectivelyRunning, pendingTtlSeconds } from "./modules/staleness";

type TensionJob = Extract<RefreshEnvelope, { kind: "tension" }>;
type Side = TensionJob["a"];
type Stored = { manifest: Manifest; etag: string };

export async function processTensionJudge(job: TensionJob, env: Env, services: Services): Promise<void> {
  if (env.RELATIONSHIP_REFRESH !== "1") return;
  const tenant = await activeRefreshFounder(env);
  if (!tenant || tenant.tenantId !== job.tenantId) return;
  // The scan only ever sends a canonical pair; anything else is not one of ours.
  if (!(job.a.id < job.b.id)) {
    console.error("tension_refresh_invalid_pair");
    return;
  }
  await withSqlSession(env, (sql) => judgeWith(sql, tenant, job, env, services));
}

async function judgeWith(sql: Sql, tenant: TenantContext, job: TensionJob, env: Env, services: Services): Promise<void> {
  const runAt = new Date(job.runAt).toISOString();
  const db = fromSql(sql);
  const rows = pgReadingStoreFor(sql, tenant);
  const writer = pgReadingWriterFor(sql, tenant);
  const key: TensionPairKey = { tenantId: job.tenantId, a: job.a.id, b: job.b.id };
  const versionOf = (manifest: Manifest) => sha256Hex(JSON.stringify(manifest));
  const listed = async (id: string) => (await rows.relationshipTargets([id]))[0] ?? null;
  const ttl = pendingTtlSeconds(env.PENDING_TTL_SECONDS);
  const logNoop = (reason: string, extra?: Record<string, unknown>) => {
    console.warn(JSON.stringify({ event: "tension_refresh_noop", a: job.a.id, b: job.b.id, reason, ...extra }));
  };
  // Overlay applyStaleness for the running bit only. Raw manifest + etag stay
  // on `stored` for hashing and CAS. Pre-checkpoint callers pass deferIfRunning
  // so in-TTL running re-enqueues instead of silently acking.
  const liveSide = async (side: Side, deferIfRunning: boolean): Promise<Stored | null> => {
    const row = await listed(side.id);
    if (!row || row.status !== "ready" || row.key_prefix !== side.key_prefix) return null;
    const found = await rows.loadReadingById(side.id);
    if (!found || found.manifest.id !== side.id || found.manifest.status !== "ready") return null;
    if (effectivelyRunning(found.manifest, ttl, services.now())) {
      if (deferIfRunning) {
        console.warn(JSON.stringify({ event: "tension_refresh_deferred", a: job.a.id, b: job.b.id, reason: "reading_running", readingId: side.id }));
        throw new DeferPaidWorkError();
      }
      return null;
    }
    return { manifest: found.manifest, etag: await versionOf(found.manifest) };
  };
  const livePair = async (deferIfRunning = false): Promise<[Stored, Stored] | null> => {
    const a = await liveSide(job.a, deferIfRunning);
    const b = a && await liveSide(job.b, deferIfRunning);
    return a && b ? [a, b] : null;
  };
  const stillFounder = async () =>
    env.RELATIONSHIP_REFRESH === "1" && (await activeRefreshFounder(env, db))?.tenantId === tenant.tenantId;
  const stillCurrent = async (aEtag: string, bEtag: string, deferIfRunning = false) => {
    if (!await stillFounder()) return false;
    const pair = await livePair(deferIfRunning);
    return pair !== null && pair[0].etag === aEtag && pair[1].etag === bEtag;
  };
  // Both sides of one judgement, merged onto the versions it was made from.
  // Deterministic, so a replay rebuilds exactly the manifests the checkpoint
  // hashed.
  const judgedPair = (a: Manifest, b: Manifest, judgement: TensionJudgement, computedAt: string): [Manifest, Manifest] => {
    const sides = deriveTensionSides(judgement, { a: job.a.id, b: job.b.id }, computedAt);
    const next = (current: Manifest, partner: string, entry: typeof sides.a) => {
      const merged = mergeTensionSide(current, partner, entry, computedAt);
      if (!merged.ok) throw new Error(merged.error);
      return ManifestSchema.parse(merged.manifest);
    };
    return [next(a, job.b.id, sides.a), next(b, job.a.id, sides.b)];
  };
  const publish = async (saved: SavedTensionResult, aVersion: string, bVersion: string) => {
    const current = await livePair();
    if (!current || !await stillFounder()) return;
    const [a, b] = current;
    // The hashes identify our exact committed pair after a crash, without
    // retaining a copy of either summary in the checkpoint row.
    if (await versionOf(a.manifest) === saved.a_hash && await versionOf(b.manifest) === saved.b_hash) return;
    if (a.etag !== aVersion || b.etag !== bVersion) return;
    const [nextA, nextB] = judgedPair(a.manifest, b.manifest, saved.judgement, saved.computed_at);
    if (await versionOf(nextA) !== saved.a_hash || await versionOf(nextB) !== saved.b_hash) {
      throw new Error("invalid tension checkpoint identity");
    }
    // One transaction for the pair; a single stale side abandons both.
    await writer.replacePublishedSetIf([
      { id: job.a.id, matches: async m => await versionOf(m) === aVersion, next: nextA },
      { id: job.b.id, matches: async m => await versionOf(m) === bVersion, next: nextB },
    ]);
  };

  const original = await livePair(true);
  if (!original) {
    const purged = !await listed(job.a.id) || !await listed(job.b.id);
    logNoop(purged ? "purged" : "not_ready");
    return;
  }
  const checkpoint = await readTensionJob(db, key);
  if (checkpoint && checkpoint.run_at > runAt) return;
  if (checkpoint?.run_at === runAt) {
    if (checkpoint.result) { await publish(checkpoint.result, checkpoint.a_version, checkpoint.b_version); return; }
    if (checkpoint.retry_at_ms === null) { console.warn("tension_refresh_dispatch_uncertain"); return; }
    const waitMs = checkpoint.retry_at_ms - Date.now();
    if (waitMs > 0) throw new DeferPaidWorkError(Math.ceil(waitMs / 1000));
  }
  const [a, b] = original;
  if (!tensionPairEligible(a.manifest, b.manifest)) {
    logNoop(isPairJudged(a.manifest, b.manifest) ? "already_judged" : "ineligible");
    return;
  }
  const input = buildTensionJudgementInput(a.manifest, b.manifest);
  if (!await stillCurrent(a.etag, b.etag, true)) {
    // Gate/founder loss soft-acks; version drift is a terminal noop. In-TTL
    // running already threw from livePair(true) inside stillCurrent.
    if (await stillFounder()) logNoop("etag_changed");
    return;
  }
  const attemptId = `tension:${job.a.id}|${job.b.id}:${runAt}`;
  const clock = () => Date.parse(services.now());
  const hold = throwIfDeferred(await acquireProcessingLeases(env, job.tenantId, attemptId, clock()));
  if (hold === "already_running") throw new DeferPaidWorkError();
  const stop = startProcessingLeaseHeartbeat(env, hold, clock);
  const owner = services.newId();
  try {
    const assertCurrent = async () => {
      if (!await stillCurrent(a.etag, b.etag)) throw new DOMException("tension input changed", "AbortError");
      await presentLeaseBeforePaidDispatch(env, hold, clock);
    };
    let providerDispatched = false;
    const paidFetch = createPaidFetch({
      tenantId: job.tenantId, attemptId, stage: "summarize", fetch: (...args) => { providerDispatched = true; return services.fetch(...args); },
      rpc: spendRpcFor(env), now: Date.now, beforeDispatch: assertCurrent,
      onAuthorizedDispatch: async () => {
        await assertCurrent();
        // Revalidate after claiming: purge may have just removed the checkpoint.
        // Cleanup also covers a committed claim whose database response was lost.
        try {
          if (!await markTensionDispatched(db, { ...key, runAt, owner, aVersion: a.etag, bVersion: b.etag })) {
            throw new DOMException("tension already dispatched", "AbortError");
          }
          await assertCurrent();
        } catch (error) {
          // Before the first fetch this is a known unused claim. Later HTTP
          // retries must preserve uncertainty from an earlier provider attempt.
          if (!providerDispatched || !await listed(job.a.id) || !await listed(job.b.id)) {
            await releaseTensionClaim(db, key, owner);
          }
          throw error;
        }
      },
    });
    const result = await judgeTension(input, {
      fetch: paidFetch, provider: env.SUMMARIZER_PROVIDER,
      openaiApiKey: env.OPENAI_API_KEY, openaiModel: env.OPENAI_SUMMARIZATION_MODEL,
      openaiReasoningEffort: env.OPENAI_SUMMARIZATION_REASONING_EFFORT,
      anthropicApiKey: env.ANTHROPIC_API_KEY, anthropicModel: env.ANTHROPIC_MODEL,
      anthropicReasoningEffort: env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT,
      retry: retryDepsFromEnv(env),
    });
    if (!await stillCurrent(a.etag, b.etag)) return;
    const computedAt = services.now();
    const [nextA, nextB] = judgedPair(a.manifest, b.manifest, result.judgement, computedAt);
    const saved = await saveTensionResult(db, key, owner, {
      judgement: result.judgement, computed_at: computedAt,
      a_hash: await versionOf(nextA), b_hash: await versionOf(nextB),
    });
    if (saved) await publish(saved, a.etag, b.etag);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      await markTensionRateLimited(db, key, owner, Date.now() + Math.max(0, error.retryAfterMs ?? 30_000));
    }
    throw error;
  } finally {
    await stop();
    await releaseProcessingLeases(env, hold, clock());
  }
}
