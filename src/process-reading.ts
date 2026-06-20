import {
  buildKeyPrefix,
  manifestToIndexItem,
  PointerExistsError,
  ReadingStore,
} from "./modules/stores/reading-store";
import { SimilarityStore } from "./modules/stores/similarity-store";
import { extractFromUrl, type ExtractedContent } from "./modules/extractor";
import { embed } from "./modules/embeddings";
import {
  summarizeReading,
  type SimilarContext,
} from "./modules/anthropic";
import { sendReadingEmail } from "./modules/email";
import { RateLimitedError, type RetryDeps } from "./modules/http-retry";
import type {
  Manifest,
  ManifestError,
  ProcessingAttempt,
  ProcessingAttemptSummary,
  ProcessingAttemptTrigger,
  ProcessingStage,
} from "./schemas/manifest";
import type { ListIndexItem } from "./schemas/api";
import type { Env } from "./index";
import type { Services } from "./services";
import { sha256Hex } from "./services";

export type ProcessReadingSource =
  | { kind: "url" }
  | { kind: "markdown"; markdown: string; title?: string };

export interface ProcessReadingArgs {
  id: string;
  url: string;
  urlHash: string;
  createdAt: string;
  keyPrefix: string;
  source?: ProcessReadingSource;
  attemptId?: string;
  attemptStartedAt?: string;
  trigger?: ProcessingAttemptTrigger;
  preserveReadyManifest?: Manifest;
  // Optional in TS for backwards compat with in-flight queue messages enqueued
  // before this field existed; current entry points always set it explicitly.
  email?: boolean;
}

export async function processReading(
  args: ProcessReadingArgs,
  env: Env,
  services: Services,
): Promise<void> {
  const reader = new ReadingStore(env.READINGS_BUCKET);
  const similarity = new SimilarityStore(env.READINGS_INDEX);
  const attempt = newProcessingAttempt(args, services);
  const retry = retryDepsFromEnv(env);

  try {
    await writeAttemptSafe(reader, args.keyPrefix, attempt);
    if (!(await readingCanWriteAttemptArtifacts(reader, args))) return;

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

    // Embed the extracted text to get top-K similar.
    const queryEmbed = await runStage(attempt, reader, args.keyPrefix, services, "embed_source", () =>
      embed(truncateForEmbed(promptText), {
        fetch: services.fetch,
        apiKey: env.OPENAI_API_KEY,
        retry,
      }),
    );
    const similar = await runStage(attempt, reader, args.keyPrefix, services, "query_similar", () =>
      similarity.query(queryEmbed.embedding, 5),
    );
    const similarContext: SimilarContext[] = similar
      .filter((s) => s.id !== args.id)
      .map((s) => ({ id: s.id, url: s.url, title: s.title }));

    const llm = await runStage(
      attempt,
      reader,
      args.keyPrefix,
      services,
      "summarize",
      () =>
        summarizeReading(
          {
            url: args.url,
            extractedText: promptText,
            title: extracted.title,
            similarReadings: similarContext,
          },
          {
            fetch: services.fetch,
            apiKey: env.ANTHROPIC_API_KEY,
            model: env.ANTHROPIC_MODEL,
            retry,
          },
        ),
    );

    // Embed the TL;DR for the persistent vector (more representative than the full text).
    const tldrEmbed = await runStage(attempt, reader, args.keyPrefix, services, "embed_summary", () =>
      embed(llm.reading.tldr, {
        fetch: services.fetch,
        apiKey: env.OPENAI_API_KEY,
        retry,
      }),
    );

    let finalManifest: Manifest = {
      id: args.id,
      url: args.url,
      url_hash: args.urlHash,
      source_type: sourceTypeForArgs(args),
      status: "ready",
      title: llm.reading.title,
      tldr: llm.reading.tldr,
      tags: llm.reading.tags,
      keywords: llm.reading.keywords,
      people: llm.reading.people,
      orgs: llm.reading.orgs,
      novelty_verdict: llm.reading.novelty_verdict,
      connections: llm.reading.connections,
      summary_markdown: llm.reading.summary_markdown,
      content_type: extracted.content_type,
      content_status: extracted.content_status,
      content_bytes: extracted.content_bytes,
      extracted_bytes: extracted.markdown
        ? new TextEncoder().encode(extracted.markdown).byteLength
        : undefined,
      content_sha256: extracted.content_sha256,
      fetched_at: services.now(),
      created_at: args.createdAt,
      updated_at: services.now(),
      last_attempt: summarizeAttempt(attempt),
      usage: {
        anthropic_input_tokens: llm.usage.input_tokens,
        anthropic_output_tokens: llm.usage.output_tokens,
        openai_embedding_tokens:
          queryEmbed.usage.total_tokens + tldrEmbed.usage.total_tokens,
      },
    };

    attempt.status = "succeeded";
    attempt.finished_at = services.now();
    attempt.error = undefined;
    finalManifest = {
      ...finalManifest,
      updated_at: services.now(),
      last_attempt: summarizeAttempt(attempt),
    };
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
            tags: llm.reading.tags,
            created_at: args.createdAt,
          },
        },
        instrument: (stage, fn) =>
          runStage(attempt, reader, args.keyPrefix, services, stage, fn),
      },
    );

    if (published && shouldSendEmail(args)) {
      await sendReadingEmailAndLog(
        reader,
        args,
        env,
        services,
        attempt,
        finalManifest,
        retry,
      );
    }
  } catch (e) {
    if (e instanceof RateLimitedError) {
      // Don't mark the manifest failed — the queue handler will requeue this
      // message after the upstream's Retry-After window. The active_attempt
      // stays "running" until either a future attempt succeeds or
      // PENDING_TTL_SECONDS flips it stale.
      throw e;
    }
    await markFailed(reader, args, services, attempt, e);
  }
}

function shouldSendEmail(args: ProcessReadingArgs): boolean {
  // In-flight queue messages from before this field existed lack `email`. Per
  // contract: undefined → true on submit, false otherwise.
  if (args.email !== undefined) return args.email;
  return args.trigger === "submit";
}

async function sendReadingEmailAndLog(
  reader: ReadingStore,
  args: ProcessReadingArgs,
  env: Env,
  services: Services,
  attempt: ProcessingAttempt,
  manifest: Manifest,
  retry: RetryDeps,
): Promise<void> {
  const startedAt = services.now();
  try {
    const listIndex = await reader.readListIndex();
    await sendReadingEmail(
      { manifest, webBaseUrl: env.WEB_BASE_URL, listIndex },
      {
        fetch: services.fetch,
        apiKey: env.RESEND_API_KEY,
        from: env.EMAIL_FROM,
        to: env.EMAIL_TO,
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
    // Recovery is a manual reprocess with email=true (see PRD non-goals).
    console.error(e);
    const failedAt = services.now();
    const durationMs = durationMsBetween(startedAt, failedAt);
    attempt.events.push({
      stage: "send_email",
      status: "failed",
      at: failedAt,
      ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
      error: errorFromUnknown(e, "send_email", failedAt),
    });
  }
  await writeAttemptSafe(reader, args.keyPrefix, attempt);
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
// in sync. Best-effort: any read here is tolerated as absent.
export async function markDeadLettered(
  args: ProcessReadingArgs,
  env: Env,
  services: Services,
): Promise<void> {
  const reader = new ReadingStore(env.READINGS_BUCKET);
  const existing = await reader.readManifest(args.keyPrefix).catch(() => null);

  // A rate-limited message can sit in the retry→DLQ pipeline for many minutes.
  // If the original pending attempt was flipped stale by PENDING_TTL_SECONDS in
  // that window and a *newer* attempt took over the reading (or already brought
  // it back to `ready`), this dead-lettered message is stale: marking it failed
  // — and especially rolling back to its preserveReadyManifest snapshot — would
  // clobber the newer attempt's data. Only act if we still own the active
  // attempt. (A missing manifest still gets a failed marker so the strand stays
  // visible.)
  //
  // This narrows, but doesn't fully close, the window: a brand-new reprocess
  // landing between this read and markFailed's write would still be clobbered.
  // That residual race is last-writer-wins (the repo's documented stance) and
  // benign — the loser is a reading that is being reprocessed anyway and stays
  // re-submittable through its existing by-url ownership claim.
  const attemptId = args.attemptId ?? `at_${args.id}`;
  if (existing && existing.active_attempt?.id !== attemptId) return;

  const attempt = newProcessingAttempt(args, services);
  if (existing?.active_attempt?.stage) attempt.stage = existing.active_attempt.stage;
  await markFailed(reader, args, services, attempt, new QueueRetriesExhaustedError());
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
    // forward to that snapshot, clear active_attempt, and stamp last_attempt
    // with the failed reprocess so the user keeps the previously-ready data.
    const manifest: Manifest = {
      ...args.preserveReadyManifest,
      active_attempt: undefined,
      last_attempt: summarizeAttempt(attempt),
      updated_at: services.now(),
    };
    // similarity: null → list-only visibility (the failure-path asymmetry).
    await commitTerminalManifest(reader, null, args, manifest, {
      claimMissingPointer: false,
      allowLastAttempt: true,
      defensive: true,
    });
    return;
  }

  const manifest: Manifest = {
    id: args.id,
    url: args.url,
    url_hash: args.urlHash,
    source_type: sourceTypeForArgs(args),
    status: "failed",
    error,
    content_type: "application/octet-stream",
    content_status: "failed",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: args.createdAt,
    updated_at: services.now(),
    last_attempt: summarizeAttempt(attempt),
  };
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
    meta: { url: string; title: string; tags: string[]; created_at: string };
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

  const state = await terminalWriteState(reader, args, {
    claimMissingPointer: opts.claimMissingPointer,
    allowLastAttempt: opts.allowLastAttempt,
  });
  // Active-attempt conflict: a foreign attempt owns the reading. No writes, no
  // restore — the other attempt owns visibility too. This unifies the two old
  // call sites: the success path already early-returned here, but the failure
  // path used to fall through writeManifestForTerminalState (which returns false
  // on conflict) into a restoreCurrentListVisibility re-sync of the foreign row.
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
      restoreCurrentListVisibility(reader, args),
    );
    return { committed: false, published: false };
  }

  if (state.canPublishVisibility) {
    await reconcileVisibility(opts.defensive, async () => {
      await run("write_indexes", () =>
        reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, args.keyPrefix)),
      );
      if (opts.vector && similarity) {
        await run("upsert_vector", () =>
          similarity.upsert(args.id, opts.vector!.embedding, opts.vector!.meta),
        );
      }
    });
    return { committed: true, published: true };
  }

  if (state.canRemoveVisibility) {
    await reconcileVisibility(opts.defensive, async () => {
      if (similarity) await removeAttemptVisibility(reader, similarity, args);
      else await removeAttemptListVisibility(reader, args);
    });
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
  const activeAttemptId = manifest?.active_attempt?.id;
  const attemptId = args.attemptId ?? `at_${args.id}`;
  const legacyPendingWithoutAttempt = activeAttemptId === undefined && manifest?.status === "pending";
  const lastAttemptMatches = opts.allowLastAttempt === true && manifest?.last_attempt?.id === attemptId;
  const activeAttemptMatches = activeAttemptId === attemptId || legacyPendingWithoutAttempt || lastAttemptMatches;
  const activeAttemptConflict = activeAttemptId !== undefined && activeAttemptId !== attemptId;
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
    canWriteManifest: activeAttemptMatches || !manifest,
    canPublishVisibility: ownerAllowsVisibility && activeAttemptMatches,
    canRemoveVisibility: !activeAttemptConflict && (activeAttemptMatches || !manifest),
    ...(stored ? { manifestEtag: stored.etag } : {}),
  };
}

async function readingCanWriteAttemptArtifacts(
  reader: ReadingStore,
  args: ProcessReadingArgs,
): Promise<boolean> {
  const manifest = await reader.readManifest(args.keyPrefix);
  if (!manifest) return true;
  const activeAttemptId = manifest.active_attempt?.id;
  const attemptId = args.attemptId ?? `at_${args.id}`;
  return activeAttemptId === attemptId || (activeAttemptId === undefined && manifest.status === "pending");
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

async function restoreCurrentListVisibility(
  reader: ReadingStore,
  args: ProcessReadingArgs,
): Promise<void> {
  const manifest = await reader.readManifest(args.keyPrefix);
  if (!manifest) return;
  await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, args.keyPrefix));
}

export async function removeAttemptVisibility(
  reader: ReadingStore,
  similarity: SimilarityStore,
  args: ProcessReadingArgs,
): Promise<void> {
  if (!(await removeAttemptListVisibility(reader, args))) return;
  if (!(await readingCanRemoveAttemptVector(reader, args))) return;
  await similarity.delete(args.id);
}

async function removeAttemptListVisibility(
  reader: ReadingStore,
  args: ProcessReadingArgs,
): Promise<boolean> {
  let removed = false;
  await reader.removeListIndexItemIf(args.id, (item) => {
    const matches = listItemBelongsToAttempt(args, item);
    removed = removed || matches;
    return matches;
  });
  return removed;
}

async function readingCanRemoveAttemptVector(
  reader: ReadingStore,
  args: ProcessReadingArgs,
): Promise<boolean> {
  const manifest = await reader.readManifest(args.keyPrefix);
  if (!manifest) return true;
  return manifestBelongsToAttempt(args, manifest);
}

export function listItemBelongsToAttempt(
  args: ProcessReadingArgs,
  item: ListIndexItem,
): boolean {
  if (item.id !== args.id || item.key_prefix !== args.keyPrefix) return false;
  const attemptId = args.attemptId ?? `at_${args.id}`;
  if (item.active_attempt?.id === attemptId) return true;
  if (item.last_attempt?.id === attemptId) return true;
  return item.active_attempt === undefined && item.last_attempt === undefined && item.status === "pending";
}

export function manifestBelongsToAttempt(args: ProcessReadingArgs, manifest: Manifest): boolean {
  const attemptId = args.attemptId ?? `at_${args.id}`;
  if (manifest.active_attempt?.id === attemptId) return true;
  if (manifest.last_attempt?.id === attemptId) return true;
  // Match the list-row gate's stricter vacant-pending rule: a manifest carrying
  // a last_attempt was touched by another attempt, so we may not own its vector.
  return (
    manifest.active_attempt === undefined &&
    manifest.last_attempt === undefined &&
    manifest.status === "pending"
  );
}

export function newAttemptId(services: Services): string {
  return `at_${services.newId()}`;
}

export function newAttemptSummary(
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
  const id = args.attemptId ?? `at_${args.id}`;
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

function summarizeAttempt(attempt: ProcessingAttempt): ProcessingAttemptSummary {
  const summary: ProcessingAttemptSummary = {
    id: attempt.id,
    trigger: attempt.trigger,
    status: attempt.status,
    started_at: attempt.started_at,
  };
  if (attempt.stage) summary.stage = attempt.stage;
  if (attempt.finished_at) summary.finished_at = attempt.finished_at;
  if (attempt.error) summary.error = attempt.error;
  return summary;
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
