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
import { sendReadingEmail } from "./modules/email";
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
import { commitReadingSlot, releaseReadingSlot } from "./control-plane/tenant-usage-guard";
import {
  acquireProcessingLeases,
  DeferPaidWorkError,
  heartbeatProcessingLeases,
  pauseProcessingLeases,
  releaseProcessingLeases,
  renewProcessingLeases,
  throwIfDeferred,
  type ProcessingLeaseHold,
} from "./control-plane/processing-leases";
import { PROCESSING_LEASE_HEARTBEAT_MS } from "./control-plane/constants";
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
  const reader = readingStoreFor(env.READINGS_BUCKET, tenant, env);
  const similarity = similarityStoreFor(env.READINGS_INDEX, tenant, env);
  const attempt = newProcessingAttempt(args, services);
  const retry = retryDepsFromEnv(env);
  const tenantId = String(tenant.tenantId);
  const opId = resolveAttemptId(args);
  let readingSlotConsumed = false;
  let leases: ProcessingLeaseHold | null = null;
  let stopHeartbeat: (() => void) | null = null;

  try {
    // A purged reading must not get ANY object recreated — not even this
    // attempt log — so a stale queued message for it is dropped whole, before
    // any write or upstream spend. Conflict/takeover cases below still log
    // their attempt for diagnostics.
    if (await readingWasPurged(reader, args)) {
      await releaseReadingSlot(env, tenantId, opId);
      return;
    }
    await writeAttemptSafe(reader, args.keyPrefix, attempt);
    if (!(await readingCanWriteAttemptArtifacts(reader, args))) {
      await releaseReadingSlot(env, tenantId, opId);
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
      await releaseReadingSlot(env, tenantId, opId);
      return;
    }

    const acquired = throwIfDeferred(await acquireProcessingLeases(env, tenantId, opId, Date.now()));
    if (acquired === "already_running") {
      await ackOrDeferIfProcessingIncomplete(reader, args);
      return;
    }
    leases = acquired;
    stopHeartbeat = startProcessingLeaseHeartbeat(env, acquired);
    await presentLeaseBeforePaidDispatch(env, acquired);

    // Embed the extracted text to get top-K similar.
    const queryEmbed = await runStage(attempt, reader, args.keyPrefix, services, "embed_source", () =>
      embed(truncateForEmbed(promptText), {
        fetch: services.fetch,
        apiKey: env.OPENAI_API_KEY,
        retry,
      }),
    );
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
    const similarContext: SimilarContext[] = related.map((s) => ({
      id: s.id,
      url: s.url,
      ...(s.title === undefined ? {} : { title: s.title }),
      ...(s.tldr === undefined ? {} : { tldr: s.tldr }),
      score: s.score,
    }));
    const similaritySnapshot = summarizeSimilarity(neighbours, services.now());

    const llm = await runStage(
      attempt,
      reader,
      args.keyPrefix,
      services,
      "summarize",
      async () => {
        await presentLeaseBeforePaidDispatch(env, acquired);
        // Reading quota stays held through extract/embed; commit immediately
        // before summarization dispatch so a later failure still consumes the
        // slot. An undispatched failure releases instead (catch below).
        readingSlotConsumed = true;
        await commitReadingSlot(env, tenantId, opId);
        return summarizeReading(
          {
            url: args.url,
            extractedText: promptText,
            title: extracted.title,
            similarReadings: similarContext,
          },
          {
            fetch: services.fetch,
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
      },
    );

    // Embed the TL;DR for the persistent vector (more representative than the full text).
    await presentLeaseBeforePaidDispatch(env, acquired);
    const tldrEmbed = await runStage(attempt, reader, args.keyPrefix, services, "embed_summary", () =>
      embed(llm.reading.tldr, {
        fetch: services.fetch,
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
    stopHeartbeat?.();
    stopHeartbeat = null;
    if (leases) await releaseProcessingLeases(env, leases, Date.now());
    leases = null;
  } catch (e) {
    stopHeartbeat?.();
    stopHeartbeat = null;
    if (e instanceof DeferPaidWorkError) {
      if (leases) await releaseProcessingLeases(env, leases, Date.now());
      throw e;
    }
    if (e instanceof StaleProcessingLeaseError) {
      // Release before ack-or-defer: a tenant-side stale_fence returns without
      // touching global, and heartbeat may have just renewed it. Under B1 that
      // leftover in-flight global row is never swept. Fence-mismatched release
      // is already a no-op, so a live winner's different fence is unharmed.
      if (leases) await releaseProcessingLeases(env, leases, Date.now());
      leases = null;
      await ackOrDeferIfProcessingIncomplete(reader, args);
      return;
    }
    if (e instanceof RateLimitedError) {
      // Don't mark the manifest failed — the queue handler will requeue this
      // message after the upstream's Retry-After window. The active_attempt
      // stays "running" until either a future attempt succeeds or
      // PENDING_TTL_SECONDS flips it stale. Held reading-slot reservations
      // stay counted until a later delivery commits or a definitive failure
      // (including markDeadLettered after max_retries) releases them.
      // Processing leases stay held (paused, not released) so a 429 retry
      // resumes the same fence instead of taking a second permit.
      if (leases) await pauseProcessingLeases(env, leases, Date.now());
      throw e;
    }
    if (leases) await releaseProcessingLeases(env, leases, Date.now());
    if (!readingSlotConsumed) {
      await releaseReadingSlot(env, tenantId, opId);
    }
    await markFailed(reader, args, services, attempt, e);
  }
}

// Duplicate or stale-fence deliveries must not ack-as-success unless this
// reading already has a terminal ready/failed manifest. Incomplete work is
// deferred with the same delayed-send contract as lease contention.
async function ackOrDeferIfProcessingIncomplete(
  reader: ReadingStore,
  args: ProcessReadingArgs,
): Promise<void> {
  try {
    const manifest = await reader.readManifest(args.keyPrefix);
    if (manifest?.status === "ready" || manifest?.status === "failed") return;
  } catch (err) {
    console.error(err);
  }
  throw new DeferPaidWorkError();
}

class StaleProcessingLeaseError extends Error {
  constructor() {
    super("processing lease fence is stale");
    this.name = "StaleProcessingLeaseError";
  }
}

async function presentLeaseBeforePaidDispatch(env: Env, hold: ProcessingLeaseHold): Promise<void> {
  const renewed = await renewProcessingLeases(env, hold, Date.now());
  if (renewed.ok) return;
  if (renewed.reason === "stale_fence") throw new StaleProcessingLeaseError();
  throw new DeferPaidWorkError();
}

function startProcessingLeaseHeartbeat(env: Env, hold: ProcessingLeaseHold): () => void {
  const timer = setInterval(() => {
    void heartbeatProcessingLeases(env, hold, Date.now());
  }, PROCESSING_LEASE_HEARTBEAT_MS);
  return () => clearInterval(timer);
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

  // Confirmed-absent: this attempt will never commit. Release a still-held
  // reservation (idempotent if already consumed/released).
  if (confirmedAbsent) {
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
  await markFailed(reader, args, services, attempt, new QueueRetriesExhaustedError());
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
): Promise<void> {
  console.error(e);
  const failedAt = services.now();
  const error = errorFromUnknown(e, attempt.stage, failedAt);
  attempt.status = "failed";
  attempt.finished_at = failedAt;
  attempt.error = error;
  await writeAttemptSafe(reader, args.keyPrefix, attempt);

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
  const visibility = new ReadingVisibility(reader, similarity);

  const state = await terminalWriteState(reader, args, {
    claimMissingPointer: opts.claimMissingPointer,
    allowLastAttempt: opts.allowLastAttempt,
  });
  // Active-attempt conflict: a foreign attempt owns the reading. No writes, no
  // restore — the other attempt owns visibility too. This unifies the two old
  // call sites: the success path already early-returned here, but the failure
  // path used to fall through writeManifestForTerminalState (which returns false
  // on conflict) into a list re-sync (now ReadingVisibility.restoreIfOwner) of
  // the foreign row.
  // That re-sync was a no-op on data the owning attempt maintains anyway;
  // skipping it is intentional (plan 005, case 2).
  if (!state.canWriteManifest) return { committed: false, published: false };

  const written = await run("write_manifest", () =>
    opts.defensive
      ? writeTerminalManifestDefensively(reader, args, manifest, state)
      : writeManifestForTerminalState(reader, args, manifest, state),
  );
  if (!written) {
    // Manifest not written despite owning the attempt: a lost CAS (etag changed
    // mid-flight) on either path, or — on the defensive path only — a swallowed
    // write throw. Restore the current list visibility so we don't leave a
    // half-published row behind.
    await reconcileVisibility(opts.defensive, () =>
      visibility.restoreIfOwner(args),
    );
    return { committed: false, published: false };
  }

  if (state.canPublishVisibility) {
    await reconcileVisibility(opts.defensive, () =>
      visibility.publish(manifest, args, opts.vector, { instrument: run }),
    );
    return { committed: true, published: true };
  }

  if (state.canRemoveVisibility) {
    await reconcileVisibility(opts.defensive, () => visibility.remove(args));
  }
  return { committed: true, published: false };
}

// Visibility reconciliation honors `defensive`: on the failure path a transient
// R2 hiccup has nowhere to bubble (the queue consumer acks either way), so log
// and move on; on the success path throws propagate to the outer catch.
async function reconcileVisibility(
  defensive: boolean,
  fn: () => Promise<void>,
): Promise<void> {
  if (!defensive) {
    await fn();
    return;
  }
  try {
    await fn();
  } catch (e) {
    console.error(e);
  }
}

async function terminalWriteState(
  reader: ReadingStore,
  args: ProcessReadingArgs,
  opts: { claimMissingPointer: boolean; allowLastAttempt?: boolean },
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

// True only for a CONFIRMED-absent manifest with no surviving liveness
// witness. A throwing manifest read is an object that may well exist and is
// never treated as absence.
async function readingWasPurged(
  reader: ReadingStore,
  args: ProcessReadingArgs,
): Promise<boolean> {
  let manifestAbsent = false;
  try {
    manifestAbsent = (await reader.readManifest(args.keyPrefix)) === null;
  } catch (e) {
    console.error(e);
  }
  if (!manifestAbsent) return false;
  return !(await missingManifestStillLive(reader, args));
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
  if (e.name === "QueueRetriesExhaustedError") return true;
  return false;
}

function retryDepsFromEnv(env: Env): RetryDeps {
  return {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxAttempts: parseIntEnv(env.RETRY_MAX_ATTEMPTS, 3),
    baseDelayMs: parseIntEnv(env.RETRY_BASE_DELAY_MS, 500),
    maxDelayMs: parseIntEnv(env.RETRY_MAX_DELAY_MS, 8_000),
  };
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
