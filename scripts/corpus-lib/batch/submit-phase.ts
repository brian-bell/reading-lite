import { buildSummarizeRequestBody } from "../../../src/modules/anthropic";
import type { AnthropicBatchClient, AnthropicBatchRequest, BatchInfo } from "./clients";
import type { Sidecar, SidecarTarget, SummarizeTarget } from "./types";

export interface SubmitDeps {
  model: string;
  batch: AnthropicBatchClient;
  // Persists the sidecar. Called with a "pending" sidecar (no batchId) BEFORE
  // create, then again with the real batchId immediately after — so a crash in
  // the create window leaves a pending marker that aborts a re-run instead of
  // silently re-submitting (and re-billing).
  saveSidecar(sidecar: Sidecar): Promise<void>;
}

export interface SubmitResult {
  info: BatchInfo;
  sidecar: Sidecar;
}

// Anthropic's batch limit is 256MB; refuse well under it and tell the operator to
// split with --limit rather than hard-failing the create call mid-backlog.
const MAX_BATCH_BYTES = 200 * 1024 * 1024;

// One summarize request for a target (custom_id = reading id, params = the exact
// realtime body so the prompt cache is shared). Exported so the size cap can be
// validated BEFORE the eager claim mutates R2 (see assertBatchWithinSizeCap).
export function buildSummarizeRequest(st: SummarizeTarget, model: string): AnthropicBatchRequest {
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

// Throw (with the --limit guidance) if the request set would exceed the safety
// cap. Called from runBatchPipeline BEFORE claiming any by-url slots so an
// oversize batch aborts without mutating R2 (otherwise the eager pendings would
// strand a --limit rerun, which skips pending owners). `maxBytes` is injectable
// for tests; production uses the MAX_BATCH_BYTES default.
export function assertBatchWithinSizeCap(
  requests: AnthropicBatchRequest[],
  maxBytes: number = MAX_BATCH_BYTES,
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

// Build one summarize request per target (custom_id = reading id, params = the
// exact realtime body so the prompt cache is shared), create the batch, and
// return a sidecar that lets the write phase reconstruct manifests from results
// without re-extracting. Content artifacts were already persisted by the claim
// phase (artifacts → manifest), so this phase performs no R2 content writes.
export async function submitBatch(
  targets: SummarizeTarget[],
  deps: SubmitDeps,
): Promise<SubmitResult> {
  const requests: AnthropicBatchRequest[] = [];
  const sidecarTargets: SidecarTarget[] = [];

  // Fresh content artifacts (raw.*, extracted.md) are written by the claim phase
  // BEFORE its pending manifest (mirroring activateAttempt: artifacts → manifest),
  // so a captured-pending manifest is never published without its content. Here we
  // only build the batch requests + sidecar and create the batch.
  for (const st of targets) {
    requests.push(buildSummarizeRequest(st, deps.model));
    sidecarTargets.push(sidecarTargetFor(st));
  }

  // Defense-in-depth: runBatchPipeline already asserts the cap before claiming,
  // so for the kept set this never fires — but keep it so submitBatch stays safe
  // if called directly.
  assertBatchWithinSizeCap(requests);

  // Pending marker before create: if the process dies in the create window, the
  // sidecar (batchId "") makes a re-run abort for manual reconciliation rather
  // than create a second, double-billed batch.
  await deps.saveSidecar({
    batchId: "",
    model: deps.model,
    processingStatus: "pending",
    resultsUrl: null,
    targets: sidecarTargets,
  });

  const info = await deps.batch.create(requests);
  const sidecar: Sidecar = {
    batchId: info.id,
    model: deps.model,
    processingStatus: info.processing_status,
    resultsUrl: info.results_url,
    targets: sidecarTargets,
  };
  await deps.saveSidecar(sidecar);
  return { info, sidecar };
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
  // Roll-forward snapshot: only a currently-ready reading has good data to keep.
  if (m.status === "ready") out.preserveReadyManifest = m;
  return out;
}

// Mirror process-reading.ts:extToken so raw object keys match the realtime path.
// Exported so the claim phase names raw.* objects identically when it persists
// fresh content before the pending manifest.
export function extToken(contentType: string): string {
  const major = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (major === "text/html" || major === "application/xhtml+xml") return "html";
  if (major === "text/markdown") return "md";
  if (major === "application/pdf") return "pdf";
  if (major === "application/json") return "json";
  if (major.startsWith("text/")) return "txt";
  return "bin";
}
