import {
  ManifestSchema,
  type ContentStatus,
  type Manifest,
  type ProcessingAttemptSummary,
  type ProcessingAttemptTrigger,
  type ReadingSummary,
  type SimilaritySnapshot,
  type SourceType,
  type SummarizationUsage,
} from "../schemas/manifest";
import { normalizeTags } from "./tags";

// Manifest drafting: the pure constructors for every Manifest the system
// writes. One constructor per family — pending drafts for the three intake
// verbs, the queue-send rollback, and the terminal builders shared by the
// realtime worker and the offline batch write phase — so the placeholder
// conventions, field ordering, and attempt stamping are spelled exactly once
// instead of mirrored across pipelines.
//
// A vocabulary module in the attempt-ownership.ts sense: below intake,
// process-reading, and scripts/corpus-lib/batch, depending only on the
// manifest schema and tag normalization. No I/O, no Env, no clock, no id
// minting — time and attempt identity arrive as arguments, which is what lets
// the same file load in the Worker and in Node scripts, and what makes every
// constructor deterministic under test.
//
// The module drafts; it does not decide. Choosing a rollback target, gating on
// attempt ownership, claiming or releasing pointers, and every write stay with
// callers.
//
// Every returned Manifest has passed ManifestSchema.parse — a draft the stored
// schema would reject throws here, at construction, not at read time.

/**
 * Who the reading is. Deliberately camelCase: ProcessReadingArgs (worker,
 * intake) and the batch SidecarTarget both satisfy it structurally, so callers
 * pass the object they already hold.
 */
export interface ReadingIdentity {
  id: string;
  url: string;
  urlHash: string;
  createdAt: string;
}

/** Identity of one attempt, minted by the caller (ids and clocks are Services). */
export interface AttemptRef {
  attemptId: string;
  startedAt: string;
}

/**
 * A pending draft plus the running attempt summary stamped into it, returned
 * as a pair because activateAttempt needs both (manifest + rollbackAttempt).
 * Invariant: manifest.active_attempt deep-equals attempt.
 */
export interface PendingDraft {
  manifest: Manifest;
  attempt: ProcessingAttemptSummary;
}

/**
 * The empty-content placeholder convention, single-homed. content_status is
 * deliberately absent: it is per-path — pending drafts stamp "captured",
 * failure defaults stamp "failed" — and each constructor stamps its own.
 */
export const EMPTY_CONTENT = Object.freeze({
  content_type: "application/octet-stream",
  content_bytes: 0,
  content_sha256: "0".repeat(64),
});

function runningAttempt(
  ref: AttemptRef,
  trigger: ProcessingAttemptTrigger,
): ProcessingAttemptSummary {
  return {
    id: ref.attemptId,
    trigger,
    status: "running",
    stage: "queued",
    started_at: ref.startedAt,
  };
}

function pendingContent(): { content_status: ContentStatus } & typeof EMPTY_CONTENT {
  return { ...EMPTY_CONTENT, content_status: "captured" };
}

export const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

/** The content facts of a supplied markdown body. Hashing is async and stays
 *  with the caller — constructors are synchronous and pure. */
export interface MarkdownFacts {
  bytes: number;
  sha256: string;
  title?: string;
}

/** Fresh submit: url-sourced pending with the empty-content placeholder. */
export function submitPending(
  identity: ReadingIdentity,
  attempt: AttemptRef,
): PendingDraft {
  const active = runningAttempt(attempt, "submit");
  const manifest = ManifestSchema.parse({
    id: identity.id,
    url: identity.url,
    url_hash: identity.urlHash,
    source_type: "url",
    status: "pending",
    active_attempt: active,
    ...pendingContent(),
    created_at: identity.createdAt,
    updated_at: identity.createdAt,
  });
  return { manifest, attempt: active };
}

/**
 * Import: markdown-sourced pending with real content facts. `over` is the
 * failed owner being re-imported in place: its fields carry forward with
 * `error` and `active_attempt` stripped, the supplied title (falling back to
 * the owner's) and markdown content replacing theirs, and updated_at moving to
 * the attempt start. Omitted for a fresh claim, where the draft is built from
 * identity alone and stamped created_at = updated_at. Choosing WHETHER to
 * re-import stays with Reading intake; this only drafts the result.
 */
export function importPending(
  identity: ReadingIdentity,
  attempt: AttemptRef,
  markdown: MarkdownFacts,
  opts: { over?: Manifest } = {},
): PendingDraft {
  const active = runningAttempt(attempt, "import");
  const over = opts.over;
  if (over && over.id !== identity.id) {
    throw new Error(
      `importPending: over.id ${over.id} does not match identity.id ${identity.id}`,
    );
  }
  const base = over ? stripAttemptState(over) : null;
  const title = markdown.title ?? base?.title;
  const manifest = ManifestSchema.parse({
    ...(base ?? {
      id: identity.id,
      url: identity.url,
      url_hash: identity.urlHash,
      created_at: identity.createdAt,
    }),
    source_type: "markdown",
    status: "pending",
    active_attempt: active,
    ...(title === undefined ? {} : { title }),
    content_type: MARKDOWN_CONTENT_TYPE,
    content_status: "captured",
    content_bytes: markdown.bytes,
    content_sha256: markdown.sha256,
    updated_at: over ? attempt.startedAt : identity.createdAt,
  });
  return { manifest, attempt: active };
}

/**
 * Reprocess: the two-branch transformation intake stamps before re-enqueueing.
 * A ready prior keeps its full summary visible under the running attempt
 * (spread + active_attempt + updated_at); a non-ready prior resets to a
 * skeleton pending — identity, source_type, title, and last_attempt kept, the
 * empty-content placeholder restored. The branch is a total function of the
 * prior's status; WHICH manifest to reprocess stays with the caller.
 */
export function reprocessPending(
  prior: Manifest,
  attempt: AttemptRef,
  now: string,
): PendingDraft {
  const active = runningAttempt(attempt, "reprocess");
  const manifest = ManifestSchema.parse(
    prior.status === "ready"
      ? { ...prior, active_attempt: active, updated_at: now }
      : {
          id: prior.id,
          url: prior.url,
          url_hash: prior.url_hash,
          ...(prior.source_type === undefined ? {} : { source_type: prior.source_type }),
          status: "pending",
          active_attempt: active,
          ...(prior.last_attempt === undefined ? {} : { last_attempt: prior.last_attempt }),
          ...(prior.title === undefined ? {} : { title: prior.title }),
          ...pendingContent(),
          created_at: prior.created_at,
          updated_at: now,
        },
  );
  return { manifest, attempt: active };
}

/**
 * The activation-funnel rollback: the attempt died at the queue send, before
 * processing began. A ready target stays ready with active_attempt cleared and
 * the failed attempt stamped as last_attempt; anything else flips to failed
 * with a retryable QueueSendError (content_status flips to "failed" only when
 * the target was pending — a raw_only capture stays raw_only). Owns the
 * QueueSendError literal because it is invariant at this seam. Choosing the
 * rollback TARGET stays with Reading intake.
 */
export function queueSendRollback(
  target: Manifest,
  activeAttempt: ProcessingAttemptSummary,
  cause: unknown,
  now: string,
): Manifest {
  const error = {
    code: "QueueSendError",
    // `||` on purpose: new Error() has an empty message, and the rollback must
    // not fail schema validation on it.
    message: (cause instanceof Error ? cause.message : "") || "queue send failed",
    stage: "queued" as const,
    failed_at: now,
    retryable: true,
  };
  const failedAttempt: ProcessingAttemptSummary = {
    ...activeAttempt,
    status: "failed",
    stage: "queued",
    finished_at: now,
    error,
  };

  if (target.status === "ready") {
    return ManifestSchema.parse({
      ...stripAttemptState(target),
      last_attempt: failedAttempt,
      updated_at: now,
    });
  }
  return ManifestSchema.parse({
    ...stripAttemptState(target),
    status: "failed",
    last_attempt: failedAttempt,
    error,
    ...(target.status === "pending" ? { content_status: "failed" } : {}),
    updated_at: now,
  });
}

/**
 * What was captured. Deliberately snake_case: these land verbatim in the
 * Manifest, and the worker's extract result already carries the required
 * fields, so the hot path spreads straight in; batch maps its camelCase
 * sidecar fields at its own (rare) seam.
 */
export interface ContentFacts {
  content_type: string;
  content_status: ContentStatus;
  content_bytes: number;
  content_sha256: string;
  extracted_bytes?: number;
}

export interface ReadyFacts {
  identity: ReadingIdentity;
  sourceType: SourceType;
  /** Raw summarizer output; tags are normalized here — the drafter's only
   *  field transformation, so batch and worker can no longer drift on it. */
  summary: ReadingSummary;
  similarity?: SimilaritySnapshot;
  content: ContentFacts;
  usage: { summarization: SummarizationUsage; openai_embedding_tokens: number };
  /**
   * The finished attempt, stamped as last_attempt. `null` is the writer's
   * explicit statement that no identifiable attempt ran (the offline batch,
   * whose sidecars carry no attempt identity) — attempt identity is never
   * fabricated. Accepts the worker's full ProcessingAttempt directly; the
   * parse-on-return strips it to summary shape.
   */
  attempt: ProcessingAttemptSummary | null;
}

/** fetched_at and updated_at are both stamped `now`. Throws unless the passed
 *  attempt is a finished success — a ready manifest cannot cite a running or
 *  failed attempt as the run that produced it. */
export function readyManifest(facts: ReadyFacts, now: string): Manifest {
  requireTerminalAttempt(facts.attempt, "succeeded", "readyManifest");
  return ManifestSchema.parse({
    id: facts.identity.id,
    url: facts.identity.url,
    url_hash: facts.identity.urlHash,
    source_type: facts.sourceType,
    status: "ready",
    title: facts.summary.title,
    tldr: facts.summary.tldr,
    tags: normalizeTags(facts.summary.tags),
    keywords: facts.summary.keywords,
    people: facts.summary.people,
    orgs: facts.summary.orgs,
    novelty_verdict: facts.summary.novelty_verdict,
    ...(facts.similarity === undefined ? {} : { similarity: facts.similarity }),
    connections: facts.summary.connections,
    summary_markdown: facts.summary.summary_markdown,
    ...facts.content,
    fetched_at: now,
    created_at: facts.identity.createdAt,
    updated_at: now,
    ...(facts.attempt === null ? {} : { last_attempt: facts.attempt }),
    usage: facts.usage,
  });
}

/**
 * A terminal failed manifest. `content` defaults to the empty-content
 * placeholder with content_status "failed" — the worker failure path, where
 * extraction may never have happened; batch passes the real facts from its
 * sidecar target. Same attempt rule as readyManifest, requiring a finished
 * failed attempt (or an explicit null).
 */
export function failedManifest(
  identity: ReadingIdentity,
  facts: {
    sourceType: SourceType;
    error: Manifest["error"] & object;
    attempt: ProcessingAttemptSummary | null;
    content?: ContentFacts;
  },
  now: string,
): Manifest {
  requireTerminalAttempt(facts.attempt, "failed", "failedManifest");
  const content: ContentFacts =
    facts.content ?? { ...EMPTY_CONTENT, content_status: "failed" };
  return ManifestSchema.parse({
    id: identity.id,
    url: identity.url,
    url_hash: identity.urlHash,
    source_type: facts.sourceType,
    status: "failed",
    error: sanitizeManifestError(facts.error),
    ...content,
    created_at: identity.createdAt,
    updated_at: now,
    ...(facts.attempt === null ? {} : { last_attempt: sanitizeAttemptError(facts.attempt) }),
  });
}

/**
 * Failure drafting must never fail for representable inputs: error text
 * originates from unknown exceptions, and `new Error()` legitimately has an
 * empty message that ManifestErrorSchema (min-length 1) would reject —
 * throwing here would break the very recovery path being drafted. Empty
 * fields get stable fallbacks instead.
 */
function sanitizeManifestError<E extends { code: string; message: string }>(error: E): E {
  if (error.code !== "" && error.message !== "") return error;
  return {
    ...error,
    code: error.code === "" ? "unknown_error" : error.code,
    message: error.message === "" ? "unknown error" : error.message,
  };
}

function sanitizeAttemptError(
  attempt: ProcessingAttemptSummary,
): ProcessingAttemptSummary {
  if (attempt.error === undefined) return attempt;
  return { ...attempt, error: sanitizeManifestError(attempt.error) };
}

function requireTerminalAttempt(
  attempt: ProcessingAttemptSummary | null,
  status: "succeeded" | "failed",
  drafter: string,
): void {
  if (attempt === null) return;
  if (attempt.status !== status || attempt.finished_at === undefined) {
    throw new Error(
      `${drafter}: attempt must be a finished ${status} attempt (got status ${attempt.status})`,
    );
  }
}

/**
 * Preserve/roll-forward: restore a previously-ready Manifest after a failed
 * attempt so the reader keeps the good data. Clears active_attempt and
 * restamps updated_at; the failed attempt replaces last_attempt when given,
 * and `null` keeps the preserved one (a writer with no attempt identity).
 * Throws unless `preserved` is ready — rolling forward to anything else would
 * resurrect a failure as if it were good data. Capturing `preserved` before
 * the pending overwrite, and choosing it, stays with the caller.
 */
export function rollForward(
  preserved: Manifest,
  attempt: ProcessingAttemptSummary | null,
  now: string,
): Manifest {
  if (preserved.status !== "ready") {
    throw new Error(
      `rollForward: preserved manifest must be ready (got ${preserved.status})`,
    );
  }
  requireTerminalAttempt(attempt, "failed", "rollForward");
  const { active_attempt: _active, ...rest } = preserved;
  return ManifestSchema.parse({
    ...rest,
    ...(attempt === null ? {} : { last_attempt: sanitizeAttemptError(attempt) }),
    updated_at: now,
  });
}

/** Spread hygiene for drafting over a prior manifest: the carried-forward base
 *  never keeps the prior error or attempt-in-flight state. */
function stripAttemptState(manifest: Manifest): Omit<Manifest, "error" | "active_attempt"> {
  const { error: _error, active_attempt: _active, ...rest } = manifest;
  return rest;
}
