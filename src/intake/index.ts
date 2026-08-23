import type { ProcessReadingEnvelopeV1 } from "../control-plane/envelope";
import type { AuthenticatedPrincipal } from "../control-plane/principal";
import {
  OwnerResolutionContentionError,
  ReadingClaim,
} from "../modules/reading-claim";
import { applyStaleness } from "../modules/staleness";
import { ReadingStore } from "../modules/stores/reading-store";
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
import type { ByUrlPointer, Manifest } from "../schemas/manifest";
import { sha256Hex, type Services } from "../services";
import { activateAttempt, type ActivationOutcome } from "./activation";

// Reading intake: the write-side front door for a reading. The three verbs —
// submit, importMarkdown, reprocess — own the claim → pending-manifest →
// attempt-activation ordering that used to be spelled three near-identical
// times in router.ts, and return an HTTP-free IntakeOutcome the router (a thin
// adapter) maps onto statuses. Inputs arrive already parsed: zod body
// validation, the email defaults, and env parsing all stay at the HTTP seam.
// The read paths (list/detail/content/lookup) stay outside intake.

type MarkdownSource = Extract<ProcessReadingSource, { kind: "markdown" }>;

/**
 * Every way an intake verb can end. `activated`/`unavailable(activation_*)`
 * come from the activation half (./activation.ts); the rest are decided here.
 *
 * - `activated`     — an attempt was written and enqueued (→ 202).
 * - `existing`      — a non-failed owner already holds the URL; its
 *                     stale-annotated manifest is returned (→ 200).
 * - `initializing`  — a concurrent owner claimed the slot but has not written
 *                     its manifest yet (→ 409, poll the id).
 * - `conflict`      — the reading cannot accept this attempt right now (→ 409).
 * - `not_found`     — reprocess only: the id does not resolve (→ 404).
 * - `unavailable`   — retryable service condition (→ 503): the queue binding is
 *                     absent, ownership stayed contended, or activation failed
 *                     after the rollback funnel ran.
 */
export type IntakeOutcome =
  | ActivationOutcome
  | { kind: "existing"; manifest: Manifest }
  | { kind: "initializing"; id: string }
  | { kind: "conflict"; reason: "active_attempt" | "missing_markdown" }
  | { kind: "not_found" }
  | {
      kind: "unavailable";
      reason: "queue_unbound" | "claim_contention" | "owner_resolution_contention";
    };

export interface ReadingIntakeDeps {
  /** Tenant-scoped store — hosted callers build it via readingStoreFor. */
  reader: ReadingStore;
  /** null when the environment has no Queue binding (local wrangler dev). */
  queue: Queue<ProcessReadingEnvelopeV1> | null;
  services: Services;
  /** Parsed once at the seam from PENDING_TTL_SECONDS. */
  pendingTtlSeconds: number;
  principal: AuthenticatedPrincipal;
}

export function readingIntakeFor(deps: ReadingIntakeDeps): ReadingIntake {
  return new ReadingIntake(deps);
}

export class ReadingIntake {
  private readonly claim: ReadingClaim;

  constructor(private readonly deps: ReadingIntakeDeps) {
    this.claim = new ReadingClaim(deps.reader, deps.services);
  }

  async submit(url: string, opts: { email: boolean }): Promise<IntakeOutcome> {
    return this.guardContention(async () => {
      const owner = await this.claim.resolveOwner(url);
      switch (owner.kind) {
        case "owned":
          return this.submitOwned(owner.pointer, owner.manifest, opts.email);
        case "initializing":
          return { kind: "initializing", id: owner.pointer.id };
        case "unclaimed":
          return this.createForSubmit(url, opts.email, owner.replaceEtag);
      }
    });
  }

  async importMarkdown(
    url: string,
    markdown: string,
    opts: { title?: string; email: boolean },
  ): Promise<IntakeOutcome> {
    return this.guardContention(async () => {
      const owner = await this.claim.resolveOwner(url);
      switch (owner.kind) {
        case "owned":
          return this.importOwned(owner.pointer, owner.manifest, markdown, opts);
        case "initializing":
          return { kind: "initializing", id: owner.pointer.id };
        case "unclaimed":
          return this.createForImport(url, markdown, opts, owner.replaceEtag);
      }
    });
  }

  async reprocess(
    id: string,
    opts: { force?: boolean; email: boolean; source?: MarkdownSource },
  ): Promise<IntakeOutcome> {
    const found = await this.deps.reader.loadReadingById(id);
    if (!found) return { kind: "not_found" };
    return this.reprocessManifest(found.keyPrefix, found.manifest, opts);
  }

  // Bounded ownership-resolution contention is retryable, not an internal
  // fault — it surfaces as `unavailable` (mirroring claimSlot's own
  // `contended`) rather than a thrown error the adapter would map to 500.
  private async guardContention(
    fn: () => Promise<IntakeOutcome>,
  ): Promise<IntakeOutcome> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof OwnerResolutionContentionError) {
        return { kind: "unavailable", reason: "owner_resolution_contention" };
      }
      throw err;
    }
  }

  private annotate(manifest: Manifest): Manifest {
    return applyStaleness(
      manifest,
      this.deps.pendingTtlSeconds,
      this.deps.services.now(),
    );
  }

  // A submit that lands on a settled owner: ready/pending owners return the
  // existing manifest; failed owners reprocess in place (same reading id).
  private async submitOwned(
    pointer: ByUrlPointer,
    manifest: Manifest,
    email: boolean,
  ): Promise<IntakeOutcome> {
    await this.deps.reader.writeByIdPointer(pointer.id, pointer);
    const effective = this.annotate(manifest);
    if (effective.status !== "failed") {
      return { kind: "existing", manifest: effective };
    }
    return this.reprocessManifest(pointer.key_prefix, effective, { email });
  }

  private async createForSubmit(
    url: string,
    email: boolean,
    replaceEtag: string | undefined,
  ): Promise<IntakeOutcome> {
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

    const pointer = { id: args.id, key_prefix: args.keyPrefix };
    const claimed = await this.claim.claimSlot(url, pointer, { replaceEtag });
    switch (claimed.kind) {
      case "owned":
        return this.submitOwned(claimed.pointer, claimed.manifest, email);
      case "initializing":
        return { kind: "initializing", id: claimed.pointer.id };
      case "contended":
        return { kind: "unavailable", reason: "claim_contention" };
      case "claimed":
        break;
    }

    return activateAttempt(this.deps.reader, queue, this.deps.services, {
      keyPrefix: args.keyPrefix,
      manifest: pendingManifest,
      writeByIdPointer: true,
      rollbackManifest: pendingManifest,
      rollbackAttempt: activeAttempt,
      queueMessage: { ...args, attemptId, attemptStartedAt, trigger: "submit", email },
      principal: this.deps.principal,
    });
  }

  // An import that lands on a settled owner: ready/pending owners return the
  // existing manifest; failed owners re-import the supplied markdown in place.
  private async importOwned(
    pointer: ByUrlPointer,
    manifest: Manifest,
    markdown: string,
    opts: { title?: string; email: boolean },
  ): Promise<IntakeOutcome> {
    const effective = this.annotate(manifest);
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
    const source: ProcessReadingSource = {
      kind: "markdown",
      markdown,
      // The drafted title already resolved the supplied-vs-prior fallback.
      ...(pendingManifest.title === undefined ? {} : { title: pendingManifest.title }),
    };
    const args: ProcessReadingArgs = {
      id: effective.id,
      url: effective.url,
      urlHash: effective.url_hash,
      createdAt: effective.created_at,
      keyPrefix: pointer.key_prefix,
      source,
      attemptId,
      attemptStartedAt,
      trigger: "import",
      email: opts.email,
    };

    return activateAttempt(this.deps.reader, queue, this.deps.services, {
      keyPrefix: pointer.key_prefix,
      manifest: pendingManifest,
      writeByIdPointer: true,
      artifacts: {
        rawExt: "md",
        rawBytes: markdownBytes,
        rawContentType: "text/markdown; charset=utf-8",
        extractedMarkdown: markdown,
      },
      // Rollback lands on the freshly-built pending manifest (→ failed,
      // retryable), never the prior failed manifest's error.
      rollbackManifest: pendingManifest,
      rollbackAttempt: activeAttempt,
      queueMessage: args,
      principal: this.deps.principal,
    });
  }

  private async createForImport(
    url: string,
    markdown: string,
    opts: { title?: string; email: boolean },
    replaceEtag: string | undefined,
  ): Promise<IntakeOutcome> {
    const source: ProcessReadingSource = {
      kind: "markdown",
      markdown,
      ...(opts.title === undefined ? {} : { title: opts.title }),
    };
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

    const pointer = { id: args.id, key_prefix: args.keyPrefix };
    const claimed = await this.claim.claimSlot(url, pointer, { replaceEtag });
    switch (claimed.kind) {
      case "owned":
        return this.importOwned(claimed.pointer, claimed.manifest, markdown, opts);
      case "initializing":
        return { kind: "initializing", id: claimed.pointer.id };
      case "contended":
        return { kind: "unavailable", reason: "claim_contention" };
      case "claimed":
        break;
    }

    return activateAttempt(this.deps.reader, queue, this.deps.services, {
      keyPrefix: args.keyPrefix,
      manifest: pendingManifest,
      writeByIdPointer: true,
      artifacts: {
        rawExt: "md",
        rawBytes: markdownBytes,
        rawContentType: "text/markdown; charset=utf-8",
        extractedMarkdown: markdown,
      },
      rollbackManifest: pendingManifest,
      rollbackAttempt: activeAttempt,
      queueMessage: { ...args, attemptId, attemptStartedAt, trigger: "import", email: opts.email },
      principal: this.deps.principal,
    });
  }

  private async reprocessManifest(
    keyPrefix: string,
    manifest: Manifest,
    opts: { force?: boolean; email: boolean; source?: MarkdownSource },
  ): Promise<IntakeOutcome> {
    const effective = this.annotate(manifest);
    if (effective.active_attempt?.status === "running" && !opts.force) {
      return { kind: "conflict", reason: "active_attempt" };
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
    // extracted.md (and the missing_markdown conflict below can only fire for a
    // no-source reprocess of a markdown reading).
    let source: ProcessReadingSource | undefined = opts.source;
    if (source === undefined && effective.source_type === "markdown") {
      const extracted = await this.deps.reader.readExtracted(keyPrefix);
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
      keyPrefix,
      source,
      attemptId,
      attemptStartedAt,
      trigger: "reprocess",
      preserveReadyManifest: effective.status === "ready" ? effective : undefined,
      // Legacy manifests omit source_type and are treated as URL-backed by the
      // no-source path above, so snapshot that same effective default.
      sourceTypeOnFailure: effective.source_type ?? "url",
      email: opts.email,
    };
    return activateAttempt(this.deps.reader, queue, this.deps.services, {
      keyPrefix,
      manifest: nextManifest,
      writeByIdPointer: false,
      rollbackManifest: effective,
      rollbackAttempt: activeAttempt,
      queueMessage: args,
      principal: this.deps.principal,
    });
  }
}
