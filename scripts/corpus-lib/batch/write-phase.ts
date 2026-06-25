import {
  ManifestSchema,
  type Manifest,
  type ManifestError,
} from "../../../src/schemas/manifest";
import { manifestToIndexItem } from "../../../src/modules/stores/reading-store";
import { parseEmitReadingResult } from "../../../src/modules/anthropic";
import type { ListIndexItem } from "../../../src/schemas/api";
import type { R2Client, VectorizeClient } from "../../lib/cf-clients";
import type { BatchResult, EmbedResult } from "./clients";
import { mergeListIndex } from "./list-index-merge";
import type { Sidecar, SidecarTarget } from "./types";

export interface WriteDeps {
  r2: R2Client;
  vectorize: VectorizeClient;
  embedMany(inputs: string[]): Promise<EmbedResult>;
  now(): string;
  log?: (line: string) => void;
}

export interface WriteReportRow {
  id: string;
  status: "ready" | "failed" | "skipped";
  reason?: string;
}

// Apply batch results to the corpus, honoring the terminal-write contract:
//   success -> ready manifest + by-url + by-id pointers + vector + index item
//   failure -> failed (retryable) manifest (or roll forward to the preserved
//              ready snapshot) + index item.
// The by-url slot was already eagerly claimed at submit time (claim-phase, the
// offline mirror of the online activateAttempt), so the success path here just
// re-writes the same {id,key_prefix} pointer (idempotent) and the failure path
// LEAVES that eager pointer in place — it now points at the failed manifest,
// exactly like the online activateAttempt failure path. The URL stays
// re-submittable: an online resolveOwner / a corpus re-run both see an owned
// `failed` reading and reprocess it in place.
// index/list.json is merged once at the end (read-modify-write). The script is
// effectively the sole writer for the URLs it claimed.
export async function writeResults(
  sidecar: Sidecar,
  results: BatchResult[],
  deps: WriteDeps,
): Promise<WriteReportRow[]> {
  const byId = new Map(sidecar.targets.map((t) => [t.customId, t]));
  const report: WriteReportRow[] = [];
  const touchedItems: ListIndexItem[] = [];

  // 1. Resolve every successful result into a ready manifest. Embed all TL;DRs
  //    in one call, then upsert all vectors together.
  const successes: Array<{ target: SidecarTarget; manifest: Manifest }> = [];
  const failures: Array<{ target: SidecarTarget; error: ManifestError }> = [];

  const resolvedSuccess: Array<{ target: SidecarTarget; reading: ReturnType<typeof parseEmitReadingResult> }> = [];
  for (const res of results) {
    const target = byId.get(res.custom_id);
    if (!target) {
      report.push({ id: res.custom_id, status: "skipped", reason: "no sidecar target for custom_id" });
      continue;
    }
    // Don't overwrite a reading the online path now owns (see externalOwnershipSkip):
    // it may have recovered the reading to ready, or be mid-reprocess with a live
    // active attempt, while the batch process was down.
    const skip = await externalOwnershipSkip(deps, target, touchedItems);
    if (skip) {
      report.push(skip);
      continue;
    }
    if (res.result.type === "succeeded") {
      try {
        const reading = parseEmitReadingResult(res.result.message.content, res.result.message.usage);
        resolvedSuccess.push({ target, reading });
      } catch (e) {
        failures.push({ target, error: errorBlock("BadToolInputError", e instanceof Error ? e.message : String(e), deps.now()) });
      }
    } else {
      failures.push({ target, error: errorBlock(...failureReason(res), deps.now()) });
    }
  }

  // Any sidecar target with no corresponding result (truncated/partial results
  // download, a dropped JSONL line) must not vanish — mark it retryable failed so
  // the strand stays visible and re-submittable.
  const seen = new Set(results.map((r) => r.custom_id));
  for (const target of sidecar.targets) {
    if (!seen.has(target.customId)) {
      // Same external-ownership guard: never downgrade a now-ready / online-owned
      // reading to a BatchResultMissing failure.
      const skip = await externalOwnershipSkip(deps, target, touchedItems);
      if (skip) {
        report.push(skip);
        continue;
      }
      failures.push({
        target,
        error: errorBlock("BatchResultMissing", "no batch result returned for this reading", deps.now()),
      });
    }
  }

  // Embed TL;DRs for the persistent vectors (one coalesced call).
  const tldrs = resolvedSuccess.map((s) => s.reading.reading.tldr);
  const { embeddings, tokensByInput: tldrTokens } =
    tldrs.length > 0 ? await deps.embedMany(tldrs) : { embeddings: [], tokensByInput: [] };
  const vectors = [];
  for (let i = 0; i < resolvedSuccess.length; i++) {
    const { target, reading } = resolvedSuccess[i]!;
    const embedding = embeddings[i]!;
    // Mirror process-reading.ts: openai_embedding_tokens = query + tldr embed.
    const embeddingTokens = target.queryEmbedTokens + (tldrTokens[i] ?? 0);
    const manifest = buildReadyManifest(target, reading.reading, reading.usage, embeddingTokens, deps.now());
    successes.push({ target, manifest });
    vectors.push({
      id: target.id,
      values: embedding,
      metadata: vectorMetadata(manifest),
    });
  }
  if (vectors.length > 0) await deps.vectorize.upsert(vectors);

  // 2. Write the success manifests + pointers.
  for (const { target, manifest } of successes) {
    await deps.r2.put(`${target.keyPrefix}/manifest.json`, JSON.stringify(manifest), { contentType: "application/json" });
    const pointer = JSON.stringify({ id: target.id, key_prefix: target.keyPrefix });
    await deps.r2.put(`index/by-url/${target.urlHash}`, pointer, { contentType: "application/json" });
    await deps.r2.put(`index/by-id/${target.id}`, pointer, { contentType: "application/json" });
    touchedItems.push(manifestToIndexItem(manifest, target.keyPrefix));
    report.push({ id: target.id, status: "ready" });
  }

  // 3. Write the failure manifests. We do NOT touch by-url here: the eager claim
  //    (claim-phase) already wrote it at submit, and we leave it pointing at this
  //    now-failed manifest (mirroring the online activateAttempt failure path —
  //    an owned `failed` reading is reprocessed in place, so the URL stays
  //    re-submittable). We DO (re)write the by-id pointer: a freshly-minted
  //    ingest needs it so its detail/diagnostics/reprocess routes (which resolve
  //    through by-id) don't 404; the write is idempotent (same id → key_prefix).
  for (const { target, error } of failures) {
    const manifest = target.preserveReadyManifest
      ? rolledForward(target.preserveReadyManifest, deps.now())
      : buildFailedManifest(target, error, deps.now());
    await deps.r2.put(`${target.keyPrefix}/manifest.json`, JSON.stringify(manifest), { contentType: "application/json" });
    await deps.r2.put(
      `index/by-id/${target.id}`,
      JSON.stringify({ id: target.id, key_prefix: target.keyPrefix }),
      { contentType: "application/json" },
    );
    touchedItems.push(manifestToIndexItem(manifest, target.keyPrefix));
    report.push({ id: target.id, status: "failed", reason: error.message });
  }

  // 4. Merge all touched items into index/list.json in a single write.
  await mergeListIndex({ r2: deps.r2, ...(deps.log ? { log: deps.log } : {}) }, touchedItems);

  return report;
}

// Decide whether the batch must NOT write this reading's terminal manifest because
// the online path now owns it (the batch process may have died and its eager
// pending aged out). Returns a "skipped" report row to honor, or null to proceed.
// The batch sets NO active_attempt on its eager pending, so any of these on the
// CURRENT manifest means an external (online) writer touched it:
//   - status `ready`        — online recovered it (or an idempotent replay). Keep
//                             the manifest, but re-publish its LIST ROW: a resume
//                             after a partial terminal write (ready manifest
//                             written, index/list.json merge not yet) would else
//                             strand the eager pending row. Pointers carry the
//                             status-independent {id,key_prefix} already.
//   - a live `active_attempt` — an online reprocess is in flight. Leave the reading
//                             entirely to that worker; overwriting it would make
//                             its terminal ownership gate drop a valid result.
// A missing/unparseable/plain-pending manifest (the batch's own claim) returns
// null, so the batch's terminal write lands.
async function externalOwnershipSkip(
  deps: WriteDeps,
  target: SidecarTarget,
  touchedItems: ListIndexItem[],
): Promise<WriteReportRow | null> {
  const raw = await deps.r2.get(`${target.keyPrefix}/manifest.json`);
  if (!raw) return null;
  let current: Manifest;
  try {
    const parsed = ManifestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    current = parsed.data;
  } catch {
    return null;
  }
  if (current.status === "ready") {
    touchedItems.push(manifestToIndexItem(current, target.keyPrefix));
    return { id: target.id, status: "skipped", reason: "already ready (recovered externally); list row repaired, manifest preserved" };
  }
  if (current.active_attempt !== undefined) {
    return { id: target.id, status: "skipped", reason: "online reprocess in flight (foreign active attempt); not overwritten" };
  }
  return null;
}

function buildReadyManifest(
  target: SidecarTarget,
  reading: ReturnType<typeof parseEmitReadingResult>["reading"],
  usage: ReturnType<typeof parseEmitReadingResult>["usage"],
  embeddingTokens: number,
  now: string,
): Manifest {
  const m: Manifest = {
    id: target.id,
    url: target.url,
    url_hash: target.urlHash,
    source_type: target.sourceType,
    status: "ready",
    title: reading.title,
    tldr: reading.tldr,
    tags: reading.tags,
    keywords: reading.keywords,
    people: reading.people,
    orgs: reading.orgs,
    novelty_verdict: reading.novelty_verdict,
    connections: reading.connections,
    summary_markdown: reading.summary_markdown,
    content_type: target.contentType,
    content_status: target.contentStatus as Manifest["content_status"],
    content_bytes: target.contentBytes,
    content_sha256: target.contentSha256,
    ...(target.extractedBytes === undefined ? {} : { extracted_bytes: target.extractedBytes }),
    fetched_at: now,
    created_at: target.createdAt,
    updated_at: now,
    usage: {
      anthropic_input_tokens: usage.input_tokens ?? 0,
      anthropic_output_tokens: usage.output_tokens ?? 0,
      // Query (similar-phase) + tldr (here) embedding tokens, attributed
      // per-reading from the coalesced OpenAI calls. Mirrors process-reading.ts.
      openai_embedding_tokens: embeddingTokens,
    },
  };
  return ManifestSchema.parse(m);
}

function buildFailedManifest(target: SidecarTarget, error: ManifestError, now: string): Manifest {
  const m: Manifest = {
    id: target.id,
    url: target.url,
    url_hash: target.urlHash,
    source_type: target.sourceType,
    status: "failed",
    error,
    content_type: target.contentType,
    content_status: target.contentStatus as Manifest["content_status"],
    content_bytes: target.contentBytes,
    content_sha256: target.contentSha256,
    ...(target.extractedBytes === undefined ? {} : { extracted_bytes: target.extractedBytes }),
    created_at: target.createdAt,
    updated_at: now,
  };
  return ManifestSchema.parse(m);
}

function rolledForward(preserved: Manifest, now: string): Manifest {
  // Keep the previously-ready data; clear any active attempt and restamp.
  return ManifestSchema.parse({ ...preserved, active_attempt: undefined, updated_at: now });
}

function failureReason(res: BatchResult): [string, string] {
  switch (res.result.type) {
    case "errored":
      return ["BatchRequestError", batchErrorMessage(res.result.error)];
    case "expired":
      return ["BatchRequestExpired", "batch request expired before completing"];
    case "canceled":
      return ["BatchRequestCanceled", "batch request was canceled"];
    default:
      return ["BatchRequestError", "unknown batch result"];
  }
}

function batchErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; error?: { message?: unknown } };
    if (typeof e.message === "string") return e.message;
    if (e.error && typeof e.error.message === "string") return e.error.message;
  }
  return "batch request errored";
}

function errorBlock(code: string, message: string, failedAt: string): ManifestError {
  // Bulk failures are all re-submittable: re-running the batch later is the fix.
  return { code, message, stage: "summarize", failed_at: failedAt, retryable: true };
}

function vectorMetadata(m: Manifest): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {
    url: m.url,
    created_at: m.created_at,
  };
  if (m.title) out.title = m.title;
  if (m.tags) out.tags = m.tags;
  return out;
}
