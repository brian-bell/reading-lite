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

const LIST_INDEX_KEY = "index/list.json";

// Apply batch results to the corpus, honoring the terminal-write contract:
//   success -> ready manifest + by-url + by-id pointers + vector + index item
//   failure -> failed (retryable) manifest (or roll forward to the preserved
//              ready snapshot) + index item, and NO by-url pointer (failed URLs
//              stay re-submittable).
// index/list.json is merged once at the end (read-modify-write), mirroring the
// migrate bulk path. The script is effectively the sole writer during a backfill.
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

  // 3. Write the failure manifests (no by-url pointer).
  for (const { target, error } of failures) {
    const manifest = target.preserveReadyManifest
      ? rolledForward(target.preserveReadyManifest, deps.now())
      : buildFailedManifest(target, error, deps.now());
    await deps.r2.put(`${target.keyPrefix}/manifest.json`, JSON.stringify(manifest), { contentType: "application/json" });
    touchedItems.push(manifestToIndexItem(manifest, target.keyPrefix));
    report.push({ id: target.id, status: "failed", reason: error.message });
  }

  // 4. Merge all touched items into index/list.json in a single write.
  if (touchedItems.length > 0) {
    await mergeListIndex(deps, touchedItems);
  }

  return report;
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

async function mergeListIndex(deps: WriteDeps, touched: ListIndexItem[]): Promise<void> {
  const raw = await deps.r2.get(LIST_INDEX_KEY);
  let items: ListIndexItem[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { items?: ListIndexItem[] };
      if (Array.isArray(parsed.items)) items = parsed.items;
    } catch {
      deps.log?.(`  ! index/list.json was unparseable; rebuilding from touched items only`);
    }
  }
  const touchedIds = new Set(touched.map((t) => t.id));
  const merged = [...items.filter((i) => !touchedIds.has(i.id)), ...touched];
  await deps.r2.put(LIST_INDEX_KEY, JSON.stringify({ version: 1, items: merged }), {
    contentType: "application/json",
  });
}
