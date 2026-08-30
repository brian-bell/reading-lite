import { ManifestSchema, type Manifest } from "../../../src/schemas/manifest";
import { manifestToIndexItem } from "../../../src/modules/stores/reading-store";
import type { ListIndexItem } from "../../../src/schemas/api";
import type { R2Client } from "../../lib/cf-clients";
import { mergeListIndex } from "./list-index-write";
import { serializeReadingPointer, type ReadingPointer } from "./pointers";
import { getByUrl } from "./r2-reads";
import { r2KeyLayout } from "../../../src/modules/stores/layout";
import type {
  ActivatingSidecar,
  ExtractedTarget,
  OpenAIActivatingSidecar,
  PersistedSidecar,
} from "./types";
import type { OpenAIReasoningEffort } from "../../../src/modules/summarizer/types";
import type { WriteReportRow } from "./write-phase";

// Relative-key spelling only: keys built here are handed to a tenant-rooted
// client (withKeyRoot) or tenant-rooted R2Deps, which apply the operator's
// --tenant key root. This module never sees the root (s1k.4.3).
const layout = r2KeyLayout();

export interface ActivationDeps {
  r2: Pick<R2Client, "get" | "put" | "putIfAbsent" | "delete">;
  model?: string;
  identity?:
    | { provider: "anthropic"; model: string }
    | {
        provider: "openai";
        model: string;
        reasoningEffort: OpenAIReasoningEffort;
        runId: string;
      };
  now(): string;
  saveSidecar(sidecar: PersistedSidecar): Promise<void>;
  log?: (line: string) => void;
}

export interface ActivationResult {
  activated: ExtractedTarget[];
  skipped: WriteReportRow[];
}

export async function activateFreshTargets(
  targets: ExtractedTarget[],
  deps: ActivationDeps,
): Promise<ActivationResult> {
  const freshTargets = targets.filter((t) => t.freshActivation);
  if (freshTargets.length === 0) return { activated: targets, skipped: [] };

  await deps.saveSidecar(activatingSidecar(freshTargets, activationIdentity(deps)));

  const activated: ExtractedTarget[] = [];
  const skipped: WriteReportRow[] = [];
  const touched = [];

  for (const target of targets) {
    const policy = target.freshActivation;
    if (!policy) {
      activated.push(target);
      continue;
    }

    if (policy.kind === "occupied-needs-repair") {
      skipped.push({ id: target.target.readingId, status: "skipped", reason: policy.reason });
      continue;
    }

    const pointer = serializeReadingPointer(target.target.readingId, target.target.keyPrefix);
    const pointerKey = layout.byUrlKey(target.target.urlHash);

    if (policy.kind === "create-new") {
      const claimed = await deps.r2.putIfAbsent(pointerKey, pointer, { contentType: "application/json" });
      if (!claimed) {
        skipped.push({
          id: target.target.readingId,
          status: "skipped",
          reason: "by-url slot already owned at batch submit",
        });
        continue;
      }
    } else if (policy.kind === "create-existing-failed") {
      const before = await readManifest(deps.r2, policy.expected.keyPrefix);
      if (!isExpectedFailed(before, policy.expected)) {
        skipped.push({
          id: policy.expected.id,
          status: "skipped",
          reason: "planned failed reading changed before by-url claim",
        });
        continue;
      }
      const claimed = await deps.r2.putIfAbsent(pointerKey, pointer, { contentType: "application/json" });
      if (!claimed) {
        skipped.push({
          id: policy.expected.id,
          status: "skipped",
          reason: "by-url slot already owned at batch submit",
        });
        continue;
      }
      const after = await readManifest(deps.r2, policy.expected.keyPrefix);
      if (!isExpectedFailed(after, policy.expected)) {
        throw new Error(`batch activation claimed ${policy.expected.id}, but its manifest changed before pending write`);
      }
    } else {
      const currentPointer = await readPointer(deps.r2, pointerKey);
      const currentManifest = await readManifest(deps.r2, policy.expected.keyPrefix);
      if (!pointerEquals(currentPointer, policy.expected.id, policy.expected.keyPrefix)) {
        skipped.push({ id: policy.expected.id, status: "skipped", reason: "by-url pointer changed before activation" });
        continue;
      }
      if (!isExpectedFailed(currentManifest, policy.expected)) {
        skipped.push({ id: policy.expected.id, status: "skipped", reason: "planned failed reading changed before activation" });
        continue;
      }
      const finalPointer = await readPointer(deps.r2, pointerKey);
      const finalManifest = await readManifest(deps.r2, policy.expected.keyPrefix);
      if (
        !pointerEquals(finalPointer, policy.expected.id, policy.expected.keyPrefix) ||
        !isExpectedFailed(finalManifest, policy.expected)
      ) {
        throw new Error(`batch activation lost the ${policy.expected.id} ownership revalidation race`);
      }
    }

    const item = await commitPendingActivation(target, buildPendingManifest(target, deps.now()), deps.r2);
    touched.push(item);
    activated.push({ ...target, contentAlreadyWritten: true });
  }

  if (touched.length > 0) await mergeListIndex({ r2: deps.r2, log: deps.log }, touched);

  return { activated, skipped };
}

// The recover-batch sibling of activateFreshTargets. For a recover target the
// by-url slot is usually *already held* (realtime-failed readings own by-url;
// batch-failed ones don't), so the eager "claim" is really a failed→pending flip.
// Recover carries no create-* policy: every target is treated uniformly, the
// claim is idempotent for an already-owned reading, and write-phase leaves the
// claim on failure (no releaseByUrlOnFailure) so a failed recover URL stays
// re-submittable by both recover (resolves via row.key_prefix) and the online
// reprocess path (ownedManifestMatches is status-agnostic).
export async function activateRecoverTargets(
  targets: ExtractedTarget[],
  deps: ActivationDeps,
): Promise<ActivationResult> {
  if (targets.length === 0) return { activated: [], skipped: [] };

  await deps.saveSidecar(activatingSidecar(targets, activationIdentity(deps)));

  const activated: ExtractedTarget[] = [];
  const skipped: WriteReportRow[] = [];
  const touched = [];

  for (const target of targets) {
    const { readingId: id, keyPrefix, url, urlHash } = target.target;
    const pointerKey = layout.byUrlKey(urlHash);
    const pointer = serializeReadingPointer(id, keyPrefix);

    const lookup = await getByUrl(deps.r2, urlHash);
    if (lookup === "damaged") {
      skipped.push({ id, status: "skipped", reason: "by-url pointer is damaged" });
      continue;
    }
    // Track whether *this run* created the by-url claim, so a later revalidation
    // skip can release exactly the pointer it wrote (and only that one).
    let createdClaim = false;
    if (lookup === null) {
      const claimed = await deps.r2.putIfAbsent(pointerKey, pointer, { contentType: "application/json" });
      if (claimed) {
        createdClaim = true;
      } else {
        const after = await getByUrl(deps.r2, urlHash);
        if (!(after && after !== "damaged" && after.id === id && after.key_prefix === keyPrefix)) {
          skipped.push({ id, status: "skipped", reason: "by-url claimed by another writer" });
          continue;
        }
        // Lost the race but the winner wrote our identical pointer — not ours to
        // release (another writer owns it), so leave createdClaim false.
      }
    } else if (lookup.id !== id || lookup.key_prefix !== keyPrefix) {
      // A live pointer to a *different* reading — never clobber another owner.
      skipped.push({ id, status: "skipped", reason: "by-url owned by a different reading" });
      continue;
    }
    // else: the pointer already equals ours — idempotent owns-slot branch, proceed
    // without a claim write (both writers serialize identically).

    // Revalidate the live manifest is still this reading, regardless of status:
    // a ready force-reprocess, a failed reading, or our own batch_<id> pending on
    // a re-run all pass. Re-flip safety of our own pending rests on --sole-writer.
    const m = await readManifest(deps.r2, keyPrefix);
    if (!(m && m.id === id && m.url === url && m.url_hash === urlHash)) {
      // Release a claim *this run* just created so a never-activated reading
      // doesn't strand a stale by-url pointer (when every target skips, the
      // sidecar is cleared and no later write phase repairs it).
      if (createdClaim) await releaseClaimIfOwned(deps.r2, urlHash, id, keyPrefix);
      skipped.push({ id, status: "skipped", reason: "reading changed before activation" });
      continue;
    }

    const pendingManifest = buildRecoverPendingManifest(target, m, deps.now());
    const item = await commitPendingActivation(target, pendingManifest, deps.r2);
    touched.push(item);
    activated.push({
      ...target,
      target: { ...target.target, manifest: pendingManifest },
      contentAlreadyWritten: true,
    });
  }

  if (touched.length > 0) await mergeListIndex({ r2: deps.r2, log: deps.log }, touched);

  return { activated, skipped };
}

// The per-target write tail both activation paths share once they decide to
// activate: persist fresh content (no-op when reused), write the pending
// manifest, write the by-id pointer, and return the list-index row to merge.
async function commitPendingActivation(
  target: ExtractedTarget,
  manifest: Manifest,
  r2: Pick<R2Client, "put">,
): Promise<ListIndexItem> {
  const { readingId: id, keyPrefix } = target.target;
  await writeFreshContent(target, r2);
  await r2.put(layout.manifestKey(keyPrefix), JSON.stringify(manifest), { contentType: "application/json" });
  await r2.put(layout.byIdKey(id), serializeReadingPointer(id, keyPrefix), { contentType: "application/json" });
  return manifestToIndexItem(manifest, keyPrefix);
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
// forward. created_at is preserved from `m`.
function buildRecoverPendingManifest(target: ExtractedTarget, m: Manifest, now: string): Manifest {
  const fresh = target.fresh;
  const markdownBytes = new TextEncoder().encode(target.markdown).byteLength;
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
  if (
    m.status !== "pending" ||
    m.active_attempt?.trigger !== "reprocess"
  ) {
    return undefined;
  }
  const preserved = parsePreservedReadySnapshot(m.preserve_ready_manifest);
  return preserved ? withoutNestedReadySnapshot(preserved) : undefined;
}

function parsePreservedReadySnapshot(value: unknown): Manifest | undefined {
  const parsed = ManifestSchema.safeParse(value);
  return parsed.success && parsed.data.status === "ready" ? parsed.data : undefined;
}

function withoutNestedReadySnapshot(m: Manifest): Manifest {
  return ManifestSchema.parse({ ...m, preserve_ready_manifest: undefined });
}

// Delete a by-url pointer only when it still exactly matches the claim this run
// wrote (mirrors write-phase.releaseByUrlIfOwned): a concurrent owner change must
// not be clobbered by our rollback.
async function releaseClaimIfOwned(
  r2: Pick<R2Client, "get" | "delete">,
  urlHash: string,
  id: string,
  keyPrefix: string,
): Promise<void> {
  const current = await getByUrl(r2, urlHash);
  if (current && current !== "damaged" && current.id === id && current.key_prefix === keyPrefix) {
    await r2.delete(layout.byUrlKey(urlHash));
  }
}

async function writeFreshContent(
  target: ExtractedTarget,
  r2: Pick<R2Client, "put">,
): Promise<void> {
  const fresh = target.fresh;
  if (!fresh) return;
  await r2.put(layout.rawKey(target.target.keyPrefix, extToken(fresh.content_type)), fresh.raw, {
    contentType: fresh.content_type,
  });
  if (fresh.markdown) {
    await r2.put(layout.extractedKey(target.target.keyPrefix), fresh.markdown, {
      contentType: "text/markdown; charset=utf-8",
    });
  }
}

async function readManifest(
  r2: Pick<R2Client, "get">,
  keyPrefix: string,
): Promise<Manifest | null> {
  const raw = await r2.get(layout.manifestKey(keyPrefix));
  return raw ? ManifestSchema.parse(JSON.parse(raw)) : null;
}

async function readPointer(r2: Pick<R2Client, "get">, key: string): Promise<ReadingPointer | null> {
  const raw = await r2.get(key);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<ReadingPointer>;
  if (typeof parsed.id !== "string" || typeof parsed.key_prefix !== "string") return null;
  return { id: parsed.id, key_prefix: parsed.key_prefix };
}

function isExpectedFailed(
  manifest: Manifest | null,
  expected: { id: string; keyPrefix: string; url: string; urlHash: string; createdAt: string },
): boolean {
  return (
    manifest?.status === "failed" &&
    manifest.id === expected.id &&
    manifest.url === expected.url &&
    manifest.url_hash === expected.urlHash &&
    manifest.created_at === expected.createdAt
  );
}

function pointerEquals(pointer: ReadingPointer | null, id: string, keyPrefix: string): boolean {
  return pointer?.id === id && pointer.key_prefix === keyPrefix;
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
