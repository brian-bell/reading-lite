import {
  type Manifest,
  type ManifestError,
  type SummarizationUsage,
} from "../../../src/schemas/manifest";
import type { ReadingSummary } from "../../../src/schemas/reading-summary";
import { manifestToIndexItem } from "../../../src/modules/stores/reading-store";
import {
  failedManifest,
  readyManifest,
  rollForward,
  type ContentFacts,
} from "../../../src/modules/manifest-drafting";
import { parseEmitReadingResult } from "../../../src/modules/anthropic";
import { parseSummarizeResponse } from "../../../src/modules/openai-summarizer";
import type { ListIndexItem } from "../../../src/schemas/api";
import type { R2Client, VectorizeClient } from "../../lib/cf-clients";
import type { BatchResult, EmbedResult } from "./clients";
import type { OpenAISubmittedSidecar, Sidecar, SidecarTarget } from "./types";
import { mergeListIndex } from "./list-index-write";
import { serializeReadingPointer, type ReadingPointer } from "./pointers";
import { r2KeyLayout } from "../../../src/modules/stores/layout";

// Relative-key spelling only: keys built here are handed to a tenant-rooted
// client (withKeyRoot) or tenant-rooted R2Deps, which apply the operator's
// --tenant key root. This module never sees the root (s1k.4.3).
const layout = r2KeyLayout();

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

type NormalizedBatchResult =
  | {
      customId: string;
      result: {
        type: "succeeded";
        reading: ReadingSummary;
        usage: SummarizationUsage;
      };
    }
  | {
      customId: string;
      result: { type: "failed"; code: string; message: string };
    };

// Apply batch results to the corpus, honoring the terminal-write contract:
//   success -> ready manifest + by-url + by-id pointers + vector + index item
//   failure -> failed (retryable) manifest (or roll forward to the preserved
//              ready snapshot) + by-id pointer + index item. Terminal failed
//              manifests release their own eager by-url claim when it still
//              points at this target.
// index/list.json is merged once at the end (read-modify-write). The script is
// effectively the sole writer during a backfill.
export async function writeResults(
  sidecar: Sidecar,
  results: BatchResult[],
  deps: WriteDeps,
): Promise<WriteReportRow[]> {
  const normalized: NormalizedBatchResult[] = results.map((res) => {
    if (res.result.type !== "succeeded") {
      const [code, message] = failureReason(res);
      return { customId: res.custom_id, result: { type: "failed", code, message } };
    }
    try {
      const parsed = parseEmitReadingResult(
        res.result.message.content,
        res.result.message.usage,
      );
      return {
        customId: res.custom_id,
        result: {
          type: "succeeded",
          reading: parsed.reading,
          usage: {
            provider: "anthropic",
            model: sidecar.model,
            input_tokens: parsed.usage.input_tokens ?? 0,
            output_tokens: parsed.usage.output_tokens ?? 0,
            cache_creation_input_tokens:
              parsed.usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens:
              parsed.usage.cache_read_input_tokens ?? 0,
          },
        },
      };
    } catch (error) {
      return {
        customId: res.custom_id,
        result: {
          type: "failed",
          code: anthropicParseErrorCode(error),
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
  return writeNormalizedResults(sidecar.targets, normalized, deps);
}

export async function writeOpenAIResults(
  sidecar: OpenAISubmittedSidecar,
  files:
    | string
    | {
        outputJsonl?: string;
        errorJsonl?: string;
        batchStatus: string;
      },
  deps: WriteDeps,
): Promise<WriteReportRow[]> {
  const input =
    typeof files === "string"
      ? { outputJsonl: files, batchStatus: sidecar.processingStatus }
      : files;
  const byCustomId = new Map<string, NormalizedBatchResult>();

  for (const line of `${input.outputJsonl ?? ""}\n${input.errorJsonl ?? ""}`.split(
    "\n",
  )) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const row = value as {
      custom_id?: unknown;
      response?: { status_code?: unknown; body?: unknown } | null;
      error?: unknown;
    };
    if (typeof row.custom_id !== "string") continue;
    let outcome: NormalizedBatchResult;
    if (
      row.response &&
      typeof row.response.status_code === "number" &&
      row.response.status_code >= 200 &&
      row.response.status_code < 300
    ) {
      try {
        const parsed = parseSummarizeResponse(row.response.body);
        outcome = {
          customId: row.custom_id,
          result: {
            type: "succeeded",
            reading: parsed.reading,
            usage: {
              provider: "openai",
              model: sidecar.model,
              input_tokens: parsed.usage.input_tokens,
              output_tokens: parsed.usage.output_tokens,
              reasoning_tokens: parsed.usage.reasoning_tokens,
              cached_input_tokens: parsed.usage.cached_input_tokens,
              cache_write_tokens: parsed.usage.cache_write_tokens,
            },
          },
        };
      } catch (error) {
        outcome = {
          customId: row.custom_id,
          result: {
            type: "failed",
            code: openAIParseErrorCode(error),
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    } else {
      outcome = {
        customId: row.custom_id,
        result: {
          type: "failed",
          code:
            row.error !== null && row.error !== undefined
              ? "OpenAIBatchRequestError"
              : typeof row.response?.status_code === "number"
                ? "OpenAIBatchRequestError"
                : "OpenAIBatchResultMalformed",
          message:
            row.error === null || row.error === undefined
              ? malformedOpenAIBatchLineMessage(row.response)
              : batchErrorMessage(row.error),
        },
      };
    }
    mergeOpenAIOutcome(byCustomId, outcome);
  }

  for (const target of sidecar.targets) {
    if (byCustomId.has(target.customId)) continue;
    byCustomId.set(target.customId, {
      customId: target.customId,
      result:
        input.batchStatus === "completed"
          ? {
              type: "failed",
              code: "OpenAIBatchResultMissing",
              message:
                "OpenAI batch completed without a result for this reading",
            }
          : {
              type: "failed",
              code: `OpenAIBatch${capitalize(input.batchStatus)}`,
              message: `OpenAI batch ended with status ${input.batchStatus} before returning a result for this reading`,
            },
    });
  }
  return writeNormalizedResults(
    sidecar.targets,
    [...byCustomId.values()],
    deps,
  );
}

function mergeOpenAIOutcome(
  outcomes: Map<string, NormalizedBatchResult>,
  candidate: NormalizedBatchResult,
): void {
  const existing = outcomes.get(candidate.customId);
  if (!existing || openAIOutcomeRank(candidate) > openAIOutcomeRank(existing)) {
    outcomes.set(candidate.customId, candidate);
  }
}

function openAIOutcomeRank(outcome: NormalizedBatchResult): number {
  if (outcome.result.type === "succeeded") return 3;
  return outcome.result.code === "OpenAIBatchRequestError" ? 2 : 1;
}

function openAIParseErrorCode(error: unknown): string {
  if (error instanceof Error) {
    switch (error.name) {
      case "OpenAIRefusalError":
      case "OpenAISourceRejectedError":
      case "OpenAIIncompleteResponseError":
      case "OpenAIOutputError":
      case "OpenAIResponseError":
        return error.name;
    }
  }
  return "OpenAIBatchStructuredOutputError";
}

function anthropicParseErrorCode(error: unknown): string {
  if (error instanceof Error) {
    switch (error.name) {
      case "SourceRejectedError":
      case "NoToolUseError":
      case "BadToolInputError":
        return error.name;
    }
  }
  return "BadToolInputError";
}

function malformedOpenAIBatchLineMessage(
  response: { status_code?: unknown; body?: unknown } | null | undefined,
): string {
  if (typeof response?.status_code === "number") {
    const bodyMessage = batchErrorMessage(response.body);
    return `OpenAI batch request returned HTTP ${response.status_code}: ${bodyMessage}`;
  }
  return "OpenAI batch result line had neither a valid response nor an error";
}

function capitalize(value: string): string {
  return value.length === 0
    ? "Unknown"
    : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

async function writeNormalizedResults(
  targets: SidecarTarget[],
  results: NormalizedBatchResult[],
  deps: WriteDeps,
): Promise<WriteReportRow[]> {
  const byId = new Map(targets.map((t) => [t.customId, t]));
  const report: WriteReportRow[] = [];
  const touchedItems: ListIndexItem[] = [];

  // 1. Resolve every successful result into a ready manifest. Embed all TL;DRs
  //    in one call, then upsert all vectors together.
  const successes: Array<{ target: SidecarTarget; manifest: Manifest }> = [];
  const failures: Array<{ target: SidecarTarget; error: ManifestError }> = [];

  const resolvedSuccess: Array<{
    target: SidecarTarget;
    reading: ReadingSummary;
    usage: SummarizationUsage;
  }> = [];
  for (const res of results) {
    const target = byId.get(res.customId);
    if (!target) {
      report.push({ id: res.customId, status: "skipped", reason: "no sidecar target for custom_id" });
      continue;
    }
    if (res.result.type === "succeeded") {
      resolvedSuccess.push({
        target,
        reading: res.result.reading,
        usage: res.result.usage,
      });
    } else {
      failures.push({
        target,
        error: errorBlock(
          res.result.code,
          res.result.message,
          deps.now(),
        ),
      });
    }
  }

  // Any sidecar target with no corresponding result (truncated/partial results
  // download, a dropped JSONL line) must not vanish — mark it retryable failed so
  // the strand stays visible and re-submittable.
  const seen = new Set(results.map((r) => r.customId));
  for (const target of targets) {
    if (!seen.has(target.customId)) {
      failures.push({
        target,
        error: errorBlock("BatchResultMissing", "no batch result returned for this reading", deps.now()),
      });
    }
  }

  // Embed TL;DRs for the persistent vectors (one coalesced call).
  const tldrs = resolvedSuccess.map((s) => s.reading.tldr);
  const { embeddings, tokensByInput: tldrTokens } =
    tldrs.length > 0 ? await deps.embedMany(tldrs) : { embeddings: [], tokensByInput: [] };
  const vectors = [];
  for (let i = 0; i < resolvedSuccess.length; i++) {
    const { target, reading, usage } = resolvedSuccess[i]!;
    const embedding = embeddings[i]!;
    // Mirror process-reading.ts: openai_embedding_tokens = query + tldr embed.
    const embeddingTokens = target.queryEmbedTokens + (tldrTokens[i] ?? 0);
    // SidecarTarget satisfies ReadingIdentity structurally. attempt: null is
    // the explicit statement that the sidecar carries no attempt identity
    // (reading-lite-1cm mints one at prepare time).
    const manifest = readyManifest(
      {
        identity: target,
        sourceType: target.sourceType,
        summary: reading,
        ...(target.similarity === undefined ? {} : { similarity: target.similarity }),
        content: contentFactsOf(target),
        usage: { summarization: usage, openai_embedding_tokens: embeddingTokens },
        attempt: null,
      },
      deps.now(),
    );
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
    await deps.r2.put(layout.manifestKey(target.keyPrefix), JSON.stringify(manifest), { contentType: "application/json" });
    const pointer = serializeReadingPointer(target.id, target.keyPrefix);
    await deps.r2.put(layout.byUrlKey(target.urlHash), pointer, { contentType: "application/json" });
    await deps.r2.put(layout.byIdKey(target.id), pointer, { contentType: "application/json" });
    touchedItems.push(manifestToIndexItem(manifest, target.keyPrefix));
    report.push({ id: target.id, status: "ready" });
  }

  // 3. Write the failure manifests. Do not create a by-url pointer here. DO
  //    write the by-id pointer:
  //    a freshly-minted ingest
  //    has no pre-existing pointer (unlike the recover path, where the reading is
  //    already in the corpus), so without it the failed reading would be a
  //    dangling list row — its detail/diagnostics/reprocess routes resolve
  //    through by-id and would 404, and a resubmit could mint a duplicate. The
  //    write is idempotent for the recover path (same id → same key_prefix).
  for (const { target, error } of failures) {
    const manifest = target.preserveReadyManifest
      ? rollForward(target.preserveReadyManifest, null, deps.now())
      : failedManifest(
          target,
          { sourceType: target.sourceType, error, attempt: null, content: contentFactsOf(target) },
          deps.now(),
        );
    await deps.r2.put(layout.manifestKey(target.keyPrefix), JSON.stringify(manifest), { contentType: "application/json" });
    await deps.r2.put(
      layout.byIdKey(target.id),
      serializeReadingPointer(target.id, target.keyPrefix),
      { contentType: "application/json" },
    );
    if (manifest.status === "failed" && target.releaseByUrlOnFailure === true) {
      await releaseByUrlIfOwned(target, deps);
    }
    touchedItems.push(manifestToIndexItem(manifest, target.keyPrefix));
    report.push({ id: target.id, status: "failed", reason: error.message });
  }

  // 4. Merge all touched items into index/list.json in a single write.
  if (touchedItems.length > 0) {
    await mergeListIndex(deps, touchedItems);
  }

  return report;
}

// The camelCase sidecar fields → the snake_case ContentFacts the shared
// drafter takes. The single place batch pays its casing toll.
function contentFactsOf(target: SidecarTarget): ContentFacts {
  return {
    content_type: target.contentType,
    content_status: target.contentStatus as ContentFacts["content_status"],
    content_bytes: target.contentBytes,
    content_sha256: target.contentSha256,
    ...(target.extractedBytes === undefined ? {} : { extracted_bytes: target.extractedBytes }),
  };
}

async function releaseByUrlIfOwned(target: SidecarTarget, deps: WriteDeps): Promise<void> {
  const key = layout.byUrlKey(target.urlHash);
  const raw = await deps.r2.get(key);
  if (raw === null) return;

  let pointer: ReadingPointer | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const candidate = parsed as { id?: unknown; key_prefix?: unknown };
      if (
        Object.keys(candidate).length === 2 &&
        typeof candidate.id === "string" &&
        typeof candidate.key_prefix === "string"
      ) {
        pointer = { id: candidate.id, key_prefix: candidate.key_prefix };
      }
    }
  } catch {
    // Leave damaged ownership pointers for explicit operator repair.
  }

  if (!pointer) {
    deps.log?.(`[write-phase] leaving damaged by-url pointer ${key}`);
    return;
  }
  if (pointer.id === target.id && pointer.key_prefix === target.keyPrefix) {
    await deps.r2.delete(key);
  }
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
  if (m.tldr) out.tldr = m.tldr;
  // Tags on a drafted ready manifest are already canonical (readyManifest
  // normalizes them).
  if (m.tags) out.tags = m.tags;
  return out;
}
