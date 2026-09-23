import { sourceDateFromExtractOrPrior } from "../../../src/modules/extractor/source-date";
import { ManifestSchema, type Manifest } from "../../../src/schemas/manifest";
import type { BatchCorpus } from "./postgres";
import { rawExtFromContentType } from "../../../src/modules/stores/layout";
import type { R2Client } from "../../lib/cf-clients";
import { r2KeyLayout } from "../../../src/modules/stores/layout";
import type {
  ActivatingSidecar,
  ExtractedTarget,
  OpenAIActivatingSidecar,
  PersistedSidecar,
} from "./types";
import type { OpenAIReasoningEffort } from "../../../src/modules/summarizer/types";
import type { WriteReportRow } from "./write-phase";
import type { BatchSpendIdentity } from "./spend";

// Relative-key spelling only: keys built here are handed to a tenant-rooted
// client (withKeyRoot) or tenant-rooted R2Deps, which apply the operator's
// --tenant key root. This module never sees the root (s1k.4.3).
const layout = r2KeyLayout();

export interface ActivationDeps {
  r2: Pick<R2Client, "put" | "delete">;
  corpus: BatchCorpus;
  model?: string;
  // `spend` is the operation admitted before activation; the activating
  // sidecar is the first pending sidecar, so it carries it.
  identity?:
    | { provider: "anthropic"; model: string; spend?: BatchSpendIdentity }
    | {
        provider: "openai";
        model: string;
        reasoningEffort: OpenAIReasoningEffort;
        runId: string;
        spend?: BatchSpendIdentity;
      };
  now(): string;
  saveSidecar(sidecar: PersistedSidecar): Promise<void>;
  log?: (line: string) => void;
}

export interface ActivationResult {
  activated: ExtractedTarget[];
  skipped: WriteReportRow[];
}

export const activateFreshTargets = activateTargets;
export const activateRecoverTargets = activateTargets;

async function activateTargets(
  targets: ExtractedTarget[],
  deps: ActivationDeps,
): Promise<ActivationResult> {
  if (!targets.length) return { activated: [], skipped: [] };
  await deps.saveSidecar(activatingSidecar(targets, activationIdentity(deps)));
  const activated: ExtractedTarget[] = [];
  const skipped: WriteReportRow[] = [];
  for (const target of targets) {
    const t = target.target;
    const policy = target.freshActivation;
    const current = await deps.corpus.readManifest(t.keyPrefix);
    const owner = await deps.corpus.getByUrl(t.urlHash);
    const isNew = policy?.kind === "create-new";
    if (
      policy?.kind === "occupied-needs-repair" ||
      (owner && owner.id !== t.readingId) ||
      (isNew
        ? current !== null
        : !current ||
          current.id !== t.readingId ||
          current.url !== t.url ||
          current.url_hash !== t.urlHash) ||
      (policy && !isNew && current?.status !== "failed")
    ) {
      skipped.push({
        id: t.readingId,
        status: "skipped",
        reason: "reading ownership changed before activation",
      });
      continue;
    }
    let content = await deps.corpus.contentKeys(t.keyPrefix);
    if (target.fresh) {
      const fresh = target.fresh;
      content = {
        rawKey: layout.revisionRawKey(
          t.keyPrefix,
          t.attemptId,
          rawExtFromContentType(fresh.content_type),
        ),
        extractedKey: layout.revisionExtractedKey(t.keyPrefix, t.attemptId),
      };
      try {
        await deps.r2.put(content.rawKey, fresh.raw, {
          contentType: fresh.content_type,
        });
        await deps.r2.put(content.extractedKey!, target.markdown, {
          contentType: "text/markdown; charset=utf-8",
        });
      } catch (error) {
        await deps.corpus.discardContent(t, content, (key) =>
          deps.r2.delete(key),
        );
        throw error;
      }
    }
    if (!content)
      throw new Error(`batch content keys missing for ${t.readingId}`);
    const draft = policy
      ? buildPendingManifest(target, deps.now())
      : buildRecoverPendingManifest(target, current!, deps.now());
    // A reprocess leaves the published revision visible until success.
    const pending =
      current?.status === "ready"
        ? ManifestSchema.parse({
            ...current,
            active_attempt: draft.active_attempt,
            updated_at: draft.updated_at,
          })
        : draft;
    if (!(await deps.corpus.activate(pending, t.keyPrefix, content, current))) {
      // Only a confirmed refusal is safe to clean up. An ambiguous commit
      // keeps the activating sidecar and bytes for manual reconciliation.
      if (target.fresh)
        await deps.corpus.discardContent(t, content, (key) =>
          deps.r2.delete(key),
        );
      skipped.push({
        id: t.readingId,
        status: "skipped",
        reason: "reading changed during activation",
      });
      continue;
    }
    activated.push({
      ...target,
      target: { ...t, manifest: policy ? draft : pending },
      contentAlreadyWritten: true,
    });
  }
  return { activated, skipped };
}

type ActivationIdentity = NonNullable<ActivationDeps["identity"]>;

function activationIdentity(deps: ActivationDeps): ActivationIdentity {
  if (deps.identity) return deps.identity;
  if (deps.model) return { provider: "anthropic", model: deps.model };
  throw new Error("batch activation requires a provider identity");
}

function activatingSidecar(
  targets: ExtractedTarget[],
  identity: ActivationIdentity,
): ActivatingSidecar | OpenAIActivatingSidecar {
  const sidecarTargets = targets.map(({ target }) => ({
    id: target.readingId,
    customId: target.readingId,
    keyPrefix: target.keyPrefix,
    url: target.url,
    urlHash: target.urlHash,
    createdAt: target.createdAt,
  }));
  const spend = identity.spend === undefined ? {} : { spend: identity.spend };
  if (identity.provider === "openai") {
    return {
      version: 2,
      provider: "openai",
      phase: "activating",
      runId: identity.runId,
      batchId: "",
      inputFileId: null,
      outputFileId: null,
      errorFileId: null,
      model: identity.model,
      reasoningEffort: identity.reasoningEffort,
      processingStatus: "activating",
      targets: sidecarTargets,
      ...spend,
    };
  }
  return {
    version: 2,
    provider: "anthropic",
    phase: "activating",
    batchId: "",
    model: identity.model,
    processingStatus: "activating",
    resultsUrl: null,
    targets: sidecarTargets,
    ...spend,
  };
}

function buildPendingManifest(target: ExtractedTarget, now: string): Manifest {
  const markdownBytes = new TextEncoder().encode(target.markdown).byteLength;
  return ManifestSchema.parse({
    ...target.target.manifest,
    id: target.target.readingId,
    url: target.target.url,
    url_hash: target.target.urlHash,
    source_type: "markdown",
    status: "pending",
    active_attempt: {
      id: target.target.attemptId,
      trigger: target.target.trigger,
      status: "running",
      stage: "summarize",
      started_at: target.target.attemptStartedAt,
    },
    error: undefined,
    extracted_bytes: markdownBytes,
    updated_at: now,
  });
}

// Build the recover pending manifest from the LIVE manifest `m` (not the
// possibly-zeroed in-memory snapshot). A markFailed manifest zeros
// content_bytes/sha and sets content_status "failed", so descriptors are pulled
// from the fresh re-extract when present, else from `m`, and content_status is
// forced "captured" (we hold summarizable markdown — mirror submit-phase's
// sidecarTargetFor). Built fresh rather than spread from `m` so stale summary and
// error fields never leak into the pending; the terminal write rebuilds the full
// ready manifest, and on failure preserveReadyManifest rolls a ready reading
// forward. created_at is preserved from `m`. source_date follows the same
// fresh-wins / prior-fills-gap rule as sidecarTargetFor and is persisted here
// so an activating-window crash + extracted.md reuse (no `fresh` object) still
// feeds the new date to the sidecar.
function buildRecoverPendingManifest(
  target: ExtractedTarget,
  m: Manifest,
  now: string,
): Manifest {
  const fresh = target.fresh;
  const markdownBytes = new TextEncoder().encode(target.markdown).byteLength;
  const sourceDate = sourceDateFromExtractOrPrior(
    fresh?.source_date,
    m.source_date,
  );
  return ManifestSchema.parse({
    id: target.target.readingId,
    url: target.target.url,
    url_hash: target.target.urlHash,
    source_type: m.source_type ?? "url",
    status: "pending",
    active_attempt: {
      id: target.target.attemptId,
      trigger: target.target.trigger,
      status: "running",
      stage: "summarize",
      started_at: target.target.attemptStartedAt,
    },
    content_type: fresh?.content_type ?? m.content_type,
    content_status: "captured",
    content_bytes: fresh?.content_bytes ?? m.content_bytes,
    content_sha256: fresh?.content_sha256 ?? m.content_sha256,
    extracted_bytes: markdownBytes,
    ...preservedReadySnapshotField(m),
    ...(sourceDate === undefined ? {} : { source_date: sourceDate }),
    created_at: m.created_at,
    updated_at: now,
  });
}

function preservedReadySnapshotField(m: Manifest): Partial<Manifest> {
  const snapshot = readySnapshotForActivation(m);
  return snapshot ? { preserve_ready_manifest: snapshot } : {};
}

function readySnapshotForActivation(m: Manifest): Manifest | undefined {
  if (m.status === "ready") return withoutNestedReadySnapshot(m);
  if (m.status !== "pending" || m.active_attempt?.trigger !== "reprocess") {
    return undefined;
  }
  const preserved = parsePreservedReadySnapshot(m.preserve_ready_manifest);
  return preserved ? withoutNestedReadySnapshot(preserved) : undefined;
}

function parsePreservedReadySnapshot(value: unknown): Manifest | undefined {
  const parsed = ManifestSchema.safeParse(value);
  return parsed.success && parsed.data.status === "ready"
    ? parsed.data
    : undefined;
}

function withoutNestedReadySnapshot(m: Manifest): Manifest {
  return ManifestSchema.parse({ ...m, preserve_ready_manifest: undefined });
}
