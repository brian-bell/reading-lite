import { buildSummarizeRequestBody } from "../../../src/modules/anthropic";
import { ManifestSchema, type Manifest } from "../../../src/schemas/manifest";
import type { AnthropicBatchClient, AnthropicBatchRequest, BatchInfo } from "./clients";
import type {
  ExtractedTarget,
  PersistedSidecar,
  Sidecar,
  SidecarTarget,
  SummarizeTarget,
} from "./types";

export interface SubmitDeps {
  model: string;
  batch: AnthropicBatchClient;
  // Writes a single object to R2 (raw bytes / extracted markdown) at submit time.
  putObject(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
  // Persists the sidecar. Called with a "pending" sidecar (no batchId) BEFORE
  // create, then again with the real batchId immediately after — so a crash in
  // the create window leaves a pending marker that aborts a re-run instead of
  // silently re-submitting (and re-billing).
  saveSidecar(sidecar: PersistedSidecar): Promise<void>;
  maxBatchBytes?: number;
}

export interface SubmitResult {
  info: BatchInfo;
  sidecar: Sidecar;
}

// Anthropic's batch limit is 256MB; refuse well under it and tell the operator to
// split with --limit rather than hard-failing the create call mid-backlog.
export const MAX_BATCH_BYTES = 200 * 1024 * 1024;

// Persist freshly-extracted content, build one summarize request per target
// (custom_id = reading id, params = the exact realtime body so the prompt cache
// is shared), create the batch, and return a sidecar that lets the write phase
// reconstruct manifests from results without re-extracting.
export async function submitBatch(
  targets: SummarizeTarget[],
  deps: SubmitDeps,
): Promise<SubmitResult> {
  const requests: AnthropicBatchRequest[] = [];
  const sidecarTargets: SidecarTarget[] = [];

  for (const st of targets) {
    const { target, fresh } = st.extracted;

    if (fresh && !st.extracted.contentAlreadyWritten) {
      await deps.putObject(
        `${target.keyPrefix}/raw.${extToken(fresh.content_type)}`,
        fresh.raw,
        fresh.content_type,
      );
      if (fresh.markdown) {
        await deps.putObject(
          `${target.keyPrefix}/extracted.md`,
          fresh.markdown,
          "text/markdown; charset=utf-8",
        );
      }
    }

    requests.push(requestForSummarizeTarget(st, deps.model));

    sidecarTargets.push(sidecarTargetFor(st));
  }

  assertBatchPayloadWithinLimit(requests, deps.maxBatchBytes);

  // Pending marker before create: if the process dies in the create window, the
  // sidecar (batchId "") makes a re-run abort for manual reconciliation rather
  // than create a second, double-billed batch.
  await deps.saveSidecar({
    version: 2,
    provider: "anthropic",
    phase: "creating",
    batchId: "",
    model: deps.model,
    processingStatus: "pending",
    resultsUrl: null,
    targets: sidecarTargets,
  });

  const info = await deps.batch.create(requests);
  const sidecar: Sidecar = {
    version: 2,
    provider: "anthropic",
    phase: "submitted",
    batchId: info.id,
    model: deps.model,
    processingStatus: info.processing_status,
    resultsUrl: info.results_url,
    targets: sidecarTargets,
  };
  await deps.saveSidecar(sidecar);
  return { info, sidecar };
}

export function assertExtractedBatchPayloadWithinLimit(
  targets: ExtractedTarget[],
  model: string,
  maxBytes = MAX_BATCH_BYTES,
): void {
  const requests = targets.map((extracted) =>
    requestForSummarizeTarget({ extracted, similar: [], queryEmbedTokens: 0 }, model),
  );
  assertBatchPayloadWithinLimit(requests, maxBytes);
}

export function assertSummarizeBatchPayloadWithinLimit(
  targets: SummarizeTarget[],
  model: string,
  maxBytes = MAX_BATCH_BYTES,
): void {
  const requests = targets.map((target) => requestForSummarizeTarget(target, model));
  assertBatchPayloadWithinLimit(requests, maxBytes);
}

function assertBatchPayloadWithinLimit(
  requests: AnthropicBatchRequest[],
  maxBytes = MAX_BATCH_BYTES,
): void {
  const totalBytes = requests.reduce((n, r) => n + JSON.stringify(r).length, 0);
  if (totalBytes > maxBytes) {
    throw new Error(
      `batch payload ~${Math.round(totalBytes / 1e6)}MB exceeds the ${Math.round(
        maxBytes / 1e6,
      )}MB safety cap; re-run with --limit to split into smaller batches`,
    );
  }
}

function requestForSummarizeTarget(st: SummarizeTarget, model: string): AnthropicBatchRequest {
  const { target, markdown, title } = st.extracted;
  return {
    custom_id: target.readingId,
    params: buildSummarizeRequestBody(
      {
        url: target.url,
        extractedText: markdown,
        ...(title === undefined ? {} : { title }),
        similarReadings: st.similar,
      },
      model,
    ),
  };
}

function sidecarTargetFor(st: SummarizeTarget): SidecarTarget {
  const { target, markdown, fresh } = st.extracted;
  const m = target.manifest;
  // Raw-object descriptors come from the fresh extract when we re-extracted,
  // else from the existing manifest (the raw bytes in R2 are unchanged).
  const contentType = fresh?.content_type ?? m.content_type;
  const contentBytes = fresh?.content_bytes ?? m.content_bytes;
  const contentSha256 = fresh?.content_sha256 ?? m.content_sha256;

  const out: SidecarTarget = {
    customId: target.readingId,
    keyPrefix: target.keyPrefix,
    id: target.readingId,
    url: target.url,
    urlHash: target.urlHash,
    createdAt: target.createdAt,
    sourceType: m.source_type ?? "url",
    contentType,
    // We hold summarizable markdown, so the resulting reading is captured —
    // mirror the realtime invariant (ready ⇒ captured) regardless of a stale
    // content_status on a previously-failed manifest.
    contentStatus: "captured",
    contentBytes,
    contentSha256,
    // extracted_bytes is the size of the markdown actually summarized, computed
    // from the text in hand (not trusted from a prior manifest) — matches the
    // realtime path.
    extractedBytes: new TextEncoder().encode(markdown).byteLength,
    // Carry the query-embedding cost so the write phase records it even on a
    // resumed run (the similar phase won't recompute it).
    queryEmbedTokens: st.queryEmbedTokens,
  };
  if (
    st.extracted.freshActivation?.kind === "create-new" ||
    st.extracted.freshActivation?.kind === "create-existing-failed"
  ) {
    out.releaseByUrlOnFailure = true;
  }
  const preserveReadyManifest = readySnapshotForBatchFailure(m, target.readingId);
  if (preserveReadyManifest) out.preserveReadyManifest = preserveReadyManifest;
  return out;
}

function readySnapshotForBatchFailure(m: Manifest, readingId: string): Manifest | undefined {
  if (m.status === "ready") return withoutNestedReadySnapshot(m);
  if (
    m.status !== "pending" ||
    m.active_attempt?.id !== `batch_${readingId}` ||
    m.active_attempt.trigger !== "reprocess"
  ) {
    return undefined;
  }
  const parsed = ManifestSchema.safeParse(m.preserve_ready_manifest);
  return parsed.success && parsed.data.status === "ready" ? withoutNestedReadySnapshot(parsed.data) : undefined;
}

function withoutNestedReadySnapshot(m: Manifest): Manifest {
  return ManifestSchema.parse({ ...m, preserve_ready_manifest: undefined });
}

// Mirror process-reading.ts:extToken so raw object keys match the realtime path.
function extToken(contentType: string): string {
  const major = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (major === "text/html" || major === "application/xhtml+xml") return "html";
  if (major === "text/markdown") return "md";
  if (major === "application/pdf") return "pdf";
  if (major === "application/json") return "json";
  if (major.startsWith("text/")) return "txt";
  return "bin";
}
