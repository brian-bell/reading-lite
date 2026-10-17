import type { ProcessReadingEnvelopeV1 } from "../control-plane/envelope";
import type { AuthenticatedPrincipal } from "../control-plane/principal";
import type { ProviderName } from "../control-plane/provider-credentials";
import { BlockedHostError } from "../modules/extractor/errors";
import { assertSafeUrl } from "../modules/extractor/safe-fetch";
import { applyStaleness } from "../modules/staleness";
import type { ContentStore } from "../modules/stores/content-store";
import { r2KeyLayout } from "../modules/stores/layout";
import type { PgReadingStore, ReadingSnapshot } from "../modules/stores/postgres/reading-store";
import type { NewAttempt, PgReadingWriter } from "../modules/stores/postgres/reading-writer";
import {
  newAttemptId,
  newReadingArgs,
  type ProcessReadingArgs,
  type ProcessReadingSource,
} from "../process-reading";
import {
  importPending,
  reprocessPending,
  submitPending,
} from "../modules/manifest-drafting";
import type { Manifest } from "../schemas/manifest";
import { sha256Hex, type Services } from "../services";
import type { TenantUsage, UsageDecision } from "../control-plane/tenant-usage-guard";
import {
  activateAttempt,
  captureArtifacts,
  discardArtifacts,
  type ActivationArtifacts,
  type ActivationOutcome,
} from "./activation";

// Reading intake: the write-side front door for a reading. The three verbs —
// submit, importMarkdown, reprocess — own the claim → attempt → activation
// ordering and return an HTTP-free IntakeOutcome the router (a thin adapter)
// maps onto statuses. Inputs arrive already parsed: zod body validation, the
// email defaults, and env parsing all stay at the HTTP seam. The read paths
// (list/detail/content/lookup) stay outside intake.
//
// URL ownership is a PostgreSQL uniqueness constraint (ADR 0005). A claim
// commits the reading, its URL row, the attempt and the job in one
// transaction, so an owner is never half-written: the old `initializing`
// outcome and the pointer-CAS contention outcomes no longer exist. Two
// submissions of one URL converge on the reading whose claim committed first.
//
// Intake also enforces the extractor's categorical URL policy (assertSafeUrl):
// a URL with userinfo or a blocked literal host can never extract, so submit
// refuses it before claiming and reprocess refuses to start a URL-backed
// attempt for one. importMarkdown keeps accepting such source URLs — they are
// identity only and are never fetched.

type MarkdownSource = Extract<ProcessReadingSource, { kind: "markdown" }>;

// How many times a verb re-resolves ownership when the owner it found was
// purged before it could be loaded. Each pass is a fresh read, so this only
// bounds a pathological purge/submit loop.
const OWNER_RESOLVE_ATTEMPTS = 3;

// A lost claim: re-resolve the owner instead of answering.
const RETRY: unique symbol = Symbol("retry");

/**
 * Every way an intake verb can end. `activated`/`unavailable(activation_*)`
 * come from the activation half (./activation.ts); the rest are decided here.
 *
 * - `activated`     — an attempt was committed and enqueued (→ 202).
 * - `existing`      — a non-failed owner already holds the URL; its
 *                     stale-annotated manifest is returned (→ 200).
 * - `conflict`      — the reading cannot accept this attempt right now (→ 409).
 * - `invalid_url`   — the URL fails the extractor's categorical safe-fetch
 *                     guard (userinfo, blocked literal host), so no slot is
 *                     claimed and no attempt starts (→ 400). Reached from
 *                     submit and from URL-backed reprocess of stored readings.
 * - `not_found`     — reprocess only: the id does not resolve (→ 404).
 * - `unavailable`   — retryable service condition (→ 503): the queue binding is
 *                     absent, ownership kept changing hands, or activation
 *                     failed after the rollback ran.
 * - `rate_limited` / `quota_exhausted` — tenant ingress ceilings (→ 429).
 * - `guard_unavailable` — missing limits or usage guard (→ 429, fail closed).
 * - `tenant_inactive` — the account stopped being active between admission and
 *                     the claim transaction, which committed nothing (→ 403).
 * - `too_large`     — importMarkdown only, when the caller passed `fitsMessage`:
 *                     the queue message this import would send does not fit,
 *                     so nothing was written or reserved (→ 413).
 */
export type IntakeOutcome =
  | ActivationOutcome
  | { kind: "existing"; manifest: Manifest }
  | { kind: "conflict"; reason: "active_attempt" | "missing_markdown" }
  | { kind: "invalid_url"; reason: string }
  | { kind: "not_found" }
  | { kind: "unavailable"; reason: "queue_unbound" | "claim_contention" }
  | { kind: "rate_limited"; limit: "request_rate"; resetAtMs: number }
  | { kind: "quota_exhausted"; limit: "hourly" | "monthly"; resetAtMs: number }
  | { kind: "guard_unavailable" }
  | { kind: "provider_key_required"; provider: ProviderName }
  | { kind: "tenant_inactive" }
  | { kind: "too_large" };

// The Markdown fields an import forwards in its queue message, with the title
// already resolved (a failed owner's title stands in for a missing one).
export interface ForwardedMarkdown {
  source_url: string;
  title?: string;
  markdown: string;
}

// importMarkdown's options. `fitsMessage` measures the message before anything
// is written: inbox promote passes it, because an untitled item promoted over
// a failed owner carries that owner's title, which stage may never have seen.
// Without it (the REST import) an oversized message fails at the send, as it
// always has.
export interface ImportMarkdownOptions {
  title?: string;
  email: boolean;
  fitsMessage?: (fields: ForwardedMarkdown) => boolean;
}

export interface ReadingIntakeDeps {
  /** Tenant-scoped stores — hosted callers build them from a TenantContext. */
  store: PgReadingStore;
  writer: PgReadingWriter;
  content: ContentStore;
  /** null when the environment has no Queue binding (local wrangler dev). */
  queue: Queue<ProcessReadingEnvelopeV1> | null;
  services: Services;
  /** Parsed once at the seam from PENDING_TTL_SECONDS. */
  pendingTtlSeconds: number;
  principal: AuthenticatedPrincipal;
  /** Tenant-keyed ingress quotas. Missing/deny fails closed. */
  usage: TenantUsage;
  providerKeyNeeded: () => Promise<ProviderName | null>;
}

export function readingIntakeFor(deps: ReadingIntakeDeps): ReadingIntake {
  return new ReadingIntake(deps);
}

// The owner as loaded: the manifest a verb decides on and the row version
// startAttempt checks under its lock.
type Owner = ReadingSnapshot;

const layout = r2KeyLayout("");

export class ReadingIntake {
  constructor(private readonly deps: ReadingIntakeDeps) {}

  async submit(url: string, opts: { email: boolean }): Promise<IntakeOutcome> {
    const gated = await this.gateRequest();
    if (gated) return gated;
    return this.resolving(url, {
      owned: (owner) => this.submitOwned(owner, opts.email),
      unclaimed: (retry) => this.createForSubmit(url, opts.email, retry),
    });
  }

  async importMarkdown(url: string, markdown: string, opts: ImportMarkdownOptions): Promise<IntakeOutcome> {
    const gated = await this.gateRequest();
    if (gated) return gated;
    return this.resolving(url, {
      owned: (owner) => this.importOwned(owner, markdown, opts),
      unclaimed: (retry) => this.createForImport(url, markdown, opts, retry),
    });
  }

  async reprocess(
    id: string,
    opts: { force?: boolean; email: boolean; source?: MarkdownSource },
  ): Promise<IntakeOutcome> {
    const gated = await this.gateRequest();
    if (gated) return gated;
    // A reading changed under the start (see startAttempt) is re-read and
    // decided again; one purged meanwhile is a 404 on the next pass.
    for (let pass = 0; pass < OWNER_RESOLVE_ATTEMPTS; pass++) {
      const found = await this.deps.store.loadReadingById(id);
      if (!found) return { kind: "not_found" };
      const out = await this.reprocessManifest(found, opts);
      if (out !== RETRY) return out;
    }
    return { kind: "unavailable", reason: "claim_contention" };
  }

  // Who owns this URL decides the verb. A claim that loses to a concurrent
  // submission hands back `RETRY`, and so does an owner purged or changed
  // between the lookup and the start; the next pass sees the settled owner
  // (or a free URL).
  private async resolving(
    url: string,
    on: {
      owned: (owner: Owner) => Promise<IntakeOutcome | typeof RETRY>;
      unclaimed: (retry: typeof RETRY) => Promise<IntakeOutcome | typeof RETRY>;
    },
  ): Promise<IntakeOutcome> {
    for (let pass = 0; pass < OWNER_RESOLVE_ATTEMPTS; pass++) {
      const owner = await this.deps.store.findOwnerByUrl(url);
      if (!owner) {
        const out = await on.unclaimed(RETRY);
        if (out !== RETRY) return out;
        continue;
      }
      const found = await this.deps.store.loadReadingById(owner.id);
      if (!found) continue;
      const out = await on.owned(found);
      if (out !== RETRY) return out;
    }
    return { kind: "unavailable", reason: "claim_contention" };
  }

  private annotate(manifest: Manifest): Manifest {
    return applyStaleness(
      manifest,
      this.deps.pendingTtlSeconds,
      this.deps.services.now(),
    );
  }

  private async gateRequest(): Promise<IntakeOutcome | null> {
    const denied = this.usageOutcome(await this.deps.usage.admitRequest(nowMs(this.deps.services)));
    if (denied) return denied;
    const provider = await this.deps.providerKeyNeeded();
    if (provider) return { kind: "provider_key_required", provider };
    return null;
  }

  private usageOutcome(decision: UsageDecision): IntakeOutcome | null {
    return usageDenial(decision, this.deps.services);
  }

  private async reserveForActivation(opId: string): Promise<IntakeOutcome | null> {
    return this.usageOutcome(await this.deps.usage.reserveReading(opId, nowMs(this.deps.services)));
  }

  private async releaseSlot(opId: string): Promise<void> {
    try {
      await this.deps.usage.releaseReading(opId);
    } catch {
      // Conservative: an uncertain release leaves the held slot counted.
    }
  }

  // Holds the reading slot across `run` and releases it unless the attempt was
  // enqueued. Covers every non-activated outcome, a lost claim, and a throw.
  private async withReservedSlot<T extends IntakeOutcome | typeof RETRY>(
    opId: string,
    run: () => Promise<T>,
  ): Promise<T | IntakeOutcome> {
    const denied = await this.reserveForActivation(opId);
    if (denied) return denied;
    let out: T | undefined;
    try {
      out = await run();
      return out;
    } finally {
      if (out === RETRY || (out as IntakeOutcome | undefined)?.kind !== "activated") {
        await this.releaseSlot(opId);
      }
    }
  }

  // A submit that lands on a settled owner: ready/pending owners return the
  // existing manifest; failed owners reprocess in place (same reading id).
  private async submitOwned(owner: Owner, email: boolean): Promise<IntakeOutcome | typeof RETRY> {
    const effective = this.annotate(owner.manifest);
    if (effective.status !== "failed") {
      return { kind: "existing", manifest: effective };
    }
    return this.reprocessManifest(owner, { email });
  }

  private async createForSubmit(
    url: string,
    email: boolean,
    retry: typeof RETRY,
  ): Promise<IntakeOutcome | typeof RETRY> {
    // Only a genuinely new claim enforces the extractor's categorical URL
    // policy: an existing owner still resolves normally in submit() above — a
    // userinfo source_url that was markdown-imported is a valid owner, and a
    // failed one reaches reprocessManifest's own guard.
    const rejected = unsafeUrlOutcome(url);
    if (rejected) return rejected;
    const args = await newReadingArgs(url, this.deps.services);
    const attemptStartedAt = this.deps.services.now();
    const attemptId = newAttemptId(this.deps.services);
    // ProcessReadingArgs satisfies ReadingIdentity structurally.
    const { manifest: pendingManifest, attempt: activeAttempt } = submitPending(
      args,
      { attemptId, startedAt: attemptStartedAt },
    );
    const queue = this.deps.queue;
    if (!queue) return { kind: "unavailable", reason: "queue_unbound" };

    const queueMessage: ProcessReadingArgs = { ...args, attemptId, attemptStartedAt, trigger: "submit", email };
    return this.withReservedSlot(attemptId, async () => {
      const claimed = await this.deps.writer.claimUrl(pendingManifest, args.keyPrefix, {
        summary: activeAttempt,
        payload: queueMessage,
      });
      if (claimed.kind === "tenant_inactive") return { kind: "tenant_inactive" } satisfies IntakeOutcome;
      if (claimed.kind === "owned") return retry;
      return activateAttempt(this.deps, queue, this.deps.services, {
        manifest: pendingManifest,
        rollbackManifest: pendingManifest,
        rollbackAttempt: activeAttempt,
        queueMessage,
        principal: this.deps.principal,
      });
    });
  }

  // An import that lands on a settled owner: ready/pending owners return the
  // existing manifest; failed owners re-import the supplied markdown in place.
  private async importOwned(
    owner: Owner,
    markdown: string,
    opts: ImportMarkdownOptions,
  ): Promise<IntakeOutcome | typeof RETRY> {
    const effective = this.annotate(owner.manifest);
    if (effective.status !== "failed") {
      return { kind: "existing", manifest: effective };
    }
    const queue = this.deps.queue;
    if (!queue) return { kind: "unavailable", reason: "queue_unbound" };

    const attemptStartedAt = this.deps.services.now();
    const attemptId = newAttemptId(this.deps.services);
    const markdownBytes = new TextEncoder().encode(markdown);
    const { manifest: pendingManifest, attempt: activeAttempt } = importPending(
      {
        id: effective.id,
        url: effective.url,
        urlHash: effective.url_hash,
        createdAt: effective.created_at,
      },
      { attemptId, startedAt: attemptStartedAt },
      {
        bytes: markdownBytes.byteLength,
        sha256: await sha256Hex(markdown),
        ...(opts.title === undefined ? {} : { title: opts.title }),
      },
      { over: effective },
    );
    const source: MarkdownSource = {
      kind: "markdown",
      markdown,
      // The drafted title already resolved the supplied-vs-prior fallback.
      ...(pendingManifest.title === undefined ? {} : { title: pendingManifest.title }),
    };
    if (!fitsMessage(opts, effective.url, source)) return { kind: "too_large" };
    const args: ProcessReadingArgs = {
      id: effective.id,
      url: effective.url,
      urlHash: effective.url_hash,
      createdAt: effective.created_at,
      keyPrefix: owner.keyPrefix,
      source,
      attemptId,
      attemptStartedAt,
      trigger: "import",
      email: opts.email,
    };
    const artifacts = markdownArtifacts(owner.keyPrefix, attemptId, markdown, markdownBytes);

    return this.withReservedSlot(attemptId, async () => {
      // Content first; the failed owner is untouched if it never lands.
      if (!(await this.captureImport(artifacts))) {
        return { kind: "unavailable", reason: "activation_failed", id: effective.id } satisfies IntakeOutcome;
      }
      const started = await this.deps.writer.startAttempt(
        pendingManifest,
        newAttempt(activeAttempt, args, artifacts),
        owner,
      );
      if (started.kind !== "started") {
        await discardArtifacts(this.deps.content, artifacts).catch((err) => console.error(err));
        return startRefused(started.kind);
      }
      return activateAttempt(this.deps, queue, this.deps.services, {
        manifest: pendingManifest,
        // Rollback lands on the freshly-built pending manifest (→ failed,
        // retryable), never the prior failed manifest's error.
        rollbackManifest: pendingManifest,
        rollbackAttempt: activeAttempt,
        queueMessage: args,
        principal: this.deps.principal,
      });
    });
  }

  // The import's content, in R2 before any row points at it. False when it
  // did not land: whatever part did is swept, and the caller answers
  // activation_failed without having written a row.
  private async captureImport(artifacts: ActivationArtifacts): Promise<boolean> {
    try {
      await captureArtifacts(this.deps.content, artifacts);
      return true;
    } catch (err) {
      console.error(err);
      await discardArtifacts(this.deps.content, artifacts).catch((e) => console.error(e));
      return false;
    }
  }

  private async createForImport(
    url: string,
    markdown: string,
    opts: ImportMarkdownOptions,
    retry: typeof RETRY,
  ): Promise<IntakeOutcome | typeof RETRY> {
    const source: MarkdownSource = {
      kind: "markdown",
      markdown,
      ...(opts.title === undefined ? {} : { title: opts.title }),
    };
    if (!fitsMessage(opts, url, source)) return { kind: "too_large" };
    const args = await newReadingArgs(url, this.deps.services, source);
    const attemptStartedAt = this.deps.services.now();
    const attemptId = newAttemptId(this.deps.services);
    const markdownBytes = new TextEncoder().encode(markdown);
    const { manifest: pendingManifest, attempt: activeAttempt } = importPending(
      args,
      { attemptId, startedAt: attemptStartedAt },
      {
        bytes: markdownBytes.byteLength,
        sha256: await sha256Hex(markdown),
        ...(opts.title === undefined ? {} : { title: opts.title }),
      },
    );
    const queue = this.deps.queue;
    if (!queue) return { kind: "unavailable", reason: "queue_unbound" };

    const queueMessage: ProcessReadingArgs = { ...args, attemptId, attemptStartedAt, trigger: "import", email: opts.email };
    const artifacts = markdownArtifacts(args.keyPrefix, attemptId, markdown, markdownBytes);
    return this.withReservedSlot(attemptId, async () => {
      // Content first, under a prefix only this claim would ever point at.
      if (!(await this.captureImport(artifacts))) {
        return { kind: "unavailable", reason: "activation_failed" } satisfies IntakeOutcome;
      }
      const claimed = await this.deps.writer.claimUrl(
        pendingManifest,
        args.keyPrefix,
        newAttempt(activeAttempt, queueMessage, artifacts),
      );
      if (claimed.kind !== "claimed") {
        await discardArtifacts(this.deps.content, artifacts).catch((err) => console.error(err));
        if (claimed.kind === "tenant_inactive") return { kind: "tenant_inactive" } satisfies IntakeOutcome;
        return retry;
      }
      return activateAttempt(this.deps, queue, this.deps.services, {
        manifest: pendingManifest,
        rollbackManifest: pendingManifest,
        rollbackAttempt: activeAttempt,
        queueMessage,
        principal: this.deps.principal,
      });
    });
  }

  private async reprocessManifest(
    owner: Owner,
    opts: { force?: boolean; email: boolean; source?: MarkdownSource },
  ): Promise<IntakeOutcome | typeof RETRY> {
    const effective = this.annotate(owner.manifest);
    if (effective.active_attempt?.status === "running" && !opts.force) {
      return { kind: "conflict", reason: "active_attempt" };
    }
    // A URL-backed attempt runs assertSafeUrl on the stored url as its first
    // extraction step; refuse a categorically unfetchable one here instead of
    // flipping the reading pending and failing the attempt. Supplied or
    // stored markdown never fetches the url, so those paths stay open.
    if (opts.source === undefined && effective.source_type !== "markdown") {
      const rejected = unsafeUrlOutcome(effective.url);
      if (rejected) return rejected;
    }
    const queue = this.deps.queue;
    if (!queue) return { kind: "unavailable", reason: "queue_unbound" };

    const attemptStartedAt = this.deps.services.now();
    const attemptId = newAttemptId(this.deps.services);
    const { manifest: nextManifest, attempt: activeAttempt } = reprocessPending(
      effective,
      { attemptId, startedAt: attemptStartedAt },
      this.deps.services.now(),
    );
    // A request-supplied markdown source wins over the stored-markdown synthesis:
    // the caller is handing us better content than R2 holds, so we never read
    // the stored markdown (and the missing_markdown conflict below can only
    // fire for a no-source reprocess of a markdown reading).
    let source: ProcessReadingSource | undefined = opts.source;
    if (source === undefined && effective.source_type === "markdown") {
      // Through the row's keys, so an imported reading whose content sits at
      // the legacy spelling reprocesses the same as one on revision keys.
      const keys = await this.deps.store.contentKeys(effective.id);
      const extracted = keys?.extractedKey ? await this.deps.content.get(keys.extractedKey) : null;
      if (!extracted) {
        return { kind: "conflict", reason: "missing_markdown" };
      }
      source = {
        kind: "markdown",
        markdown: await extracted.text(),
        ...(effective.title === undefined ? {} : { title: effective.title }),
      };
    }
    const args: ProcessReadingArgs = {
      id: effective.id,
      url: effective.url,
      urlHash: effective.url_hash,
      createdAt: effective.created_at,
      keyPrefix: owner.keyPrefix,
      source,
      attemptId,
      attemptStartedAt,
      trigger: "reprocess",
      // Legacy manifests omit source_type and are treated as URL-backed by the
      // no-source path above, so snapshot that same effective default.
      sourceTypeOnFailure: effective.source_type ?? "url",
      email: opts.email,
    };
    return this.withReservedSlot(attemptId, async () => {
      // The row as loaded, not the stale-annotated one: a forced or expired
      // attempt is still what the row holds until this one replaces it.
      const started = await this.deps.writer.startAttempt(
        nextManifest,
        { summary: activeAttempt, payload: args },
        owner,
      );
      if (started.kind !== "started") return startRefused(started.kind);
      return activateAttempt(this.deps, queue, this.deps.services, {
        manifest: nextManifest,
        rollbackManifest: effective,
        rollbackAttempt: activeAttempt,
        queueMessage: args,
        principal: this.deps.principal,
      });
    });
  }
}

function newAttempt(
  summary: NewAttempt["summary"],
  payload: ProcessReadingArgs,
  artifacts: ActivationArtifacts,
): NewAttempt {
  return { summary, payload, content: { rawKey: artifacts.rawKey, extractedKey: artifacts.extractedKey } };
}

function markdownArtifacts(
  keyPrefix: string,
  attemptId: string,
  markdown: string,
  bytes: Uint8Array,
): ActivationArtifacts {
  return {
    revisionPrefix: `${layout.revisionsPrefix(keyPrefix)}${attemptId}/`,
    rawKey: layout.revisionRawKey(keyPrefix, attemptId, "md"),
    rawBytes: bytes,
    rawContentType: "text/markdown; charset=utf-8",
    extractedKey: layout.revisionExtractedKey(keyPrefix, attemptId),
    extractedMarkdown: markdown,
  };
}

// startAttempt lost under the row lock. Another attempt that activated after
// this request read the reading is a conflict. A reading purged or changed
// since goes back to the caller's loop to be resolved again: a purged owner
// frees its URL for a fresh claim, and a changed one is re-read.
function startRefused(
  kind: "not_found" | "conflict" | "changed" | "tenant_inactive",
): IntakeOutcome | typeof RETRY {
  if (kind === "conflict") return { kind: "conflict", reason: "active_attempt" };
  if (kind === "tenant_inactive") return { kind: "tenant_inactive" };
  return RETRY;
}

// Measured on the source the import will forward, so the title is the one the
// message carries, not the one the caller supplied.
function fitsMessage(opts: ImportMarkdownOptions, url: string, source: MarkdownSource): boolean {
  if (!opts.fitsMessage) return true;
  return opts.fitsMessage({
    source_url: url,
    ...(source.title === undefined ? {} : { title: source.title }),
    markdown: source.markdown,
  });
}

export type UsageDenial = Extract<IntakeOutcome, { kind: "rate_limited" | "quota_exhausted" | "guard_unavailable" }>;

// A usage guard's refusal as an outcome, or null when it admitted. Shared with
// inbox stage, so every write verb maps a denial the same way.
export function usageDenial(decision: UsageDecision, services: { now: () => string }): UsageDenial | null {
  if (decision.ok) return null;
  if (decision.reason === "request_rate") {
    return { kind: "rate_limited", limit: "request_rate", resetAtMs: decision.resetAtMs ?? nowMs(services) };
  }
  if (decision.reason === "hourly" || decision.reason === "monthly") {
    return { kind: "quota_exhausted", limit: decision.reason, resetAtMs: decision.resetAtMs ?? nowMs(services) };
  }
  return { kind: "guard_unavailable" };
}

export function nowMs(services: { now: () => string }): number {
  const parsed = Date.parse(services.now());
  return Number.isFinite(parsed) ? parsed : Date.now();
}

// The extractor's safe-fetch guard rejects some URLs categorically — scheme,
// userinfo, blocked literal hosts. Claiming a URL or starting an attempt for
// one can only end in a deterministic failure, so the intake verbs run the
// same predicate up front. assertSafeUrl is pure (no DNS), and
// BlockedHostError already redacts userinfo, so the reason is safe to return.
function unsafeUrlOutcome(url: string): IntakeOutcome | null {
  try {
    assertSafeUrl(url);
    return null;
  } catch (err) {
    if (err instanceof BlockedHostError) {
      return { kind: "invalid_url", reason: err.reason };
    }
    throw err;
  }
}
