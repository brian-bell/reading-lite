/** Hosted relationship judgement (#175 slice 3). Never activates a reading
 * attempt or writes a failed manifest. Paid dispatch uses the same leases and
 * spend admission as reading processing; the latest-job checkpoint prevents
 * another delivery repeating an uncertain charge. Only relationship fields and
 * an existing list row's novelty verdict are published, guarded by manifest CAS.
 * Running predicates overlay applyStaleness: a zombie (TTL-expired) attempt is
 * not running. In-TTL running defers with DeferPaidWorkError before any D1
 * checkpoint so consumeRelationshipRefresh re-enqueues the same identity.
 */
import type { Env } from "./index";
import { sha256Hex, type Services } from "./services";
import type { RefreshEnvelope } from "./relationship-refresh";
import { activeRefreshFounder } from "./relationship-refresh";
import { fromD1 } from "./control-plane/db";
import { createPaidFetch, spendRpcFor } from "./control-plane/paid-dispatch";
import { acquireProcessingLeases, throwIfDeferred, DeferPaidWorkError, releaseProcessingLeases, presentLeaseBeforePaidDispatch, startProcessingLeaseHeartbeat } from "./control-plane/processing-leases";
import { readRefreshJob, markRefreshDispatched, saveRefreshResult, markRefreshRateLimited, type SavedRefreshResult } from "./control-plane/relationship-refresh-jobs";
import { readingStoreFor } from "./modules/stores/reading-store";
import { similarityStoreFor } from "./modules/stores/similarity-store";
import { buildReportReading, diffNeighbourhood, resolveJudgedAt, REFRESH_CANDIDATE_TOP_K } from "./modules/refresh-neighbours";
import { judgeRelationships } from "./modules/relationship-judgement";
import { buildRelationshipJudgementInput, mergeRelationshipJudgement } from "./modules/relationship-judgement/refresh";
import { retryDepsFromEnv, RateLimitedError } from "./modules/http-retry";
import { ManifestSchema, type Manifest } from "./schemas/manifest";
import { effectivelyRunning, pendingTtlSeconds } from "./modules/staleness";

type JudgeJob = Extract<RefreshEnvelope, { kind: "judge" }>;
export async function processRelationshipJudge(job: JudgeJob, env: Env, services: Services): Promise<void> {
  if (env.RELATIONSHIP_REFRESH !== "1") return;
  const tenant = await activeRefreshFounder(env);
  if (!tenant || tenant.tenantId !== job.tenantId) return;
  const runAt = new Date(job.runAt).toISOString();
  const db = fromD1(env.CONTROL_PLANE);
  const store = readingStoreFor(env.READINGS_BUCKET, tenant, env);
  const ttl = pendingTtlSeconds(env.PENDING_TTL_SECONDS);
  const running = (manifest: Manifest) => effectivelyRunning(manifest, ttl, services.now());
  const deferRunning = (reason: "target_running" | "neighbour_running", neighbourId?: string): never => {
    console.warn(JSON.stringify({
      event: "relationship_refresh_deferred",
      readingId: job.readingId,
      reason,
      ...(neighbourId !== undefined ? { neighbourId } : {}),
    }));
    throw new DeferPaidWorkError();
  };
  const logNoop = (reason: string, extra?: Record<string, unknown>) => {
    console.warn(JSON.stringify({ event: "relationship_refresh_noop", readingId: job.readingId, reason, ...extra }));
  };
  // Overlay applyStaleness for the running bit only. Raw manifest + etag stay
  // on `stored` for hashing and CAS. Pre-checkpoint callers pass deferIfRunning
  // so in-TTL running re-enqueues instead of silently acking.
  const liveTarget = async (deferIfRunning = false) => {
    const row = await store.findListIndexItem(job.readingId);
    if (!row || row.status !== "ready" || row.key_prefix !== job.keyPrefix) return null;
    const stored = await store.readManifestWithEtag(job.keyPrefix);
    if (!stored || stored.manifest.id !== job.readingId || stored.manifest.status !== "ready") return null;
    if (running(stored.manifest)) {
      if (deferIfRunning) deferRunning("target_running");
      return null;
    }
    return stored;
  };
  const neighboursUnchanged = async (versions: SavedRefreshResult["neighbour_versions"], deferIfRunning = false) => {
    for (const version of versions) {
      const row = await store.findListIndexItem(version.id);
      if (!row || row.status !== "ready" || row.key_prefix !== version.key_prefix) return false;
      const stored = await store.readManifestWithEtag(row.key_prefix);
      if (!stored || stored.manifest.id !== version.id || stored.manifest.status !== "ready") return false;
      if (running(stored.manifest)) {
        if (deferIfRunning) deferRunning("neighbour_running", version.id);
        return false;
      }
      if (stored.etag !== version.etag) return false;
    }
    return true;
  };
  const original = await liveTarget(true);
  if (!original) {
    const row = await store.findListIndexItem(job.readingId);
    logNoop(!row ? "purged" : "not_ready");
    return;
  }
  const checkpoint = await readRefreshJob(db, job.tenantId, job.readingId);
  if (checkpoint && checkpoint.run_at > runAt) return;

  const stillCurrent = async (etag: string) =>
    env.RELATIONSHIP_REFRESH === "1" && (await activeRefreshFounder(env))?.tenantId === tenant.tenantId && (await liveTarget())?.etag === etag;
  const publish = async (saved: SavedRefreshResult, sourceEtag: string) => {
    const current = await liveTarget();
    if (!current || (await activeRefreshFounder(env))?.tenantId !== tenant.tenantId) return;
    // The hash identifies our exact committed manifest after a crash, without
    // retaining a copy of the summary in the D1 checkpoint.
    if (await sha256Hex(JSON.stringify(current.manifest)) !== saved.manifest_hash) {
      if (!await neighboursUnchanged(saved.neighbour_versions)) return;
      if (current.etag !== sourceEtag) return;
      const candidate = ManifestSchema.parse({ ...current.manifest, ...saved.patch });
      if (await sha256Hex(JSON.stringify(candidate)) !== saved.manifest_hash) throw new Error("invalid refresh checkpoint identity");
      if (!await store.replaceManifestIfCurrent(job.keyPrefix, sourceEtag, candidate)) return;
    }
    const committed = await liveTarget();
    if (!committed || await sha256Hex(JSON.stringify(committed.manifest)) !== saved.manifest_hash) return;
    await store.patchListNoveltyIf(job.readingId, saved.patch.novelty_verdict, async row =>
      row.status === "ready" && row.key_prefix === job.keyPrefix && await stillCurrent(committed.etag));
  };
  if (checkpoint?.run_at === runAt) {
    if (checkpoint.result) { await publish(checkpoint.result, checkpoint.source_etag); return; }
    if (checkpoint.retry_at_ms === null) { console.warn("relationship_refresh_dispatch_uncertain"); return; }
    const waitMs = checkpoint.retry_at_ms - Date.now();
    if (waitMs > 0) throw new DeferPaidWorkError(Math.ceil(waitMs / 1000));
  }
  if (Date.parse(original.manifest.connections_computed_at ?? "") >= Date.parse(runAt)) {
    logNoop("already_computed");
    return;
  }
  const list = (await store.readListIndex())?.items ?? [];
  const matches = await similarityStoreFor(env.READINGS_INDEX, tenant, env).queryByVectorId(job.readingId, REFRESH_CANDIDATE_TOP_K);
  if (matches === null) {
    logNoop("not_ready");
    return;
  }
  const row = { ...original.manifest, key_prefix: job.keyPrefix };
  const judgedAt = resolveJudgedAt(row);
  const reasons = diffNeighbourhood(row, matches, list, judgedAt.judged_at);
  if (reasons.length === 0) {
    logNoop("empty_diff");
    return;
  }
  const report = buildReportReading(row, matches, list, reasons, judgedAt);
  const neighbourVersions: SavedRefreshResult["neighbour_versions"] = [];
  for (const neighbour of report.current_neighbours) {
    const row = await store.findListIndexItem(neighbour.id);
    if (!row || row.status !== "ready") {
      logNoop("not_ready", { neighbourId: neighbour.id });
      return;
    }
    const stored = await store.readManifestWithEtag(row.key_prefix);
    if (!stored || stored.manifest.id !== neighbour.id || stored.manifest.status !== "ready") {
      logNoop("not_ready", { neighbourId: neighbour.id });
      return;
    }
    if (running(stored.manifest)) deferRunning("neighbour_running", neighbour.id);
    neighbourVersions.push({ id: neighbour.id, key_prefix: row.key_prefix, etag: stored.etag });
    // Describe the captured manifest version, not potentially lagging vector metadata.
    neighbour.title = stored.manifest.title;
    neighbour.tldr = stored.manifest.tldr;
    neighbour.tags = stored.manifest.tags;
  }
  const input = buildRelationshipJudgementInput(original.manifest, report, report.current_neighbours);
  const allowedIds = new Set(report.current_neighbours.map(n => n.id));
  if (!await neighboursUnchanged(neighbourVersions, true) || (await liveTarget(true))?.etag !== original.etag) {
    logNoop("not_ready");
    return;
  }
  const attemptId = `refresh:${job.readingId}:${runAt}`;
  const clock = () => Date.parse(services.now());
  const hold = throwIfDeferred(await acquireProcessingLeases(env, job.tenantId, attemptId, clock()));
  if (hold === "already_running") throw new DeferPaidWorkError();
  const stop = startProcessingLeaseHeartbeat(env, hold, clock);
  const owner = services.newId();
  try {
    const assertCurrent = async () => {
      if (!await stillCurrent(original.etag) || !await neighboursUnchanged(neighbourVersions)) throw new DOMException("refresh input changed", "AbortError");
      await presentLeaseBeforePaidDispatch(env, hold, clock);
    };
    let providerDispatched = false;
    const paidFetch = createPaidFetch({
      tenantId: job.tenantId, attemptId, stage: "summarize", fetch: (...args) => { providerDispatched = true; return services.fetch(...args); },
      rpc: spendRpcFor(env), now: Date.now, beforeDispatch: assertCurrent,
      onAuthorizedDispatch: async () => {
        await assertCurrent();
        // Revalidate after claiming: purge may have just removed its checkpoint.
        // Cleanup also covers a committed claim whose D1 response was lost.
        try {
          if (!await markRefreshDispatched(db, { tenantId: job.tenantId, readingId: job.readingId, runAt, owner, sourceEtag: original.etag })) throw new DOMException("refresh already dispatched", "AbortError");
          await assertCurrent();
        }
        catch (error) {
          // Before the first fetch this is a known unused claim. Later HTTP
          // retries must preserve uncertainty from an earlier provider attempt.
          if (!providerDispatched || !await store.findListIndexItem(job.readingId)) {
            await db.run("DELETE FROM relationship_refresh_jobs WHERE tenant_id = ? AND reading_id = ? AND owner = ?",
              job.tenantId, job.readingId, owner);
          }
          throw error;
        }
      },
    });
    const result = await judgeRelationships(input, {
      fetch: paidFetch, provider: env.SUMMARIZER_PROVIDER,
      openaiApiKey: env.OPENAI_API_KEY, openaiModel: env.OPENAI_SUMMARIZATION_MODEL,
      openaiReasoningEffort: env.OPENAI_SUMMARIZATION_REASONING_EFFORT,
      anthropicApiKey: env.ANTHROPIC_API_KEY, anthropicModel: env.ANTHROPIC_MODEL,
      anthropicReasoningEffort: env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT,
      retry: retryDepsFromEnv(env),
    });
    if (!await stillCurrent(original.etag) || !await neighboursUnchanged(neighbourVersions)) return;
    const merged = mergeRelationshipJudgement(original.manifest, result.judgement, allowedIds, services.now());
    if (!merged.ok) throw new Error(merged.error);
    const candidate = ManifestSchema.parse(merged.manifest);
    const saved = await saveRefreshResult(db, job.tenantId, job.readingId, owner, candidate, neighbourVersions);
    if (saved) await publish(saved, original.etag);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      await markRefreshRateLimited(db, job.tenantId, job.readingId, owner, Date.now() + Math.max(0, error.retryAfterMs ?? 30_000));
    }
    throw error;
  } finally {
    await stop();
    await releaseProcessingLeases(env, hold, clock());
  }
}
