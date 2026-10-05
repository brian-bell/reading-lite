import { retryDepsFromEnv } from "./modules/http-retry";
import { buildKeyPrefix, rawExtFromContentType } from "./modules/stores/layout";
import { SIMILAR_TOP_K, SIMILARITY_FLOOR, aboveFloor, excludeSelf, summarizeSimilarity } from "./modules/stores/similarity";
import { attemptIoFor, type AttemptIo } from "./attempt-io";
import { sqlSessionFor, type Sql } from "./modules/db/sql";
import { fromSql } from "./control-plane/db";
import {
  deploymentProviderKeys,
  paidAuthorizationFor,
  resolveProcessingConfig,
  summarizerSelectionFor,
  TenantProviderKeyError,
  tenantProviderKeysEnabled,
} from "./control-plane/tenant-provider-keys";
import { PublishCommitError } from "./modules/stores/postgres/reading-writer";
import {
  extractFromUrl,
  sourceDateFromExtractOrPrior,
  sourceDateFromMarkdownFrontMatter,
  type ExtractedContent,
} from "./modules/extractor";
import { embed } from "./modules/embeddings";
import {
  summarizeReading,
  type SimilarContext,
  validateProcessingCredentials,
} from "./modules/summarizer";
import {
  checkpointUnder,
  sameProcessingConfig,
  summarizeCheckpoint,
} from "./modules/processing-checkpoint";
import { sendReadingEmail } from "./modules/email";
import { relationshipTargetIds } from "./modules/relationship-targets";
import { tenantIsActive } from "./control-plane/account-delete";
import { redactEmailsInText } from "./control-plane/email";
import { redactProviderKeys } from "./modules/provider-error-text";
import {
  itemRequestsImmediateEmail,
  resolveImmediateNotification,
} from "./control-plane/reading-notification";
import { failedManifest, readyManifest } from "./modules/manifest-drafting";
import { RateLimitedError, type RetryDeps } from "./modules/http-retry";
import type {
  Manifest,
  ManifestError,
  ProcessingAttempt,
  ProcessingAttemptSummary,
  ProcessingAttemptTrigger,
  ProcessingStage,
} from "./schemas/manifest";
import { HttpStatusSchema } from "./schemas/manifest";
import { commitReadingSlot, refreshReadingSlot, releaseReadingSlot } from "./control-plane/tenant-usage-guard";
import {
  acquireProcessingLeases,
  StaleProcessingLeaseError,
  presentLeaseBeforePaidDispatch,
  startProcessingLeaseHeartbeat,
  DeferPaidWorkError,
  pauseOrReleaseProcessingLeases,
  releaseProcessingLeases,
  throwIfDeferred,
  type ProcessingLeaseHold,
} from "./control-plane/processing-leases";
import { recoverProcessingLeases } from "./control-plane/processing-lease-recovery";
import { createPaidFetch, ProviderAccountError, spendRpcFor } from "./control-plane/paid-dispatch";
import { PROCESSING_DEFER_MAX_AGE_MS } from "./control-plane/constants";
import type { TenantContext } from "./control-plane/ids";
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
  // A connection idle across the attempt's provider calls is replaced, not
  // trusted: see sqlSession.
  const sql = sqlSessionFor(env);
  try {
    await runAttempt(args, env, services, tenant, attemptIoFor(sql, env, tenant, args), sql);
  } finally {
    await sql.end();
  }
}

async function runAttempt(
  args: ProcessReadingArgs,
  env: Env,
  services: Services,
  tenant: TenantContext,
  io: AttemptIo,
  sql: Sql,
): Promise<void> {
  const attempt = newProcessingAttempt(args, services);
  const retry = retryDepsFromEnv(env);
  const tenantId = String(tenant.tenantId);
  const opId = resolveAttemptId(args);
  const clock = () => nowMs(services);
  let readingSlotConsumed = false;
  let leases: ProcessingLeaseHold | null = null;
  let stopHeartbeat: (() => Promise<void>) | null = null;
  let source_date: string | undefined;

  try {
    // A purged reading has no row, and nothing may be recreated for it, so a
    // stale queued message is dropped whole, before any write or upstream
    // spend. Conflict/takeover cases below still log their attempt for
    // diagnostics. Content a prior crashed delivery of this attempt captured
    // is swept: nothing references it.
    if ((await io.readManifest()) === null) {
      await io.discardUnreferencedContent().catch((err) => console.error(err));
      await releaseReadingSlot(env, tenantId, opId);
      // A purged target cannot finish processing. Retire the attempt and
      // recover leftover capacity, retrying any unconfirmed cleanup.
      await recoverLeasesOrDefer(env, tenantId, opId, "purged_reading");
      return;
    }
    // Account-deletion suppress (195a): a tenant already marked deleting must
    // not spend or write. A confirmed missing user is the same skip. A lookup
    // failure here is not inactive — it throws RateLimitedError so the queue
    // retries while extract/embed can still do useful work. This gate saves
    // the spend; publish decides visibility for real, under the tenant lock
    // inside its own transaction.
    if (!(await tenantAllowsSpend(io, tenantId))) {
      await releaseReadingSlot(env, tenantId, opId);
      return;
    }
    await writeAttemptSafe(io, attempt);
    if (!(await readingCanWriteAttemptArtifacts(io, args))) {
      await io.discardUnreferencedContent().catch((err) => console.error(err));
      await releaseReadingSlot(env, tenantId, opId);
      await releaseOrphanedLeasesIfReadingTerminal(io, args, env, tenantId);
      return;
    }
    // The attempt is live: hold its slot for the whole defer/retry window.
    // Same injected clock as lease/defer so a test clock cannot extend from
    // a different epoch. A lost refresh leaves the short TTL, and a slot
    // that lapses fails at commit rather than summarizing uncharged.
    await refreshReadingSlot(env, tenantId, opId, clock());
    const tenantKeys = tenantProviderKeysEnabled(env);
    validateProcessingCredentials({
      tenantProviderKeys: tenantKeys,
      provider: env.SUMMARIZER_PROVIDER,
      openaiApiKey: env.OPENAI_API_KEY,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      openaiReasoningEffort: env.OPENAI_SUMMARIZATION_REASONING_EFFORT,
      anthropicReasoningEffort: env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT,
      anthropicModel: env.ANTHROPIC_MODEL,
    });

    const extracted = await extractSource(args, env, services, io, attempt);

    await runStage(attempt, io, services, "write_raw", async () => {
      if (!(await readingCanWriteAttemptArtifacts(io, args))) return;
      await io.writeRaw(rawExtFromContentType(extracted.content_type), extracted.raw, extracted.content_type);
    });
    if (extracted.markdown) {
      await runStage(attempt, io, services, "write_extracted", async () => {
        if (!(await readingCanWriteAttemptArtifacts(io, args))) return;
        await io.writeExtracted(extracted.markdown!);
      });
    }

    const promptText = extracted.markdown ?? `(non-text content; raw bytes saved at raw.${rawExtFromContentType(extracted.content_type)})`;

    // Foreign active_attempt must drop without taking a lease. Re-check after
    // extract (unpaid) and before the first paid dispatch.
    if (!(await readingCanWriteAttemptArtifacts(io, args))) {
      await io.discardUnreferencedContent().catch((err) => console.error(err));
      await releaseReadingSlot(env, tenantId, opId);
      await releaseOrphanedLeasesIfReadingTerminal(io, args, env, tenantId);
      return;
    }

    // A fresh extract is authoritative; the prior fills the gap. Resolve the
    // prior here, before leases and paid stages. Skip that read when the
    // extract already produced a date. Hoisted so a later markFailed can stamp
    // a date this attempt already holds without a second (fallible) read.
    source_date = await sourceDateForReadyDraft(extracted, io);

    const result = await acquireProcessingLeases(env, tenantId, opId, clock());
    // A retired attempt can be redelivered after recovery crashed before its
    // terminal write. Finish recovery without ever acquiring a new work hold.
    const retired = !result.ok && result.reason === "stale_fence";
    const acquired = retired ? "already_running" : throwIfDeferred(result);
    if (acquired === "already_running") {
      await recoverOrphanedLeases(io, args, env, tenantId, services, attempt, clock, retired);
      return;
    }
    leases = acquired;
    stopHeartbeat = startProcessingLeaseHeartbeat(env, acquired, clock);
    await presentLeaseBeforePaidDispatch(env, acquired, clock);

    const controlPlane = fromSql(sql);
    const authorization = paidAuthorizationFor(env, controlPlane, tenantId);
    const paidFetch = (stage: "embed_source" | "summarize" | "embed_summary") => createPaidFetch({
      tenantId, attemptId: opId, stage, fetch: services.fetch,
      // Spend admission uses wall time even when artifact timestamps are injected.
      rpc: spendRpcFor(env), now: Date.now,
      authorization,
      beforeDispatch: () => presentLeaseBeforePaidDispatch(env, acquired, clock),
      onAuthorizedDispatch: async () => {
        if (stage !== "summarize") return;
        // Spend denial must not consume a reading slot. Commit only once the
        // request has dispatch permission and is about to be sent. A lapsed
        // slot was already refunded, so fail rather than summarize uncharged.
        const commit = await commitReadingSlot(env, tenantId, opId);
        if (commit === "expired") throw new ReadingReservationExpiredError();
        if (commit !== "committed") throw new DeferPaidWorkError();
        readingSlotConsumed = true;
      },
    });
    // Record the configuration on the attempt and drop any stage it no longer
    // matches: settings changed since a stage ran make the stage run again.
    const config = await resolveProcessingConfig(env, controlPlane, tenantId);
    const stored = await io.readCheckpoint();
    let checkpoint = checkpointUnder(stored, config);
    if (!sameProcessingConfig(stored?.config, config)) await io.writeCheckpoint(checkpoint);

    // Embed the extracted text to get top-K similar.
    const queryEmbed = await runStage(attempt, io, services, "embed_source", async () => {
      if (checkpoint.embed_source) return checkpoint.embed_source;
      const result = await embed(truncateForEmbed(promptText), {
        fetch: paidFetch("embed_source"),
        ...(tenantKeys ? {} : { apiKey: env.OPENAI_API_KEY }),
        retry,
      });
      checkpoint = { ...checkpoint, embed_source: result };
      await io.writeCheckpoint(checkpoint);
      return result;
    });

    const cachedSummary = checkpoint.summarize;
    let similarContext: SimilarContext[];
    let similaritySnapshot: ReturnType<typeof summarizeSimilarity>;
    if (cachedSummary) {
      similarContext = cachedSummary.similar_context;
      similaritySnapshot = cachedSummary.similarity_snapshot;
    } else {
      const similar = await runStage(attempt, io, services, "query_similar", () =>
        // Over-fetch by one: on a reprocess this reading's own vector is already
        // indexed and would otherwise consume a slot (see excludeSelf).
        io.similarity.query(queryEmbed.embedding, SIMILAR_TOP_K + 1),
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

    const llm = await runStage(attempt, io, services,
      "summarize",
      async () => {
        if (cachedSummary) {
          // commit_reading is idempotent for already-consumed slots. Call it
          // here too so a recovered artifact cannot hide an unavailable guard.
          // The checkpoint exists only after a committed dispatch, so a slot
          // that has lapsed since was already charged.
          if ((await commitReadingSlot(env, tenantId, opId)) === "unavailable") throw new DeferPaidWorkError();
          readingSlotConsumed = true;
          return { reading: cachedSummary.reading, usage: cachedSummary.usage };
        }
        await presentLeaseBeforePaidDispatch(env, acquired, clock);
        const result = await summarizeReading(
          {
            url: args.url,
            extractedText: promptText,
            title: extracted.title,
            similarReadings: similarContext,
          },
          {
            fetch: paidFetch("summarize"),
            ...deploymentProviderKeys(env),
            ...summarizerSelectionFor(config),
            retry,
          },
        );
        checkpoint = {
          ...checkpoint,
          summarize: summarizeCheckpoint(result, similarContext, similaritySnapshot),
        };
        await io.writeCheckpoint(checkpoint);
        return result;
      },
    );

    // Embed the TL;DR for the persistent vector (more representative than the full text).
    await presentLeaseBeforePaidDispatch(env, acquired, clock);
    const tldrEmbed = await runStage(attempt, io, services, "embed_summary", () =>
      embed(llm.reading.tldr, {
        fetch: paidFetch("embed_summary"),
        ...(tenantKeys ? {} : { apiKey: env.OPENAI_API_KEY }),
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
        ...(source_date === undefined ? {} : { source_date }),
      },
      services.now(),
    );
    await writeAttemptSafe(io, attempt);

    const { published } = await runStage(attempt, io, services, "write_manifest", () =>
      publishReady(io, args, finalManifest, tldrEmbed.embedding),
    );

    if (published && itemRequestsImmediateEmail(args)) {
      await sendReadingEmailAndLog(
        io,
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
        // A preserved ready manifest can still own an active reprocess. Use
        // recovery's terminality and write-confirmation rules before acking.
        // A stale fence alone does not prove retirement or holder death.
        try {
          await recoverOrphanedLeases(io, args, env, tenantId, services, attempt, clock, false);
        } catch (err) {
          await refreshReadingSlot(env, tenantId, opId, clockNow);
          if (err instanceof DeferPaidWorkError) throw err;
          console.error(err);
          throw new LiveHolderDeferError();
        }
        return;
      }
      // LiveHolderDeferError carries an already_running holder whose death is
      // not proven; terminalizing it at the ceiling would clear active_attempt
      // under a provider request still in flight (#256). Defer instead.
      if (deferLoopExceeded(args, clockNow) && !(e instanceof LiveHolderDeferError)) {
        if (!readingSlotConsumed) {
          await releaseReadingSlot(env, tenantId, opId);
        }
        await markFailed(io, args, services, attempt, new ProcessingDeferExpiredError(), env, tenantId, source_date);
        return;
      }
      await refreshReadingSlot(env, tenantId, opId, clockNow);
      throw e instanceof DeferPaidWorkError ? e : new DeferPaidWorkError();
    }
    if (e instanceof PublishCommitError) {
      // Fail closed on the publish transaction, but do not destroy anything to
      // do it. The summarization is paid for and checkpointed; marking the
      // reading failed would throw that away over a database blip. Requeue on
      // the same terms as a 429 instead: the retry re-uses the cached summary
      // rather than re-spending.
      //
      // The retry genuinely republishes because the transaction rolled back:
      // nothing terminal landed, the reading is still pending, and
      // `active_attempt` is still this attempt's. An error that repeats on
      // every delivery still ends visibly, through the queue's retry limit and
      // markDeadLettered.
      console.error(
        JSON.stringify({
          event: "reading_publish_commit_failed",
          reading_id: args.id,
          tenant_id: tenantId,
          message: e.message,
          note: "publish transaction rolled back; requeuing without marking the reading failed",
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
    await markFailed(io, args, services, attempt, e, env, tenantId, source_date);
  }
}

// Recovery policy belongs to the reading lifecycle. Lease observations,
// retirement, paired cleanup and partial failures belong to the recovery
// authority. No unconfirmed cleanup may consume the last queue delivery.
class LiveHolderDeferError extends DeferPaidWorkError {}

function manifestIsProductionTerminal(manifest: Manifest | null): boolean {
  return manifest !== null && manifest.active_attempt === undefined &&
    (manifest.status === "ready" || manifest.status === "failed");
}

async function recoverLeasesOrDefer(
  env: Env,
  tenantId: string,
  attemptId: string,
  reason: "terminal_manifest" | "purged_reading" | "defer_expired" | "retired_attempt",
): Promise<void> {
  const outcome = await recoverProcessingLeases(env, tenantId, attemptId, {
    requireOverdue: reason === "defer_expired" || reason === "retired_attempt",
  });
  if (outcome.kind !== "completed") throw new LiveHolderDeferError();
  if (outcome.result.tenant.ok && outcome.result.global.ok &&
      (outcome.result.tenant.cleared || outcome.result.global.cleared)) {
    console.warn(JSON.stringify({ event: "processing_lease_orphan_released",
      reason, tenant_id: tenantId, attempt_id: attemptId }));
  }
}

async function recoverOrphanedLeases(
  io: AttemptIo,
  args: ProcessReadingArgs,
  env: Env,
  tenantId: string,
  services: Services,
  attempt: ProcessingAttempt,
  clock: () => number,
  retired: boolean,
): Promise<void> {
  let manifest: Manifest | null;
  try { manifest = await io.readManifest(); }
  catch { throw new LiveHolderDeferError(); }
  if (manifestIsProductionTerminal(manifest)) {
    await recoverLeasesOrDefer(env, tenantId, resolveAttemptId(args), "terminal_manifest");
    return;
  }
  // Missing/foreign state is not permission to terminalize another attempt.
  if (!manifest || !attemptOwnership(manifest, args).isActive ||
      (!retired && !deferLoopExceeded(args, clock()))) throw new LiveHolderDeferError();
  await recoverLeasesOrDefer(env, tenantId, resolveAttemptId(args),
    retired ? "retired_attempt" : "defer_expired");
  await releaseReadingSlot(env, tenantId, resolveAttemptId(args));
  await markFailed(io, args, services, attempt, new ProcessingDeferExpiredError(), env, tenantId, manifest.source_date);
  // markFailed is defensive elsewhere and can swallow a write failure.
  // Retirement must keep its recovery delivery until terminalization sticks.
  try {
    const current = await io.readManifest();
    // No row: the reading was purged, which retires the attempt too.
    if (!current) return;
    if (manifestIsProductionTerminal(current)) return;
    if (attemptOwnership(current, args).hasConflict) return;
  } catch { /* Unconfirmed terminalization must be retried. */ }
  throw new LiveHolderDeferError();
}

async function releaseOrphanedLeasesIfReadingTerminal(
  io: AttemptIo,
  args: ProcessReadingArgs,
  env: Env,
  tenantId: string,
): Promise<void> {
  let manifest: Manifest | null;
  try { manifest = await io.readManifest(); }
  catch { throw new LiveHolderDeferError(); }
  if (manifestIsProductionTerminal(manifest)) {
    await recoverLeasesOrDefer(env, tenantId, resolveAttemptId(args), "terminal_manifest");
  }
}


export class ProcessingDeferExpiredError extends Error {
  constructor() {
    super("processing defer loop exceeded PROCESSING_DEFER_MAX_AGE_MS");
    this.name = "ProcessingDeferExpiredError";
  }
}

/** The attempt's reading slot was swept or released before summarize could commit it (#320). */
export class ReadingReservationExpiredError extends Error {
  constructor() {
    super("reading-slot reservation expired before summarize dispatch");
    this.name = "ReadingReservationExpiredError";
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
  io: AttemptIo,
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
    // Recipient lookup belongs in this try: a thrown users/settings read after
    // publication must not reach processReading's outer catch.
    const decision = await resolveImmediateNotification(io.controlPlane, env, String(tenant.tenantId));
    if (decision.kind === "skip") return;
    recipient = decision.to;

    // Tenant-scoped rows: connection titles/links stay in this tenant. Only
    // the targets this reading names are read.
    const targetIds = relationshipTargetIds(manifest);
    const listIndex = {
      version: 1 as const,
      items: targetIds.length === 0 ? [] : await io.store.relationshipTargets(targetIds),
    };
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
  await writeAttemptSafe(io, attempt);
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

// Convert a dead-lettered message into a visible, retryable `failed` reading.
// Reuses markFailed so a reprocess of a previously-`ready` reading keeps its
// published revision rather than nuking good data. The mark requires the
// reading to exist in the admitted tenant's rows and the attempt to still be
// active — see the guards below.
export async function markDeadLettered(
  args: ProcessReadingArgs,
  env: Env,
  services: Services,
  tenant: TenantContext,
): Promise<void> {
  const sql = sqlSessionFor(env);
  try {
    await markDeadLetteredWith(attemptIoFor(sql, env, tenant, args), args, env, services, tenant);
  } finally {
    await sql.end();
  }
}

async function markDeadLetteredWith(
  io: AttemptIo,
  args: ProcessReadingArgs,
  env: Env,
  services: Services,
  tenant: TenantContext,
): Promise<void> {
  let existing: Manifest | null = null;
  let confirmedAbsent = false;
  try {
    existing = await io.readManifest();
    confirmedAbsent = existing === null;
  } catch (e) {
    console.error(e);
  }

  const tenantId = String(tenant.tenantId);
  const opId = resolveAttemptId(args);

  // No row: the reading was purged. Nothing may be recreated for it; sweep
  // what this attempt captured and let the slot go.
  if (confirmedAbsent) {
    await io.discardUnreferencedContent().catch((e) => console.error(e));
    await releaseReadingSlot(env, tenantId, opId);
    return;
  }

  if (!(await tenantConfirmedAllowsVisibility(io, tenantId))) {
    await releaseReadingSlot(env, tenantId, opId);
    return;
  }

  if (existing && !attemptOwnership(existing, args).isActive) {
    await releaseReadingSlot(env, tenantId, opId);
    return;
  }

  const attempt = newProcessingAttempt(args, services);
  if (existing?.active_attempt?.stage) attempt.stage = existing.active_attempt.stage;
  // The only caller that marks a job dead: the reading DLQ.
  await markFailed(io, args, services, attempt, new QueueRetriesExhaustedError(), env, tenantId, existing?.source_date, "dead");
  await releaseReadingSlot(env, tenantId, opId);
}

async function markFailed(
  io: AttemptIo,
  args: ProcessReadingArgs,
  services: Services,
  attempt: ProcessingAttempt,
  e: unknown,
  env: Env,
  tenantId: string,
  sourceDate?: string,
  jobState: "done" | "dead" = "done",
): Promise<void> {
  console.error(e);
  // A mid-flight purge after the opening check must not get anything recreated
  // for the reading. The row is gone, so there is nothing to mark; sweep the
  // content this attempt captured. A read that throws is not evidence of a
  // purge, so it falls through and the commit below decides under the lock.
  const purged = await io.readManifest().then((current) => current === null, () => false);
  if (purged) {
    await io.discardUnreferencedContent().catch((err) => console.error(err));
    await releaseReadingSlot(env, tenantId, resolveAttemptId(args));
    return;
  }
  const failedAt = services.now();
  const error = errorFromUnknown(e, attempt.stage, failedAt);
  attempt.status = "failed";
  attempt.finished_at = failedAt;
  attempt.error = error;
  await writeAttemptSafe(io, attempt);

  const sourceTypeOnFailure = await resolveSourceTypeOnFailure(io, args);
  const sourceDateOnFailure = sourceDate ?? await sourceDateFromPrior(io);
  // content omitted → the empty-content placeholder with content_status
  // "failed": on this path extraction may never have happened.
  const manifest = failedManifest(
    args,
    {
      sourceType: sourceTypeOnFailure,
      error,
      attempt,
      ...(sourceDateOnFailure === undefined ? {} : { source_date: sourceDateOnFailure }),
    },
    services.now(),
  );
  // We're already on the failure path inside the queue consumer — a transient
  // database error here has nowhere to bubble to (dispatchQueueMessage will
  // ack either way). Log and move on; the TTL annotator will eventually flip a
  // stale pending reading even if this write drops.
  //
  // A published reading is not failed by this: PgReadingWriter.fail keeps its
  // revision, summary and embedding and only records the attempt. That is
  // what makes a failed reprocess leave the previous content and summary
  // intact together.
  //
  // URL ownership is untouched. A failed owner stays re-submittable because a
  // resubmit resolves failed ownership by reprocessing this same reading id.
  try {
    await io.writer.fail(args, manifest, { allowLastAttempt: true, now: services.now(), jobState });
    // Kept only while the reading points at it: a published reading kept its
    // revision, and a never-published one serves this attempt's bytes.
    await io.discardUnreferencedContent();
  } catch (err) {
    console.error(err);
  }
}

/** Ready-draft publication date: a fresh extract is authoritative; the prior
 *  fills in only when the extract has no date. Exported so tests can pin the
 *  precedence and the skip-prior-read short-circuit without the full pipeline. */
export async function sourceDateForReadyDraft(
  extracted: Pick<ExtractedContent, "source_date">,
  io: Pick<AttemptIo, "readManifest">,
): Promise<string | undefined> {
  return sourceDateFromExtractOrPrior(
    extracted.source_date,
    extracted.source_date === undefined ? await sourceDateFromPrior(io) : undefined,
  );
}

/** Carry a stored publication date onto the ready or failed draft. Exported
 *  so tests can pin prior-read errors without running the full process
 *  pipeline. A throw is not "no stored date", but rethrowing it would land
 *  in markFailed and write a dateless failed terminal — strictly worse than
 *  proceeding undated on failed-prior reprocess / import-over. A published
 *  reading keeps its row's date through a reprocess, so the row is the only
 *  source there is. */
export async function sourceDateFromPrior(
  io: Pick<AttemptIo, "readManifest">,
): Promise<string | undefined> {
  try {
    return (await io.readManifest())?.source_date;
  } catch (error) {
    console.error(error);
    return undefined;
  }
}

async function resolveSourceTypeOnFailure(
  io: AttemptIo,
  args: ProcessReadingArgs,
): Promise<"url" | "markdown"> {
  if (args.sourceTypeOnFailure) return args.sourceTypeOnFailure;

  // Queue messages already in flight when sourceTypeOnFailure was introduced
  // do not carry the snapshot. A reprocess pending manifest retains the prior
  // source type, so recover it only while this attempt still owns that manifest.
  if (args.trigger === "reprocess") {
    const current = await io.readManifest().catch(() => null);
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
  io: AttemptIo,
  attempt: ProcessingAttempt,
): Promise<ExtractedContent> {
  const source = args.source;
  if (source?.kind === "markdown") {
    return runStage(attempt, io, services,
      "prepare_markdown",
      () => extractedFromMarkdown(source, nowMs(services)),
    );
  }

  return runStage(attempt, io, services, "fetch_source", () =>
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

export async function extractedFromMarkdown(
  source: Extract<ProcessReadingSource, { kind: "markdown" }>,
  nowMs: number = Date.now(),
): Promise<ExtractedContent> {
  const raw = new TextEncoder().encode(source.markdown);
  const source_date = sourceDateFromMarkdownFrontMatter(source.markdown, nowMs);
  return {
    raw,
    content_type: "text/markdown; charset=utf-8",
    content_status: "captured",
    content_bytes: raw.byteLength,
    content_sha256: await sha256Hex(source.markdown),
    markdown: source.markdown,
    title: source.title,
    ...(source_date === undefined ? {} : { source_date }),
  };
}

function sourceTypeForArgs(args: ProcessReadingArgs): "url" | "markdown" {
  return args.source?.kind === "markdown" ? "markdown" : "url";
}

// Publication. Attempt ownership, URL ownership, the revision, the summary,
// the relationships, the embedding AND the tenant's eligibility are one
// transaction in PgReadingWriter.publish (slice 1c.3): `users` is in the same
// database, so publish locks the tenant row FOR SHARE and reads `status`
// there. `DELETE /api/account` waits behind that lock, so there is no window
// between the check and the commit to compensate for — an ineligible tenant's
// reading commits with no embedding and is never searchable, and the account
// wipe removes it with the rest of the account.
//
// Once publish commits, `active_attempt` is cleared and no retry can
// republish.
//
// Returns `published` so the caller can gate post-commit side effects (the
// success path only emails when the reading became searchable).
async function publishReady(
  io: AttemptIo,
  args: ProcessReadingArgs,
  manifest: Manifest,
  embedding: number[],
): Promise<{ committed: boolean; published: boolean }> {
  const content = io.capturedContent();
  if (!content) throw new Error("publishReady: the attempt captured no content");
  const out = await io.writer.publish(args, manifest, {
    keyPrefix: args.keyPrefix,
    content,
    embedding,
    claimMissingUrl: true,
  });
  if (!out.committed) {
    // Purged, or another attempt owns the reading: nothing references what
    // this one captured.
    await io.discardUnreferencedContent().catch((err) => console.error(err));
  } else if (out.superseded) {
    // The previous revision's row went with the commit; its bytes go now.
    // Best effort: the reading is published either way, and a leftover
    // object is unreachable until the account wipe sweeps the prefix.
    await io.discardSupersededContent(out.superseded).catch((err) => console.error(err));
  }
  return out;
}

const TENANT_STATUS_LOOKUP_URL = "postgres://control-plane/users.status";

async function lookupTenantActive(io: AttemptIo, tenantId: string): Promise<boolean> {
  return tenantIsActive(io.controlPlane, tenantId);
}

// Pre-spend only. Confirmed deleting/missing → false (skip). Lookup failure →
// RateLimitedError so dispatchQueueMessage retries while extract/embed can
// still do useful work.
async function tenantAllowsSpend(io: AttemptIo, tenantId: string): Promise<boolean> {
  try {
    return await lookupTenantActive(io, tenantId);
  } catch (error) {
    console.error(error);
    if (error instanceof RateLimitedError) throw error;
    throw new RateLimitedError(503, null, TENANT_STATUS_LOOKUP_URL);
  }
}

// The DLQ mark path, its only caller: publication decides eligibility inside
// its own transaction now. Confirmed deleting/missing → false. Lookup throw →
// true (fail-open), because the DLQ never retries.
async function tenantConfirmedAllowsVisibility(io: AttemptIo, tenantId: string): Promise<boolean> {
  try {
    return await lookupTenantActive(io, tenantId);
  } catch (error) {
    console.error(error);
    return true;
  }
}

// May this attempt still write for the reading? Only while it is the active
// attempt (or the reading is a legacy pending one with none). No row means the
// reading was purged.
async function readingCanWriteAttemptArtifacts(
  io: AttemptIo,
  args: ProcessReadingArgs,
): Promise<boolean> {
  const manifest = await io.readManifest();
  if (!manifest) return false;
  const owner = attemptOwnership(manifest, args);
  return owner.isActive || owner.isLegacyPending;
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
  io: AttemptIo,
  services: Services,
  stage: ProcessingStage,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = services.now();
  attempt.stage = stage;
  attempt.events.push({ stage, status: "started", at: startedAt });
  // We deliberately don't write the attempt here — it doubles the writes per
  // stage. Both the started and the succeeded/failed event are flushed at the
  // end of the stage in a single put, so diagnostic readers still see both
  // entries per stage. The trade-off is reduced visibility while a stage is
  // in-flight; for that, fall back to the reading's active_attempt.stage.
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
    await writeAttemptSafe(io, attempt);
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
    await writeAttemptSafe(io, attempt);
    throw e;
  }
}

async function writeAttemptSafe(io: AttemptIo, attempt: ProcessingAttempt): Promise<void> {
  try {
    await io.writeAttempt(attempt);
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
  const httpStatus = HttpStatusSchema.safeParse(e instanceof Error ? (e as { status?: unknown }).status : undefined);
  const provider = e instanceof ProviderAccountError || e instanceof TenantProviderKeyError ? e.provider : undefined;
  // The adapters redact their own messages; this covers any other error whose
  // text carries a key before it becomes a durable, returned reading error.
  return {
    code: e instanceof Error ? e.name : "unknown_error",
    message: redactProviderKeys(e instanceof Error ? e.message : String(e)),
    ...(stage === undefined ? {} : { stage }),
    failed_at: failedAt,
    retryable: retryableError(e),
    ...(httpStatus.success ? { http_status: httpStatus.data } : {}),
    ...(provider === undefined ? {} : { provider }),
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
  // The summarizer asked twice and both tool calls missed the schema. That is
  // a property of those samples, not a verdict about the source.
  if (e.name === "BadToolInputError" || e.name === "NoToolUseError") return true;
  // The resolver returned nothing this time. That is a report about the
  // resolver, not a verdict about the destination (BlockedHostError and
  // TooManyRedirectsError are the verdicts, and stay terminal below), so a
  // blip outlasting fetchWithRetry's attempt budget must still leave the row
  // recoverable for corpus triage.
  if (e.name === "DestinationResolutionError") return true;
  if (e.name === "QueueRetriesExhaustedError") return true;
  if (e.name === "ProcessingDeferExpiredError") return true;
  if (e.name === "ReadingReservationExpiredError") return true;
  return false;
}


function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) ? n : fallback;
}

export const EMBED_MAX_CHARS = 8000;
export function truncateForEmbed(text: string): string {
  if (text.length <= EMBED_MAX_CHARS) return text;
  // Trim a trailing high surrogate so we don't leave a malformed UTF-16 pair
  // when the cut lands between two halves of a surrogate-encoded codepoint.
  return text.slice(0, EMBED_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, "");
}
