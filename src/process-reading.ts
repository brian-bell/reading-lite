import { retryDepsFromEnv } from "./modules/http-retry";
import {
  buildKeyPrefix,
  PointerExistsError,
  readingStoreFor,
  type ReadingStore,
} from "./modules/stores/reading-store";
import {
  SimilarityStore,
  SIMILAR_TOP_K,
  SIMILARITY_FLOOR,
  aboveFloor,
  excludeSelf,
  similarityStoreFor,
  summarizeSimilarity,
} from "./modules/stores/similarity-store";
import { ReadingVisibility } from "./reading-visibility";
import { extractFromUrl, type ExtractedContent } from "./modules/extractor";
import { embed } from "./modules/embeddings";
import {
  summarizeReading,
  type SimilarContext,
  validateProcessingCredentials,
} from "./modules/summarizer";
import {
  summarizeCheckpoint,
} from "./modules/processing-checkpoint";
import { sendReadingEmail } from "./modules/email";
import { tenantIsActive, tenantIsDeleting } from "./control-plane/account-delete";
import { fromD1 } from "./control-plane/db";
import { redactEmailsInText } from "./control-plane/email";
import {
  itemRequestsImmediateEmail,
  resolveImmediateNotification,
} from "./control-plane/reading-notification";
import {
  failedManifest,
  readyManifest,
  rollForward,
} from "./modules/manifest-drafting";
import { normalizeTags } from "./modules/tags";
import { RateLimitedError, type RetryDeps } from "./modules/http-retry";
import type {
  Manifest,
  ManifestError,
  ProcessingAttempt,
  ProcessingAttemptSummary,
  ProcessingAttemptTrigger,
  ProcessingStage,
} from "./schemas/manifest";
import { commitReadingSlot, refreshReadingSlot, releaseReadingSlot } from "./control-plane/tenant-usage-guard";
import {
  acquireProcessingLeases,
  StaleProcessingLeaseError,
  presentLeaseBeforePaidDispatch,
  startProcessingLeaseHeartbeat,
  DeferPaidWorkError,
  pauseOrReleaseProcessingLeases,
  releaseProcessingLeases,
  clearOrphanedProcessingLeases,
  releaseHoldProvesDeadHolder,
  throwIfDeferred,
  peekProcessingLeaseReleaseHold,
  type ProcessingLeaseHold,
  type ProcessingLeaseReleaseHold,
} from "./control-plane/processing-leases";
import { createPaidFetch, spendRpcFor } from "./control-plane/paid-dispatch";
import { PROCESSING_DEFER_MAX_AGE_MS } from "./control-plane/constants";
import type { TenantContext } from "./control-plane/ids";
import {
  vectorLedgerFor,
  VectorLedgerWriteError,
  type VectorLedger,
} from "./control-plane/vector-ledger";
import type { Env } from "./index";
import type { Services } from "./services";
import { sha256Hex } from "./services";
import {
  attemptOwnership,
  resolveAttemptId,
  type ProcessReadingArgs,
  type ProcessReadingSource,
} from "./attempt-ownership";

export type { ProcessReadingArgs, ProcessReadingSource };

export async function processReading(
  args: ProcessReadingArgs,
  env: Env,
  services: Services,
  tenant: TenantContext,
): Promise<void> {
  const reader = readingStoreFor(env.READINGS_BUCKET, tenant, env);
  const similarity = similarityStoreFor(env.READINGS_INDEX, tenant, env);
  // The vector ledger travels with the vector store, and for the same reason:
  // an id recorded before every upsert is what keeps the vector addressable
  // once the reading's R2 objects are gone (issue #195 S3). Null without a
  // control plane, which is also the only configuration with no wipe to feed.
  const ledger = vectorLedgerFor(env, tenant);
  const attempt = newProcessingAttempt(args, services);
  const retry = retryDepsFromEnv(env);
  const tenantId = String(tenant.tenantId);
  const opId = resolveAttemptId(args);
  const clock = () => nowMs(services);
  let readingSlotConsumed = false;
  let leases: ProcessingLeaseHold | null = null;
  let stopHeartbeat: (() => Promise<void>) | null = null;

  try {
    // A purged reading must not get ANY object recreated — not even this
    // attempt log — so a stale queued message for it is dropped whole, before
    // any write or upstream spend. Conflict/takeover cases below still log
    // their attempt for diagnostics. A confirmed tombstone still sweeps
    // leftover attempt/checkpoint objects from a prior crashed delivery.
    // The purge check returns why: a confirmed tombstone is latched so a
    // later HEAD throw cannot skip the sweep (same class as
    // commitTerminalManifest's tombstone latch).
    const purged = await readingWasPurged(reader, args);
    if (purged) {
      await maybeSweepConfirmedTombstone(reader, args, {
        alreadyConfirmed: purged === "tombstone",
      });
      await releaseReadingSlot(env, tenantId, opId);
      // #256: a purged reading will never have a terminal manifest, so any
      // inFlight lease rows for this attempt are a dead holder's leftovers
      // with no other reclaim path. A live holder mid-paid-work here is also
      // served: its next presentLease fails stale and stops the spend on a
      // reading that no longer exists.
      await releaseOrphanedLeasesIfPresent(env, tenantId, opId, "purged_reading", clock);
      return;
    }
    // Account-deletion suppress (195a): a tenant already marked deleting must
    // not spend or write. A confirmed missing user is the same skip. A D1
    // lookup failure here is not inactive — it throws RateLimitedError so the
    // queue retries while extract/embed can still do useful work. After a
    // terminal CAS, lookup throws fail-open instead (see
    // tenantStillAllowsVisibility): retry cannot republish once
    // active_attempt is cleared.
    if (!(await tenantAllowsSpend(env, tenantId))) {
      await releaseReadingSlot(env, tenantId, opId);
      return;
    }
    await writeAttemptSafe(reader, args.keyPrefix, attempt);
    if (!(await readingCanWriteAttemptArtifacts(reader, args))) {
      await maybeSweepConfirmedTombstone(reader, args);
      await releaseReadingSlot(env, tenantId, opId);
      await releaseOrphanedLeasesIfReadingTerminal(reader, args, env, tenantId, clock);
      return;
    }
    validateProcessingCredentials({
      provider: env.SUMMARIZER_PROVIDER,
      openaiApiKey: env.OPENAI_API_KEY,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      openaiReasoningEffort: env.OPENAI_SUMMARIZATION_REASONING_EFFORT,
      anthropicReasoningEffort: env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT,
      anthropicModel: env.ANTHROPIC_MODEL,
    });

    const extracted = await extractSource(args, env, services, reader, attempt);

    await runStage(attempt, reader, args.keyPrefix, services, "write_raw", async () => {
      if (!(await readingCanWriteAttemptArtifacts(reader, args))) return;
      await reader.writeRaw(
        args.keyPrefix,
        extToken(extracted.content_type),
        extracted.raw,
        extracted.content_type,
      );
    });
    if (extracted.markdown) {
      await runStage(attempt, reader, args.keyPrefix, services, "write_extracted", async () => {
        if (!(await readingCanWriteAttemptArtifacts(reader, args))) return;
        await reader.writeExtracted(args.keyPrefix, extracted.markdown!);
      });
    }

    const promptText = extracted.markdown ?? `(non-text content; raw bytes saved at raw.${extToken(extracted.content_type)})`;

    // Foreign active_attempt must drop without taking a lease. Re-check after
    // extract (unpaid) and before the first paid dispatch.
    if (!(await readingCanWriteAttemptArtifacts(reader, args))) {
      await maybeSweepConfirmedTombstone(reader, args);
      await releaseReadingSlot(env, tenantId, opId);
      await releaseOrphanedLeasesIfReadingTerminal(reader, args, env, tenantId, clock);
      return;
    }

    const acquired = throwIfDeferred(await acquireProcessingLeases(env, tenantId, opId, clock()));
    if (acquired.kind === "release_only") {
      await recoverOrphanedLeases(reader, args, env, tenantId, services, attempt, acquired.hold, clock);
      return;
    }
    leases = acquired.hold;
    stopHeartbeat = startProcessingLeaseHeartbeat(env, acquired.hold, clock);
    await presentLeaseBeforePaidDispatch(env, acquired.hold, clock);

    const paidFetch = (stage: "embed_source" | "summarize" | "embed_summary") => createPaidFetch({
      tenantId, attemptId: opId, stage, fetch: services.fetch,
      // Spend admission uses wall time even when artifact timestamps are injected.
      rpc: spendRpcFor(env), now: Date.now,
      beforeDispatch: () => presentLeaseBeforePaidDispatch(env, acquired.hold, clock),
      onAuthorizedDispatch: async () => {
        if (stage !== "summarize") return;
        // Spend denial must not consume a reading slot. Commit only once the
        // request has dispatch permission and is about to be sent.
        if (!(await commitReadingSlot(env, tenantId, opId))) throw new DeferPaidWorkError();
        readingSlotConsumed = true;
      },
    });
    let checkpoint = (await reader.readProcessingCheckpoint(args.keyPrefix, opId)) ?? {};

    // Embed the extracted text to get top-K similar.
    const queryEmbed = await runStage(attempt, reader, args.keyPrefix, services, "embed_source", async () => {
      if (checkpoint.embed_source) return checkpoint.embed_source;
      const result = await embed(truncateForEmbed(promptText), {
        fetch: paidFetch("embed_source"),
        apiKey: env.OPENAI_API_KEY,
        retry,
      });
      checkpoint = { ...checkpoint, embed_source: result };
      await reader.writeProcessingCheckpoint(args.keyPrefix, opId, checkpoint);
      return result;
    });

    const cachedSummary = checkpoint.summarize;
    let similarContext: SimilarContext[];
    let similaritySnapshot: ReturnType<typeof summarizeSimilarity>;
    if (cachedSummary) {
      similarContext = cachedSummary.similar_context;
      similaritySnapshot = cachedSummary.similarity_snapshot;
    } else {
      const similar = await runStage(attempt, reader, args.keyPrefix, services, "query_similar", () =>
        // Over-fetch by one: on a reprocess this reading's own vector is already
        // indexed and would otherwise consume a slot (see excludeSelf).
        similarity.query(queryEmbed.embedding, SIMILAR_TOP_K + 1),
      );
      // Exclude self once. The snapshot then measures the UNFLOORED
      // neighbourhood, while only the prompt context is floored.
      //
      // That split is deliberate. The snapshot is a measurement: for a novel
      // reading whose nearest neighbour sits at 0.30, "nearest was 0.30" is the
      // useful fact, and flooring first would throw it away and record count 0.
      // The prompt is a judgement input: handing the model five distant titles
      // under a heading that presupposes relatedness is what made everything look
      // familiar, so those get dropped.
      const neighbours = excludeSelf(similar, args.id, SIMILAR_TOP_K);
      const related = aboveFloor(neighbours, SIMILARITY_FLOOR);
      similarContext = related.map((s) => ({
        id: s.id,
        url: s.url,
        ...(s.title === undefined ? {} : { title: s.title }),
        ...(s.tldr === undefined ? {} : { tldr: s.tldr }),
        score: s.score,
      }));
      similaritySnapshot = summarizeSimilarity(neighbours, services.now());
    }

    const llm = await runStage(
      attempt,
      reader,
      args.keyPrefix,
      services,
      "summarize",
      async () => {
        if (cachedSummary) {
          // commit_reading is idempotent for already-consumed slots. Call it
          // here too so a recovered artifact cannot hide an unavailable guard.
          if (!(await commitReadingSlot(env, tenantId, opId))) throw new DeferPaidWorkError();
          readingSlotConsumed = true;
          return { reading: cachedSummary.reading, usage: cachedSummary.usage };
        }
        await presentLeaseBeforePaidDispatch(env, acquired.hold, clock);
        const result = await summarizeReading(
          {
            url: args.url,
            extractedText: promptText,
            title: extracted.title,
            similarReadings: similarContext,
          },
          {
            fetch: paidFetch("summarize"),
            provider: env.SUMMARIZER_PROVIDER,
            openaiApiKey: env.OPENAI_API_KEY,
            openaiModel: env.OPENAI_SUMMARIZATION_MODEL,
            openaiReasoningEffort:
              env.OPENAI_SUMMARIZATION_REASONING_EFFORT,
            anthropicApiKey: env.ANTHROPIC_API_KEY,
            anthropicModel: env.ANTHROPIC_MODEL,
            anthropicReasoningEffort:
              env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT,
            retry,
          },
        );
        checkpoint = {
          ...checkpoint,
          summarize: summarizeCheckpoint(result, similarContext, similaritySnapshot),
        };
        await reader.writeProcessingCheckpoint(args.keyPrefix, opId, checkpoint);
        return result;
      },
    );

    // Embed the TL;DR for the persistent vector (more representative than the full text).
    await presentLeaseBeforePaidDispatch(env, acquired.hold, clock);
    const tldrEmbed = await runStage(attempt, reader, args.keyPrefix, services, "embed_summary", () =>
      embed(llm.reading.tldr, {
        fetch: paidFetch("embed_summary"),
        apiKey: env.OPENAI_API_KEY,
        retry,
      }),
    );

    attempt.status = "succeeded";
    attempt.finished_at = services.now();
    attempt.error = undefined;
    // ProcessReadingArgs satisfies ReadingIdentity structurally, and the full
    // ProcessingAttempt is stripped to its summary by the drafter's parse.
    const finalManifest = readyManifest(
      {
        identity: args,
        sourceType: sourceTypeForArgs(args),
        summary: llm.reading,
        similarity: similaritySnapshot,
        neighbourhoodIds: similarContext.map((neighbour) => neighbour.id),
        content: {
          content_type: extracted.content_type,
          content_status: extracted.content_status,
          content_bytes: extracted.content_bytes,
          content_sha256: extracted.content_sha256,
          ...(extracted.markdown
            ? { extracted_bytes: new TextEncoder().encode(extracted.markdown).byteLength }
            : {}),
          ...(extracted.enrichment_degradation === undefined
            ? {}
            : { enrichment_degradation: extracted.enrichment_degradation }),
        },
        usage: {
          summarization: llm.usage,
          openai_embedding_tokens:
            queryEmbed.usage.total_tokens + tldrEmbed.usage.total_tokens,
        },
        attempt,
      },
      services.now(),
    );
    await writeAttemptSafe(reader, args.keyPrefix, attempt);

    const { published } = await commitTerminalManifest(
      reader,
      similarity,
      args,
      finalManifest,
      {
        claimMissingPointer: true,
        defensive: false,
        ledger,
        tenantAllowsVisibility: () => tenantConfirmedAllowsVisibility(env, tenantId),
        tenantConfirmedDeleting: () => tenantConfirmedDeleting(env, tenantId),
        vector: {
          embedding: tldrEmbed.embedding,
          meta: {
            url: args.url,
            title: llm.reading.title,
            tldr: llm.reading.tldr,
            tags: normalizeTags(llm.reading.tags),
            created_at: args.createdAt,
          },
        },
        instrument: (stage, fn) =>
          runStage(attempt, reader, args.keyPrefix, services, stage, fn),
      },
    );

    if (published && itemRequestsImmediateEmail(args)) {
      await sendReadingEmailAndLog(
        reader,
        args,
        env,
        services,
        attempt,
        finalManifest,
        retry,
        tenant,
      );
    }
    await stopHeartbeat?.();
    stopHeartbeat = null;
    if (leases) await releaseProcessingLeases(env, leases, clock());
    leases = null;
  } catch (e) {
    await stopHeartbeat?.();
    stopHeartbeat = null;
    const clockNow = nowMs(services);
    if (e instanceof DeferPaidWorkError || e instanceof StaleProcessingLeaseError) {
      if (leases) await releaseProcessingLeases(env, leases, clockNow);
      leases = null;
      if (e instanceof StaleProcessingLeaseError) {
        try {
          const manifest = await reader.readManifest(args.keyPrefix);
          if (manifest?.status === "ready" || manifest?.status === "failed") return;
        } catch (err) {
          console.error(err);
        }
      }
      // LiveHolderDeferError carries an already_running holder whose death is
      // not proven; terminalizing it at the ceiling would clear active_attempt
      // under a provider request still in flight (#256). Defer instead.
      if (deferLoopExceeded(args, clockNow) && !(e instanceof LiveHolderDeferError)) {
        if (!readingSlotConsumed) {
          await releaseReadingSlot(env, tenantId, opId);
        }
        await markFailed(reader, args, services, attempt, new ProcessingDeferExpiredError(), env, tenantId);
        return;
      }
      await refreshReadingSlot(env, tenantId, opId, clockNow);
      throw e instanceof DeferPaidWorkError ? e : new DeferPaidWorkError();
    }
    if (e instanceof VectorLedgerWriteError) {
      // Fail closed on a ledger write, but do not destroy anything to do it.
      // The summarization is paid for and checkpointed; marking the reading
      // failed would throw that away over a control-plane blip. Requeue on the
      // same terms as a 429 instead: the retry re-uses the cached summary
      // rather than re-spending.
      //
      // The retry genuinely republishes because of WHERE the throw comes from.
      // `commitTerminalManifest` writes the ledger row ahead of the terminal
      // manifest, so at this point nothing terminal has landed: the manifest is
      // still pending, `active_attempt` is still this attempt's, and no vector
      // was upserted. The redelivery re-runs the whole terminal commit. (From
      // inside `ReadingVisibility.publish` it could not: `readyManifest` clears
      // `active_attempt`, so the retry would find `canWriteManifest === false`
      // and do nothing. Covered by the acceptance test in
      // `test/integration/account-delete-visibility.test.ts`.)
      console.error(
        JSON.stringify({
          event: "reading_ledger_write_failed",
          reading_id: args.id,
          tenant_id: tenantId,
          message: e.message,
          note: "terminal commit failed closed on the vector ledger; requeuing without marking the reading failed",
        }),
      );
      if (leases) await pauseOrReleaseProcessingLeases(env, leases, clockNow);
      throw e;
    }
    if (e instanceof RateLimitedError) {
      // Don't mark the manifest failed — the queue handler will requeue this
      // message after the upstream's Retry-After window. The active_attempt
      // stays "running" until either a future attempt succeeds or
      // PENDING_TTL_SECONDS flips it stale. Held reading-slot reservations
      // stay counted until a later delivery commits or a definitive failure
      // (including markDeadLettered after max_retries) releases them.
      // Processing leases stay held (paused, not released) so a 429 retry
      // resumes the same fence instead of taking a second permit. If pause
      // cannot park both guards, release so the retry is not pinned already_running.
      if (leases) await pauseOrReleaseProcessingLeases(env, leases, clockNow);
      throw e;
    }
    if (leases) await releaseProcessingLeases(env, leases, clockNow);
    if (!readingSlotConsumed) {
      await releaseReadingSlot(env, tenantId, opId);
    }
    await markFailed(reader, args, services, attempt, e, env, tenantId);
  }
}

// #256 orphaned inFlight lease recovery. A dead attempt's tenant+global rows
// are never swept (B1: sweeping inFlight would let a second paid start overlap
// the fence), so the deliveries that outlive it are the only automatic
// reclamation — plus the operator's compare-and-set clear. All three paths
// share one rule: the hold is release-only, and it fires only when the work is
// provably over (terminal manifest, purged reading) or provably abandoned
// (the 24h defer ceiling). Never on the say-so of a clock alone, and never
// while the manifest is unreadable.

// Shared tail: log the recovery (tenant, attempt, per-side age — no fences,
// credentials, or reading content), then clear ATOMICALLY. The compare-and-set
// rides the expiresAt each side was observed with, so a holder that renewed
// between observation and clear refuses instead of losing its rows to a
// check-then-act race.
async function releaseOrphanedLeases(
  env: Env,
  hold: ProcessingLeaseReleaseHold,
  reason: "terminal_manifest" | "defer_expired" | "purged_reading",
  nowMs: number,
): Promise<void> {
  logOrphanedLeaseRecovery(hold, reason, nowMs);
  // requireOverdue:false — the caller's proof is the work state (terminal
  // manifest or purged reading), not the row's remaining TTL. The decision is
  // deliberately ignored here: nothing downstream terminalizes on it, and a
  // refused (renewed) row belongs to a holder that releases its own.
  await clearOrphanedProcessingLeases(env, hold, undefined, { requireOverdue: false });
}

function logOrphanedLeaseRecovery(
  hold: ProcessingLeaseReleaseHold,
  reason: "terminal_manifest" | "defer_expired" | "purged_reading",
  nowMs: number,
): void {
  console.warn(
    JSON.stringify({
      event: "processing_lease_orphan_released",
      reason,
      tenant_id: hold.tenantId,
      attempt_id: hold.attemptId,
      tenant_lease_heartbeat_overdue_ms: Math.max(0, nowMs - hold.tenantExpiresAtMs),
      global_row_present: !hold.globalUnknown && hold.globalFence !== null,
      ...(hold.globalUnknown ? { global_row_unknown: true } : {}),
      ...(hold.globalExpiresAtMs === null
        ? {}
        : { global_lease_heartbeat_overdue_ms: Math.max(0, nowMs - hold.globalExpiresAtMs) }),
    }),
  );
}

// The acquire branch (#256): this delivery lost the race for its own attempt —
// the tenant row is inFlight, held by a delivery that is either still running
// (defer, never steal, never re-dispatch paid work) or dead. A release fires
// only when the work is provably over (production-terminal manifest) or the
// holder is provably dead (defer ceiling AND a lapsed heartbeat); anything
// else defers with the same delayed-send contract as lease contention.
async function recoverOrphanedLeases(
  reader: ReadingStore,
  args: ProcessReadingArgs,
  env: Env,
  tenantId: string,
  services: Services,
  attempt: ProcessingAttempt,
  hold: ProcessingLeaseReleaseHold,
  clock: () => number,
): Promise<void> {
  let manifest: Manifest | null = null;
  try {
    manifest = await reader.readManifest(args.keyPrefix);
  } catch (err) {
    // Uncertain manifest state proves neither work-over nor holder-death, so
    // defer WITHOUT terminalizing: a plain defer at the ceiling would mark
    // failed under a holder that may still be live. The next delivery re-runs
    // this decision once the read succeeds.
    console.error(err);
    throw new LiveHolderDeferError();
  }
  if (manifestIsProductionTerminal(manifest)) {
    await releaseOrphanedLeases(env, hold, "terminal_manifest", clock());
    return;
  }
  if (deferLoopExceeded(args, clock())) {
    // The ceiling measures the ATTEMPT's age since submit — parked, deferred,
    // and requeued time included — so an old attempt can have acquired fresh
    // rows and be live mid-paid-work when this duplicate arrives. Age alone
    // does not prove the holder is gone; a lapsed heartbeat does. Only a
    // provably-dead holder is terminalized here: terminalizing a live one
    // would clear active_attempt under a provider request still in flight,
    // and the next duplicate would then "recover" its live rows.
    if (!releaseHoldProvesDeadHolder(hold, clock())) {
      // The holder may be live. Defer WITHOUT terminalizing: a live holder
      // ends on its own (releasing its rows, or leaving a terminal manifest
      // the next duplicate releases), and a holder that died moments ago
      // goes overdue within one TTL, after which the next delivery clears
      // and terminalizes. Bounded, so the defer ceiling cannot spin forever.
      throw new LiveHolderDeferError();
    }
    // Clear atomically BEFORE the failed manifest (a death between the two
    // leaves the reading retryable, with the rows gone so the next delivery
    // acquires fresh and resumes from the checkpoint). The DO re-verifies the
    // observed expiresAt at delete time, so a holder that renewed after the
    // observation — the stalled-then-resumed race — refuses; the decision
    // gates the terminalization, so a refused clear defers like a fresh row.
    // The reverse ordering would be worse: terminalizing first re-orphans the
    // rows on a death between the two writes. The accepted residual of this
    // ordering: a concurrent duplicate that re-acquires the now-free rows in
    // this ms-wide window resumes the attempt (checkpoint-cached, no re-pay of
    // finished stages) and its terminal commit loses to this failed manifest
    // under the same ownership fences — last-writer-wins, bounded by the
    // checkpoint, and the reading stays re-submittable.
    const cleared = await clearOrphanedProcessingLeases(env, hold);
    if (!cleared.ok) {
      throw new LiveHolderDeferError();
    }
    logOrphanedLeaseRecovery(hold, "defer_expired", clock());
    // This delivery never dispatched paid work, so its slot is uncommitted;
    // release is idempotent for a slot the dead holder already consumed.
    await releaseReadingSlot(env, tenantId, hold.attemptId);
    await markFailed(reader, args, services, attempt, new ProcessingDeferExpiredError(), env, tenantId);
    return;
  }
  throw new DeferPaidWorkError();
}

// The already_running defer whose holder is not provably dead. Subclasses
// DeferPaidWorkError so the queue handler defers it exactly like contention,
// but tells processReading's own catch that the defer ceiling must NOT
// terminalize: the rows belong to a delivery that may still be running, and
// terminalizing it would manufacture exactly the terminal-manifest-under-a-
// live-holder state the recovery paths must never feed on.
class LiveHolderDeferError extends DeferPaidWorkError {}

// The one definition of "the work is provably over": a production terminal
// manifest. `readyManifest`/`failedManifest` clear `active_attempt`, so its
// absence plus a terminal status is the finished shape. A ready/failed status
// WITH an active_attempt is a reprocess in flight (`reprocessPending` keeps
// the ready manifest and adds a running attempt) — its holder may be live
// mid-paid-work, so it is NOT terminal for release purposes.
function manifestIsProductionTerminal(manifest: Manifest | null): boolean {
  return (
    manifest !== null &&
    manifest.active_attempt === undefined &&
    (manifest.status === "ready" || manifest.status === "failed")
  );
}

// The canWrite-false early returns (#256): a TERMINAL production manifest
// (readyManifest clears active_attempt) never reaches acquire, so a leftover
// inFlight row for this attempt is released here. A FOREIGN active_attempt
// (conflict) must NOT release — that row's holder can be alive mid-paid-work,
// and its rows are not this delivery's to clear. Terminality must be read
// successfully; an unreadable manifest touches nothing.
async function releaseOrphanedLeasesIfReadingTerminal(
  reader: ReadingStore,
  args: ProcessReadingArgs,
  env: Env,
  tenantId: string,
  clock: () => number,
): Promise<void> {
  let terminal = false;
  try {
    terminal = manifestIsProductionTerminal(await reader.readManifest(args.keyPrefix));
  } catch (err) {
    console.error(err);
    return;
  }
  if (!terminal) return;
  await releaseOrphanedLeasesIfPresent(env, tenantId, resolveAttemptId(args), "terminal_manifest", clock);
}

// Peek-then-release for paths that never acquired: absent or non-inFlight
// tenant rows are a no-op, so this is safe to call on every qualifying
// early return.
async function releaseOrphanedLeasesIfPresent(
  env: Env,
  tenantId: string,
  opId: string,
  reason: "terminal_manifest" | "purged_reading",
  clock: () => number,
): Promise<void> {
  const hold = await peekProcessingLeaseReleaseHold(env, tenantId, opId);
  if (hold) await releaseOrphanedLeases(env, hold, reason, clock());
}


export class ProcessingDeferExpiredError extends Error {
  constructor() {
    super("processing defer loop exceeded PROCESSING_DEFER_MAX_AGE_MS");
    this.name = "ProcessingDeferExpiredError";
  }
}

function nowMs(services: Services): number {
  const parsed = Date.parse(services.now());
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function deferLoopExceeded(args: ProcessReadingArgs, now: number): boolean {
  const origin = Date.parse(args.attemptStartedAt ?? args.createdAt);
  if (!Number.isFinite(origin)) return false;
  return now - origin > PROCESSING_DEFER_MAX_AGE_MS;
}


async function sendReadingEmailAndLog(
  reader: ReadingStore,
  args: ProcessReadingArgs,
  env: Env,
  services: Services,
  attempt: ProcessingAttempt,
  manifest: Manifest,
  retry: RetryDeps,
  tenant: TenantContext,
): Promise<void> {
  const startedAt = services.now();
  let recipient: string | undefined;
  try {
    // Recipient lookup belongs in this try: a thrown D1/settings read after
    // commitTerminalManifest must not reach processReading's outer catch and
    // overwrite the published ready manifest.
    const decision = await resolveImmediateNotification(
      fromD1(env.CONTROL_PLANE),
      env,
      String(tenant.tenantId),
    );
    if (decision.kind === "skip") return;
    recipient = decision.to;

    // Tenant-scoped list index: connection titles/links stay in this tenant.
    const listIndex = await reader.readListIndex();
    await sendReadingEmail(
      { manifest, webBaseUrl: env.WEB_BASE_URL, listIndex },
      {
        fetch: services.fetch,
        apiKey: env.RESEND_API_KEY,
        from: decision.from,
        to: decision.to,
        retry,
      },
    );
    const finishedAt = services.now();
    const durationMs = durationMsBetween(startedAt, finishedAt);
    attempt.events.push({
      stage: "send_email",
      status: "succeeded",
      at: finishedAt,
      ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    });
  } catch (e) {
    // Email failure must NOT poison the manifest — the reading stays `ready`.
    // Do not requeue the whole job. Recovery is a manual reprocess with email=true.
    const failedAt = services.now();
    const durationMs = durationMsBetween(startedAt, failedAt);
    const error = redactSendEmailError(errorFromUnknown(e, "send_email", failedAt), [
      ...(recipient === undefined ? [] : [recipient]),
      env.EMAIL_FROM,
    ]);
    console.error(
      JSON.stringify({
        event: "send_email_failed",
        error: error.code,
        message: error.message,
      }),
    );
    attempt.events.push({
      stage: "send_email",
      status: "failed",
      at: failedAt,
      ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
      error,
    });
  }
  await writeAttemptSafe(reader, args.keyPrefix, attempt);
}

function redactSendEmailError(error: ManifestError, known: readonly string[]): ManifestError {
  return {
    ...error,
    message: redactEmailsInText(
      error.message,
      known.filter((value) => value.trim().length > 0),
    ),
  };
}

// Thrown only on the dead-letter path: the message exhausted its main-queue
// retries (the upstream stayed rate-limited past the retry budget). Retryable —
// re-submitting later, once the rate-limit window has reset, is the recovery.
export class QueueRetriesExhaustedError extends Error {
  constructor() {
    super("queue delivery retries exhausted (upstream stayed rate-limited)");
    this.name = "QueueRetriesExhaustedError";
  }
}

// Convert a dead-lettered message into a visible, retryable `failed` manifest.
// Reuses markFailed so a reprocess of a previously-`ready` reading rolls back to
// its preserved snapshot rather than nuking good data, and the list index stays
// in sync. The mark requires the manifest to exist in the admitted tenant's
// namespace and the attempt to still be active — see the guards below.
export async function markDeadLettered(
  args: ProcessReadingArgs,
  env: Env,
  services: Services,
  tenant: TenantContext,
): Promise<void> {
  const reader = readingStoreFor(env.READINGS_BUCKET, tenant, env);
  // Only a read that successfully resolves to null is evidence of absence. A
  // throwing read (R2 error, corrupt JSON, schema drift) is an object that may
  // well exist — the DLQ message is acked either way, so skipping on a failed
  // read would silently strand the reading; fall through and mark, as the
  // pre-guard behavior did.
  let existing: Manifest | null = null;
  let confirmedAbsent = false;
  try {
    existing = await reader.readManifest(args.keyPrefix);
    confirmedAbsent = existing === null;
  } catch (e) {
    console.error(e);
  }

  // A manifest absent from the admitted tenant's namespace means this tenant
  // never owned the reading the job describes: activation always writes the
  // pending manifest before enqueueing, so absence signals a mismatched
  // envelope or a reading an operator has since deleted. Writing a marker here
  // would materialize envelope-controlled metadata as a visible row in the
  // tenant's list (or resurrect deleted data), so the mark requires the
  // manifest to exist. A URL stranded this way stays recoverable: its damaged
  // by-url pointer is repaired by the next submit/import.
  const tenantId = String(tenant.tenantId);
  const opId = resolveAttemptId(args);

  // Purge tombstone before confirmed-absent: after purge deletes the
  // manifest, a DLQ still has to reap attempt/checkpoint residue. Checking
  // absence first would skip the sweep once by-id is gone.
  if (await confirmedPurgeTombstone(reader, args.id)) {
    await sweepTombstonePrefixDefensively(reader, args.keyPrefix);
    await releaseReadingSlot(env, tenantId, opId);
    return;
  }

  // Confirmed-absent: this attempt will never commit. Release a still-held
  // reservation (idempotent if already consumed/released).
  if (confirmedAbsent) {
    await releaseReadingSlot(env, tenantId, opId);
    return;
  }

  // Account-deletion suppress (195a): do not write a failed list row after
  // the tenant is already deleting. handleDeadLetter always acks and never
  // retries, so a lookup throw must fail-open and proceed to markFailed —
  // treating it as inactive would strand pending+running. Only skip on a
  // confirmed inactive/missing user.
  if (!(await tenantConfirmedAllowsVisibility(env, tenantId))) {
    await releaseReadingSlot(env, tenantId, opId);
    return;
  }

  // A rate-limited message can sit in the retry→DLQ pipeline for many minutes.
  // If the original pending attempt was flipped stale by PENDING_TTL_SECONDS in
  // that window and a *newer* attempt took over the reading (or already brought
  // it back to `ready`), this dead-lettered message is stale: marking it failed
  // — and especially rolling back to its preserveReadyManifest snapshot — would
  // clobber the newer attempt's data. Only act if we still own the active
  // attempt.
  //
  // This narrows, but doesn't fully close, the window: a brand-new reprocess
  // landing between this read and markFailed's write would still be clobbered.
  // That residual race is last-writer-wins (the repo's documented stance) and
  // benign — the loser is a reading that is being reprocessed anyway and stays
  // re-submittable through its existing by-url ownership claim.
  // Strict active-only ownership: a newer attempt taking over (active flipped to
  // a different id) means this DLQ message is stale and must not clobber it.
  // (null here is the read-error path, where ownership cannot be judged.)
  if (existing && !attemptOwnership(existing, args).isActive) {
    await releaseReadingSlot(env, tenantId, opId);
    return;
  }

  const attempt = newProcessingAttempt(args, services);
  if (existing?.active_attempt?.stage) attempt.stage = existing.active_attempt.stage;
  await markFailed(reader, args, services, attempt, new QueueRetriesExhaustedError(), env, tenantId);
  // RateLimitedError keeps the slot held through retries; exhausting them is
  // the definitive pre-summarization failure that must release it. release is
  // a no-op if summarization already committed the reservation.
  await releaseReadingSlot(env, tenantId, opId);
}

async function markFailed(
  reader: ReadingStore,
  args: ProcessReadingArgs,
  services: Services,
  attempt: ProcessingAttempt,
  e: unknown,
  env: Env,
  tenantId: string,
): Promise<void> {
  console.error(e);
  // Same no-recreate gate as markDeadLettered: a mid-flight purge after
  // processReading's opening readingWasPurged check must not write an attempt
  // log or failed manifest under the prefix. Sweep residue already written.
  // Fail-open on a throwing HEAD.
  if (await confirmedPurgeTombstone(reader, args.id)) {
    await sweepTombstonePrefixDefensively(reader, args.keyPrefix);
    await releaseReadingSlot(env, tenantId, resolveAttemptId(args));
    return;
  }
  const failedAt = services.now();
  const error = errorFromUnknown(e, attempt.stage, failedAt);
  attempt.status = "failed";
  attempt.finished_at = failedAt;
  attempt.error = error;
  await writeAttemptSafe(reader, args.keyPrefix, attempt);

  const tenantAllowsVisibility = () => tenantConfirmedAllowsVisibility(env, tenantId);
  // Both commits below pass `similarity: null`, where the fence and the ordinary
  // removal do the same thing (list row only — the failure-path asymmetry). This
  // is passed for uniformity, not because the failure path is fenced; its only
  // effect there is one more D1 read on a compensation that was already rare.
  const confirmedDeleting = () => tenantConfirmedDeleting(env, tenantId);

  if (args.preserveReadyManifest?.status === "ready") {
    // preserveReadyManifest is the snapshot the router captured BEFORE writing
    // a pending+running manifest for the reprocess attempt. On failure we roll
    // forward to that snapshot so the user keeps the previously-ready data.
    const manifest = rollForward(args.preserveReadyManifest, attempt, services.now());
    // similarity: null → list-only visibility (the failure-path asymmetry).
    await commitTerminalManifest(reader, null, args, manifest, {
      claimMissingPointer: false,
      allowLastAttempt: true,
      defensive: true,
      tenantAllowsVisibility,
      tenantConfirmedDeleting: confirmedDeleting,
    });
    return;
  }

  const sourceTypeOnFailure = await resolveSourceTypeOnFailure(reader, args);
  // content omitted → the empty-content placeholder with content_status
  // "failed": on this path extraction may never have happened.
  const manifest = failedManifest(
    args,
    { sourceType: sourceTypeOnFailure, error, attempt },
    services.now(),
  );
  // We're already on the failure path inside the queue consumer — a transient
  // R2 hiccup here has nowhere to bubble to (dispatchQueueMessage will ack
  // either way). The defensive write logs and moves on; the index TTL annotator
  // will eventually flip stale pending entries even if both writes drop.
  await commitTerminalManifest(reader, null, args, manifest, {
    claimMissingPointer: false,
    allowLastAttempt: true,
    defensive: true,
    tenantAllowsVisibility,
    tenantConfirmedDeleting: confirmedDeleting,
  });
  // Intentionally do NOT change the by-url pointer here. URL submission claims
  // ownership eagerly; a failed owner stays re-submittable because POST
  // resolves failed ownership by reprocessing this same reading id.
}

async function resolveSourceTypeOnFailure(
  reader: ReadingStore,
  args: ProcessReadingArgs,
): Promise<"url" | "markdown"> {
  if (args.sourceTypeOnFailure) return args.sourceTypeOnFailure;

  // Queue messages already in flight when sourceTypeOnFailure was introduced
  // do not carry the snapshot. A reprocess pending manifest retains the prior
  // source type, so recover it only while this attempt still owns that manifest.
  if (args.trigger === "reprocess") {
    const current = await reader.readManifest(args.keyPrefix).catch(() => null);
    if (current && attemptOwnership(current, args).isActive) {
      return current.source_type ?? "url";
    }
  }

  return sourceTypeForArgs(args);
}

export async function newReadingArgs(
  url: string,
  services: Services,
  source?: ProcessReadingSource,
): Promise<ProcessReadingArgs> {
  const id = services.newId();
  const createdAt = services.now();
  const keyPrefix = buildKeyPrefix(id, createdAt);
  const urlHash = await sha256Hex(url);
  return { id, url, urlHash, createdAt, keyPrefix, source };
}

async function extractSource(
  args: ProcessReadingArgs,
  env: Env,
  services: Services,
  reader: ReadingStore,
  attempt: ProcessingAttempt,
): Promise<ExtractedContent> {
  const source = args.source;
  if (source?.kind === "markdown") {
    return runStage(
      attempt,
      reader,
      args.keyPrefix,
      services,
      "prepare_markdown",
      () => extractedFromMarkdown(source),
    );
  }

  return runStage(attempt, reader, args.keyPrefix, services, "fetch_source", () =>
    extractFromUrl(args.url, {
      fetch: services.fetch,
      lookup: services.lookup,
      timeoutMs: parseIntEnv(env.FETCH_TIMEOUT_MS, 20_000),
      maxBytes: parseIntEnv(env.FETCH_MAX_BYTES, 10 * 1024 * 1024),
      retry: retryDepsFromEnv(env),
      xBearerToken: env.X_API_BEARER_TOKEN,
      now: () => Date.parse(services.now()),
    }),
  );
}

async function extractedFromMarkdown(
  source: Extract<ProcessReadingSource, { kind: "markdown" }>,
): Promise<ExtractedContent> {
  const raw = new TextEncoder().encode(source.markdown);
  return {
    raw,
    content_type: "text/markdown; charset=utf-8",
    content_status: "captured",
    content_bytes: raw.byteLength,
    content_sha256: await sha256Hex(source.markdown),
    markdown: source.markdown,
    title: source.title,
  };
}

function sourceTypeForArgs(args: ProcessReadingArgs): "url" | "markdown" {
  return args.source?.kind === "markdown" ? "markdown" : "url";
}

interface TerminalWriteState {
  canWriteManifest: boolean;
  canPublishVisibility: boolean;
  canRemoveVisibility: boolean;
  manifestEtag?: string;
}

export interface CommitTerminalOpts {
  claimMissingPointer: boolean;
  // The durable vector-id ledger (issue #195 S3). Passed wherever a vector may
  // be written or deleted; omitted on the pure-failure paths, which pass a null
  // similarity store and touch no vector at all.
  ledger?: VectorLedger | null;
  allowLastAttempt?: boolean;
  // false: write throws propagate (success path → outer catch marks failed).
  // true: throws are swallowed + logged (failure path has nowhere to bubble).
  defensive: boolean;
  // Provided only when publishing a vector; omitted on failure paths.
  vector?: {
    embedding: number[];
    meta: { url: string; title: string; tldr: string; tags: string[]; created_at: string };
  };
  // The success path passes a runStage-bound closure so each sub-write still logs
  // a stage event; failure paths omit it and write plainly.
  instrument?: <T>(stage: ProcessingStage, fn: () => Promise<T>) => Promise<T>;
  // Rechecked immediately before visibility publish / restore, and again
  // immediately after those writes (issue 195a). Per-reading purge tombstones
  // (#179) share one confirmed-tombstone latch for the call, including the
  // checks immediately before by-url reclaim, the terminal write / markLive,
  // and publish. A confirmed tombstone skips reclaim and the terminal write
  // and sweeps prefix objects (attempt residue or a terminal that raced
  // purge) before list/vector/by-url compensate, including when
  // canWriteManifest is already false after purge removed the manifest. A confirmed false after
  // publish/restore compensates with remove and
  // releases by-url if this reading still owns the slot. A lookup throw is
  // not confirmed inactive: fail-open (publish/keep) because readyManifest
  // already cleared active_attempt and a retry cannot republish — unless this
  // call already confirmed a tombstone, which stays latched. Omit
  // tenantAllowsVisibility to keep the historical default (allow publish).
  tenantAllowsVisibility?: () => Promise<boolean>;
  // Narrower than `!tenantAllowsVisibility()`: true only for a tenant confirmed
  // `deleting`, which is the only status an account wipe runs for and therefore
  // the only one that justifies the fence's ungated vector delete. A `suspended`
  // tenant, a confirmed-missing row, or a failed lookup all take the ordinary
  // gated removal instead. Omit to keep the historical behavior (never fence).
  tenantConfirmedDeleting?: () => Promise<boolean>;
}

// The single home of the terminal-write ordering invariant: CAS-write the
// manifest, then reconcile list + vector visibility, restoring on a lost CAS.
// All three call sites (success, markFailed preserve, markFailed normal) funnel
// through here so none of them re-spells the ordering or touches the private
// TerminalWriteState booleans.
//
// `similarity` is null on the failure paths, which encodes the deliberate
// success/failure asymmetry: success removal clears list AND vector, failure
// removal clears list only (see plan 006 for the related cleanup-gate bug).
//
// Returns `published` so the caller can gate post-commit side effects (the
// success path only emails when the reading became publicly visible). `committed`
// is observability for tests (the plan's documented contract); production callers
// gate on `published` only, so don't treat `committed` as a load-bearing signal.
export async function commitTerminalManifest(
  reader: ReadingStore,
  similarity: SimilarityStore | null,
  args: ProcessReadingArgs,
  manifest: Manifest,
  opts: CommitTerminalOpts,
): Promise<{ committed: boolean; published: boolean }> {
  const run =
    opts.instrument ?? (<T>(_stage: ProcessingStage, fn: () => Promise<T>) => fn());
  const visibility = new ReadingVisibility(reader, similarity, opts.ledger ?? null);
  // Confirmed-tombstone compensate always sweeps the reading prefix, then
  // list/vector/by-url. writeAttemptSafe and stage instrumentation can
  // recreate attempt objects even when this CAS does not land; a successful
  // CAS that raced purge recreates the terminal object. Ordinary (non-
  // tombstone) visibility compensate does not sweep.
  const compensateFence = (tombstone: boolean) =>
    tombstone
      ? compensateTombstonePrefixAndVisibility(visibility, reader, args, opts)
      : compensateVisibility(visibility, reader, args, opts, { tombstone: false });

  // Purge-tombstone checks share one latch for this call. A confirmed HEAD
  // must not be undone by a later throw: fail-open after skip-markLive would
  // upsert a vector with no live ledger row (publish does not markLive). The
  // same latch gates by-url reclaim inside terminalWriteState: claiming a
  // pointer purge already released would pin the URL to a ghost reading.
  const tombstoneAllows = purgeTombstoneAllows(reader, args);
  const state = await terminalWriteState(reader, args, {
    claimMissingPointer: opts.claimMissingPointer,
    allowLastAttempt: opts.allowLastAttempt,
    tombstoneAllows,
  });
  // Active-attempt conflict: a foreign attempt owns the reading. No writes, no
  // restore — the other attempt owns visibility too. This unifies the two old
  // call sites: the success path already early-returned here, but the failure
  // path used to fall through writeManifestForTerminalState (which returns false
  // on conflict) into a list re-sync (now ReadingVisibility.restoreIfOwner) of
  // the foreign row.
  // That re-sync was a no-op on data the owning attempt maintains anyway;
  // skipping it is intentional (plan 005, case 2).
  // After purge removes the manifest and by-id/list, this attempt cannot
  // write a terminal object but may already have written attempt/checkpoint
  // residue during a long stage. Sweep that prefix when a tombstone is
  // confirmed. A foreign live attempt without a tombstone is left alone.
  if (!state.canWriteManifest) {
    if (!(await tombstoneAllows())) {
      await reconcileVisibility(true, () => compensateFence(true));
    }
    return { committed: false, published: false };
  }

  // Confirmed tombstone before the terminal write: do not recreate a ready (or
  // failed) object under a prefix purge is sweeping. Sweep prefix objects
  // (attempt residue) then list/vector/by-url. Defensive so a compensate throw
  // cannot reach markFailed and recreate objects that way either.
  if (!(await tombstoneAllows())) {
    await reconcileVisibility(true, () => compensateFence(true));
    return { committed: false, published: false };
  }

  // Ledger the reading BEFORE the terminal manifest write, not inside the
  // visibility publish that follows it.
  //
  // The ordering the ledger needs is only "row before upsert", and doing it
  // here satisfies that a fortiori: row, then manifest, then upsert. What the
  // earlier placement could not do was FAIL usefully. `readyManifest` clears
  // `active_attempt`, so once the terminal manifest is committed no retry can
  // republish — `readingCanWriteAttemptArtifacts` returns early and
  // `terminalWriteState` computes `canWriteManifest === false`. A ledger error
  // thrown after that point left a reading permanently `ready` and listed with
  // no vector and no ledger row, while the retry it triggered quietly did
  // nothing. Thrown from here, `active_attempt` is still live, so the ordinary
  // retry re-runs the whole terminal commit and republishes for real.
  //
  // The cost is a row for a reading whose manifest CAS then loses to a foreign
  // attempt: an id recorded for a vector this attempt never wrote. That is the
  // documented safe direction — one no-op `deleteByIds` that clears on the
  // first confirmation — and the same trade the wipe's own seed step makes.
  //
  // Deliberately NOT wrapped in `run`: the stage instrument writes one attempt
  // object per call, and this write has no stage of its own — the `upsert_vector`
  // event still comes from the upsert it precedes. Wrapping it would add a
  // second event for a stage that then runs anyway.
  //
  // Tombstone already confirmed false above; a later HEAD throw stays latched.
  if (opts.vector && similarity && opts.ledger) {
    await opts.ledger.markLive([args.id], Date.now());
  }

  const written = await run("write_manifest", () =>
    opts.defensive
      ? writeTerminalManifestDefensively(reader, args, manifest, state)
      : writeManifestForTerminalState(reader, args, manifest, state),
  );
  if (!written) {
    // Manifest not written despite owning the attempt: a lost CAS (etag changed
    // mid-flight) on either path, or — on the defensive path only — a swallowed
    // write throw. Restore the current list visibility so we don't leave a
    // half-published row behind — unless the tenant-deletion fence or a
    // per-reading purge tombstone forbids resurrection (issue 195a / #179).
    const tombstone = !(await tombstoneAllows());
    if (!tombstone && (await tenantStillAllowsVisibility(opts))) {
      await reconcileVisibility(opts.defensive, () =>
        visibility.restoreIfOwner(args),
      );
      // Deletion can land between the pre-restore check and the list write.
      // Compensate in this same consumer; do not wait on DELETE /api/account
      // or a retried purge.
      const tombstoneAfter = !(await tombstoneAllows());
      if (tombstoneAfter || !(await tenantStillAllowsVisibility(opts))) {
        // Tombstone compensate must stay defensive even on the success path
        // (`opts.defensive === false`): a throw here would reach markFailed
        // and recreate attempt/manifest objects under a purged prefix.
        await reconcileVisibility(tombstoneAfter ? true : opts.defensive, () =>
          compensateFence(tombstoneAfter),
        );
      }
    } else if (tombstone) {
      await reconcileVisibility(true, () => compensateFence(true));
    }
    return { committed: false, published: false };
  }

  // Recheck immediately after the terminal CAS. A tombstone that landed
  // between the pre-write HEAD and this write recreates objects under a
  // prefix purge already swept. Visibility compensate cannot reap those
  // objects, and by-id is usually already gone, so DELETE /api/readings/:id
  // returns not_found. Defensive: a throw must not reach markFailed.
  if (!(await tombstoneAllows())) {
    await reconcileVisibility(true, () => compensateFence(true));
    return { committed: true, published: false };
  }

  // The terminal object is committed. Visibility throws must not reach
  // processReading's outer catch: markFailed(allowLastAttempt) would overwrite
  // ready with failed. Same class of bug sendReadingEmailAndLog already avoids.
  if (state.canPublishVisibility) {
    // Recheck immediately before publish: an in-flight consumer can pause
    // between terminal CAS and this write. Account deletion marks
    // users.status=deleting as the durable fence (195a). Per-reading purge
    // writes index/deleted/{id} and this path rechecks it here (#179).
    const tombstone = !(await tombstoneAllows());
    if (!tombstone && (await tenantStillAllowsVisibility(opts))) {
      const published = await reconcileVisibility(true, () =>
        visibility.publish(manifest, args, opts.vector, { instrument: run }),
      );
      // Check-then-publish is still a race; recheck after the writes and
      // compensate in this same consumer if the tenant is now deleting or the
      // reading now has a purge tombstone. On a confirmed-`deleting` tenant
      // (or a confirmed tombstone) that compensation deletes the vector
      // directly rather than routing through the list row: an account wipe may
      // already have deleted `index/list.json`, and a vector left behind after
      // that is unaddressable, because R2 is the only source of reading ids.
      // Ordinary `remove` skips the vector when the list row is already gone;
      // `removeForDeletedTenant` does not.
      const tombstoneAfter = !(await tombstoneAllows());
      if (tombstoneAfter || !(await tenantStillAllowsVisibility(opts))) {
        await reconcileVisibility(true, () => compensateFence(tombstoneAfter));
        return { committed: true, published: false };
      }
      return { committed: true, published };
    }
    await reconcileVisibility(true, () => compensateFence(tombstone));
    return { committed: true, published: false };
  }

  // Unpublish because this reading is not the by-url owner, not because of any
  // tenant status — but it routes through the same helper, which falls back to
  // the gated `remove` unless the tenant is confirmed `deleting` or a purge
  // tombstone is confirmed. On a deleting tenant this branch strands a vector
  // exactly like the others do: the wipe may already have taken
  // `index/list.json`, and `remove` gives up when there is no row to remove.
  if (state.canRemoveVisibility) {
    const tombstone = !(await tombstoneAllows());
    await reconcileVisibility(true, () => compensateFence(tombstone));
  }
  return { committed: true, published: false };
}

// Visibility reconciliation honors `defensive`: log-and-continue so a transient
// R2 hiccup cannot clobber a committed terminal object (or, on the failure
// path, bubble out of a consumer that will ack either way). Before the
// terminal CAS, the success path still lets throws propagate to the outer catch.
async function reconcileVisibility(
  defensive: boolean,
  fn: () => Promise<void>,
): Promise<boolean> {
  if (!defensive) {
    await fn();
    return true;
  }
  try {
    await fn();
    return true;
  } catch (e) {
    // The defensive policy exists for writes a later pass repairs: a list row
    // that did not land is re-appended by the next terminal write, a vector
    // that did not upsert is restored by `ops corpus backfill-vectors`. Both
    // are visible and both self-heal, so swallowing them is right — the
    // manifest is already committed and failing the reading over them would
    // throw away paid work for a repairable gap.
    //
    // A LEDGER write is not in that class. Nothing repairs it on its own and
    // nothing reports it, so it fails closed and the delivery retries (see the
    // outer catch, which requeues without marking the reading failed — the
    // cached summarization means the retry costs nothing).
    //
    // The publish half no longer reaches here: `commitTerminalManifest` writes
    // the `live` row before the terminal manifest, outside this wrapper and
    // outside the defensive policy, precisely so its failure is retryable. What
    // still arrives here is the removal verbs' `delete_submitted` stamp. Losing
    // that stamp leaves the row `live` for a vector already deleted, which the
    // wipe re-submits harmlessly — but it is still an unreported divergence in
    // the tenant's vector record, so it takes the same fail-closed treatment.
    if (e instanceof VectorLedgerWriteError) throw e;
    console.error(e);
    return false;
  }
}

// The removal a compensating consumer performs. `deleting` is the only status
// an account wipe runs for, so it is the only tenant status where the list row
// and manifest the ordinary gates read may already be gone — and therefore the
// only one where dropping the vector ungated is right. A confirmed purge
// tombstone is the per-reading equivalent: the list row may already be gone
// because purge removed it, so ordinary `remove` would skip the vector.
// Tombstone compensation also releases this reading's by-url pointer when it
// still owns the slot: list+vector-only cleanup would leave a ghost owner
// that later submit treats as a live reading. Tenant-deletion still uses
// `removeForDeletedTenant` alone (wipe owns that prefix).
// Every other reason visibility stopped being allowed (suspended, a
// confirmed-missing row, or a lookup we could not confirm) takes the gated
// removal this code has always used.
async function compensateVisibility(
  visibility: ReadingVisibility,
  reader: ReadingStore,
  args: ProcessReadingArgs,
  opts: CommitTerminalOpts,
  fence: { tombstone: boolean },
): Promise<void> {
  if (fence.tombstone) {
    // By-url first (ghost owner), but a pointer-delete throw must not skip
    // list / vector / ledger compensate. Same class as prefix-delete finally.
    try {
      await releaseByUrlIfOwned(reader, args);
    } finally {
      await visibility.removeForDeletedTenant(args);
    }
    return;
  }
  if (await tenantConfirmedDeletingForOpts(opts)) {
    await visibility.removeForDeletedTenant(args);
    return;
  }
  await visibility.remove(args);
}

// Confirmed-tombstone compensate: drop prefix objects (manifest, attempts,
// raw/extracted) then list/vector/by-url. Used after a terminal CAS that
// raced purge, and on skip-write / lost-CAS — writeAttemptSafe and stage
// instrumentation can recreate attempt objects even when this CAS does not
// land, and by-id is usually already gone so those objects are unreapable.
async function compensateTombstonePrefixAndVisibility(
  visibility: ReadingVisibility,
  reader: ReadingStore,
  args: ProcessReadingArgs,
  opts: CommitTerminalOpts,
): Promise<void> {
  // Objects first (unreapable residue), but a prefix-delete throw must not
  // skip by-url / list / vector / ledger compensate. The caller still wraps
  // this in defensive reconcileVisibility.
  try {
    await reader.deleteReadingObjects(args.keyPrefix);
  } finally {
    await compensateVisibility(visibility, reader, args, opts, { tombstone: true });
  }
}

// markFailed / markDeadLettered skip recreating a failed manifest. They still
// drop attempt residue already written under a prefix purge can no longer
// address once by-id is gone. Throws are logged so slot release still runs.
async function sweepTombstonePrefixDefensively(
  reader: ReadingStore,
  keyPrefix: string,
): Promise<void> {
  try {
    await reader.deleteReadingObjects(keyPrefix);
  } catch (error) {
    console.error(error);
  }
}

// Confirmed tombstone only — a live foreign attempt can also make
// readingCanWriteAttemptArtifacts false, and must not lose its prefix.
// `alreadyConfirmed` skips a second HEAD: fail-open on a throw would undo
// a confirmation the caller already has (commitTerminalManifest latches
// the same way).
async function maybeSweepConfirmedTombstone(
  reader: ReadingStore,
  args: ProcessReadingArgs,
  opts: { alreadyConfirmed?: boolean } = {},
): Promise<void> {
  if (opts.alreadyConfirmed || (await confirmedPurgeTombstone(reader, args.id))) {
    await sweepTombstonePrefixDefensively(reader, args.keyPrefix);
  }
}

// Drop the by-url pointer only while it still names this reading. A slot
// already claimed by a later submit is left alone. R2 has no conditional
// delete, so the same check-then-delete race purge accepts applies here.
async function releaseByUrlIfOwned(
  reader: ReadingStore,
  args: ProcessReadingArgs,
): Promise<void> {
  let stored: Awaited<ReturnType<ReadingStore["readByUrlPointer"]>> = null;
  try {
    stored = await reader.readByUrlPointer(args.urlHash);
  } catch (err) {
    console.error(err);
    return;
  }
  if (!stored || stored.id !== args.id) return;
  await reader.deleteByUrlPointer(args.urlHash);
}

// Unconfirmed is not confirmed: a lookup throw falls back to the gated removal
// rather than the fence. Deleting a vector we should have kept is the worse of
// the two errors, and a wipe that is genuinely running re-derives this reading's
// id from R2 on its own pass anyway.
async function tenantConfirmedDeletingForOpts(opts: CommitTerminalOpts): Promise<boolean> {
  if (!opts.tenantConfirmedDeleting) return false;
  try {
    return await opts.tenantConfirmedDeleting();
  } catch (error) {
    console.error(error);
    return false;
  }
}

async function tenantStillAllowsVisibility(opts: CommitTerminalOpts): Promise<boolean> {
  if (!opts.tenantAllowsVisibility) return true;
  try {
    return await opts.tenantAllowsVisibility();
  } catch (error) {
    // After a terminal CAS, RateLimitedError retry cannot publish: the ready
    // (or failed) manifest already cleared active_attempt, so
    // readingCanWriteAttemptArtifacts is false on redelivery. A lookup throw
    // is not confirmed inactive — fail-open (allow publish / keep).
    console.error(error);
    return true;
  }
}

// Confirmed purge tombstone, latched for one commitTerminalManifest call.
// Lookup throw → not confirmed, fail-open (allow publish / keep), same as
// tenantStillAllowsVisibility after a terminal CAS — unless a HEAD in this
// call already confirmed the tombstone. That confirmation must stick: a
// later throw must not fail-open after skip-markLive and upsert a vector
// with no live ledger row.
function purgeTombstoneAllows(
  reader: ReadingStore,
  args: ProcessReadingArgs,
): () => Promise<boolean> {
  let confirmed = false;
  return async () => {
    try {
      if (await reader.hasPurgeTombstone(args.id)) confirmed = true;
    } catch (error) {
      console.error(error);
    }
    return !confirmed;
  };
}

// Fail-open when the worker has no D1 binding (unit tests that stub Env).
const TENANT_STATUS_LOOKUP_URL = "d1://control-plane/users.status";

async function lookupTenantActive(env: Env, tenantId: string): Promise<boolean> {
  if (!env.CONTROL_PLANE) return true;
  return tenantIsActive(fromD1(env.CONTROL_PLANE), tenantId);
}

// Pre-spend only. Confirmed deleting/missing → false (skip). Lookup failure →
// RateLimitedError so dispatchQueueMessage retries while extract/embed can
// still do useful work.
async function tenantAllowsSpend(env: Env, tenantId: string): Promise<boolean> {
  try {
    return await lookupTenantActive(env, tenantId);
  } catch (error) {
    console.error(error);
    if (error instanceof RateLimitedError) throw error;
    throw new RateLimitedError(503, null, TENANT_STATUS_LOOKUP_URL);
  }
}

// Post-CAS and DLQ mark path. Confirmed deleting/missing → false. Lookup
// throw → true (fail-open): the DLQ never retries, and a post-CAS retry
// cannot republish.
async function tenantConfirmedAllowsVisibility(env: Env, tenantId: string): Promise<boolean> {
  try {
    return await lookupTenantActive(env, tenantId);
  } catch (error) {
    console.error(error);
    return true;
  }
}

// Confirmed `deleting` only. Fail-closed for the fence: no D1 binding (unit
// tests that stub Env) means "not confirmed", so the caller keeps the ordinary
// ownership gates.
async function tenantConfirmedDeleting(env: Env, tenantId: string): Promise<boolean> {
  if (!env.CONTROL_PLANE) return false;
  return tenantIsDeleting(fromD1(env.CONTROL_PLANE), tenantId);
}

async function terminalWriteState(
  reader: ReadingStore,
  args: ProcessReadingArgs,
  opts: {
    claimMissingPointer: boolean;
    allowLastAttempt?: boolean;
    tombstoneAllows?: () => Promise<boolean>;
  },
): Promise<TerminalWriteState> {
  const stored = await reader.readManifestWithEtag(args.keyPrefix);
  const manifest = stored?.manifest ?? null;
  // A missing manifest is writable only while the reading still exists (a
  // liveness witness survives); after a purge nothing may be recreated. See
  // missingManifestStillLive.
  const missingButLive =
    manifest === null && (await missingManifestStillLive(reader, args));
  const owner = attemptOwnership(manifest, args);
  const activeAttemptMatches =
    owner.isActive || owner.isLegacyPending || (opts.allowLastAttempt === true && owner.isLast);
  const activeAttemptConflict = owner.hasConflict;
  let ownsUrl = false;
  let ownerAllowsVisibility = false;
  const existing = await reader.readByUrlPointer(args.urlHash);
  if (existing) {
    ownsUrl = existing.id === args.id && existing.key_prefix === args.keyPrefix;
    ownerAllowsVisibility = ownsUrl;
  } else if (opts.claimMissingPointer && activeAttemptMatches) {
    // Do not reclaim a slot purge already released. A confirmed tombstone
    // here latches for the rest of the commit so a later throw cannot
    // fail-open into writeByUrlPointer.
    const tombstoneBlocksClaim =
      opts.tombstoneAllows !== undefined && !(await opts.tombstoneAllows());
    if (!tombstoneBlocksClaim) {
      try {
        await reader.writeByUrlPointer(
          args.urlHash,
          { id: args.id, key_prefix: args.keyPrefix },
          { ifNotExists: true },
        );
        ownsUrl = true;
        ownerAllowsVisibility = true;
      } catch (err) {
        if (!(err instanceof PointerExistsError)) throw err;
        const claimed = await reader.readByUrlPointer(args.urlHash);
        ownsUrl = claimed?.id === args.id && claimed.key_prefix === args.keyPrefix;
        ownerAllowsVisibility = ownsUrl;
      }
    }
  } else {
    ownerAllowsVisibility = true;
  }

  return {
    canWriteManifest: activeAttemptMatches || missingButLive,
    canPublishVisibility: ownerAllowsVisibility && activeAttemptMatches,
    canRemoveVisibility: !activeAttemptConflict && (activeAttemptMatches || !manifest),
    ...(stored ? { manifestEtag: stored.etag } : {}),
  };
}

// The liveness witnesses consulted when a manifest is ABSENT: the by-id
// pointer (DELETE /api/readings/:id removes it last, precisely so it outlives
// everything else) and the reading's own list row (a stale legacy job whose
// manifest was never written still owns a row + vector it must be allowed to
// write-then-clean — see the stale-job tests). When neither survives, the
// reading was purged, and recreating any object for it would resurrect
// deleted data — the same absent-manifest rule markDeadLettered applies to
// the DLQ.
async function missingManifestStillLive(
  reader: ReadingStore,
  args: ProcessReadingArgs,
): Promise<boolean> {
  if ((await reader.readByIdPointer(args.id)) !== null) return true;
  return (await reader.findListIndexItem(args.id)) !== null;
}

// Confirmed tombstone only. A throwing HEAD is not evidence of purge —
// fail-open so a transient R2 error does not drop a live reading (or, on
// the DLQ, strand a pending one).
async function confirmedPurgeTombstone(
  reader: ReadingStore,
  id: string,
): Promise<boolean> {
  try {
    return await reader.hasPurgeTombstone(id);
  } catch (e) {
    console.error(e);
    return false;
  }
}

// Confirmed tombstone, or a CONFIRMED-absent manifest with no surviving
// liveness witness. A throwing tombstone or manifest read is never treated
// as absence. Distinguishes tombstone from absent so a later HEAD throw
// cannot undo a confirmation and skip the prefix sweep.
async function readingWasPurged(
  reader: ReadingStore,
  args: ProcessReadingArgs,
): Promise<"tombstone" | "absent" | false> {
  if (await confirmedPurgeTombstone(reader, args.id)) return "tombstone";
  let manifestAbsent = false;
  try {
    manifestAbsent = (await reader.readManifest(args.keyPrefix)) === null;
  } catch (e) {
    console.error(e);
  }
  if (!manifestAbsent) return false;
  return (await missingManifestStillLive(reader, args)) ? false : "absent";
}

async function readingCanWriteAttemptArtifacts(
  reader: ReadingStore,
  args: ProcessReadingArgs,
): Promise<boolean> {
  const manifest = await reader.readManifest(args.keyPrefix);
  if (!manifest) {
    // The manifest vanished (or never existed): writable only while the
    // reading still exists at all — see missingManifestStillLive.
    return missingManifestStillLive(reader, args);
  }
  const owner = attemptOwnership(manifest, args);
  return owner.isActive || owner.isLegacyPending;
}

async function writeManifestForTerminalState(
  reader: ReadingStore,
  args: ProcessReadingArgs,
  manifest: Manifest,
  state: TerminalWriteState,
): Promise<boolean> {
  if (!state.canWriteManifest) return false;
  if (state.manifestEtag) {
    return reader.replaceManifestIfCurrent(args.keyPrefix, state.manifestEtag, manifest);
  }
  await reader.writeManifest(args.keyPrefix, manifest);
  return true;
}

async function writeTerminalManifestDefensively(
  reader: ReadingStore,
  args: ProcessReadingArgs,
  manifest: Manifest,
  state: TerminalWriteState,
): Promise<boolean> {
  try {
    return await writeManifestForTerminalState(reader, args, manifest, state);
  } catch (writeErr) {
    console.error(writeErr);
    return false;
  }
}

export function newAttemptId(services: Services): string {
  return `at_${services.newId()}`;
}

function newAttemptSummary(
  id: string,
  trigger: ProcessingAttemptTrigger,
  startedAt: string,
): ProcessingAttemptSummary {
  return {
    id,
    trigger,
    status: "running",
    stage: "queued",
    started_at: startedAt,
  };
}

function newProcessingAttempt(args: ProcessReadingArgs, services: Services): ProcessingAttempt {
  const id = resolveAttemptId(args);
  const startedAt = args.attemptStartedAt ?? services.now();
  return {
    ...newAttemptSummary(id, args.trigger ?? "submit", startedAt),
    reading_id: args.id,
    url: args.url,
    url_hash: args.urlHash,
    key_prefix: args.keyPrefix,
    events: [
      {
        stage: "queued",
        status: "started",
        at: startedAt,
      },
    ],
  };
}

async function runStage<T>(
  attempt: ProcessingAttempt,
  reader: ReadingStore,
  keyPrefix: string,
  services: Services,
  stage: ProcessingStage,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = services.now();
  attempt.stage = stage;
  attempt.events.push({ stage, status: "started", at: startedAt });
  // We deliberately don't write the attempt here — it doubles R2 PUTs per
  // stage. Both the started and the succeeded/failed event are flushed at the
  // end of the stage in a single put, so diagnostic readers still see both
  // entries per stage. The trade-off is reduced visibility while a stage is
  // in-flight; for that, fall back to the manifest's active_attempt.stage.
  try {
    const out = await fn();
    const finishedAt = services.now();
    const durationMs = durationMsBetween(startedAt, finishedAt);
    attempt.events.push({
      stage,
      status: "succeeded",
      at: finishedAt,
      ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    });
    await writeAttemptSafe(reader, keyPrefix, attempt);
    return out;
  } catch (e) {
    const failedAt = services.now();
    const durationMs = durationMsBetween(startedAt, failedAt);
    attempt.events.push({
      stage,
      status: "failed",
      at: failedAt,
      ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
      error: errorFromUnknown(e, stage, failedAt),
    });
    await writeAttemptSafe(reader, keyPrefix, attempt);
    throw e;
  }
}

async function writeAttemptSafe(
  reader: ReadingStore,
  keyPrefix: string,
  attempt: ProcessingAttempt,
): Promise<void> {
  try {
    await reader.writeAttempt(keyPrefix, attempt);
  } catch (e) {
    console.error(e);
  }
}

function durationMsBetween(startedAt: string, finishedAt: string): number | undefined {
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return undefined;
  return Math.max(0, finish - start);
}

function errorFromUnknown(
  e: unknown,
  stage: ProcessingStage | undefined,
  failedAt: string,
): ManifestError {
  return {
    code: e instanceof Error ? e.name : "unknown_error",
    message: e instanceof Error ? e.message : String(e),
    ...(stage === undefined ? {} : { stage }),
    failed_at: failedAt,
    retryable: retryableError(e),
  };
}

export function retryableError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const status = (e as { status?: unknown }).status;
  if (e.name === "BadStatusError") {
    return typeof status === "number" && status >= 500;
  }
  if (e.name === "XApiError") {
    return typeof status === "number" && status >= 500;
  }
  if (e.name === "AnthropicError" || e.name === "OpenAIError") {
    return typeof status === "number" && (status === 429 || status >= 500);
  }
  if (e.name === "FetchTimeoutError") return true;
  // The resolver returned nothing this time. That is a report about the
  // resolver, not a verdict about the destination (BlockedHostError and
  // TooManyRedirectsError are the verdicts, and stay terminal below), so a
  // blip outlasting fetchWithRetry's attempt budget must still leave the row
  // recoverable for corpus triage.
  if (e.name === "DestinationResolutionError") return true;
  if (e.name === "QueueRetriesExhaustedError") return true;
  if (e.name === "ProcessingDeferExpiredError") return true;
  return false;
}


function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) ? n : fallback;
}

function extToken(contentType: string): string {
  const major = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (major === "text/html" || major === "application/xhtml+xml") return "html";
  if (major === "text/markdown") return "md";
  if (major === "application/pdf") return "pdf";
  if (major === "application/json") return "json";
  if (major.startsWith("text/")) return "txt";
  return "bin";
}

export const EMBED_MAX_CHARS = 8000;
export function truncateForEmbed(text: string): string {
  if (text.length <= EMBED_MAX_CHARS) return text;
  // Trim a trailing high surrogate so we don't leave a malformed UTF-16 pair
  // when the cut lands between two halves of a surrogate-encoded codepoint.
  return text.slice(0, EMBED_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, "");
}
