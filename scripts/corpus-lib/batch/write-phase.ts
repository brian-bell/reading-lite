import type { R2Client } from "../../lib/cf-clients";
import { r2KeyLayout, rawExtFromContentType } from "../../../src/modules/stores/layout";
import {
  type Manifest,
  type ManifestError,
  type ProcessingAttemptSummary,
  type SummarizationUsage,
} from "../../../src/schemas/manifest";
import type { ReadingSummary } from "../../../src/schemas/reading-summary";
import type { BatchCorpus } from "./postgres";
import {
  failedManifest,
  readyManifest,
  rollForward,
  type ContentFacts,
} from "../../../src/modules/manifest-drafting";
import { parseEmitReadingResult } from "../../../src/modules/anthropic";
import { parseSummarizeResponse } from "../../../src/modules/openai-summarizer";
import type { BatchResult, EmbedResult } from "./clients";
import type { OpenAISubmittedSidecar, Sidecar, SidecarTarget } from "./types";

export interface WriteDeps {
  corpus: BatchCorpus;
  r2: Pick<R2Client, "delete">;
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

// Normalize provider results, then publish each reading through the shared
// PostgreSQL writer. Content keys, revision, relationships and embedding commit
// together. A database error leaves the sidecar resumable; completed attempts
// are skipped before embedding on replay.
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


  // Draft successful results and coalesce their TL;DR embeddings.
  const successes: Array<{ target: SidecarTarget; manifest: Manifest; embedding: number[] }> = [];
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
    const disposition = await deps.corpus.disposition(target);
    if (disposition !== "active") {
      await discardResultContent(target, deps);
      report.push({ id: target.id, status: "skipped", reason: disposition === "complete" ? "already committed" : "attempt no longer owns reading" });
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
    if (seen.has(target.customId)) continue;
    const disposition = await deps.corpus.disposition(target);
    if (disposition !== "active") {
      await discardResultContent(target, deps);
      report.push({ id: target.id, status: "skipped", reason: disposition === "complete" ? "already committed" : "attempt no longer owns reading" });
    } else {
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
  for (let i = 0; i < resolvedSuccess.length; i++) {
    const { target, reading, usage } = resolvedSuccess[i]!;
    const embedding = embeddings[i]!;
    // Mirror process-reading.ts: openai_embedding_tokens = query + tldr embed.
    const embeddingTokens = target.queryEmbedTokens + (tldrTokens[i] ?? 0);
    const finishedAt = deps.now();
    const manifest = readyManifest(
      {
        identity: target,
        sourceType: target.sourceType,
        summary: reading,
        ...(target.similarity === undefined ? {} : { similarity: target.similarity }),
        ...(target.neighbourhoodIds === undefined ? {} : { neighbourhoodIds: target.neighbourhoodIds }),
        content: contentFactsOf(target),
        usage: { summarization: usage, openai_embedding_tokens: embeddingTokens },
        attempt: terminalAttempt(target, "succeeded", finishedAt),
        ...(target.sourceDate === undefined ? {} : { source_date: target.sourceDate }),
      },
      finishedAt,
    );
    successes.push({ target, manifest, embedding });
  }
  for (const { target, manifest, embedding } of successes) {
    const committed = await deps.corpus.publish(target, manifest, embedding);
    if (!committed) await discardResultContent(target, deps);
    report.push({ id: target.id, status: committed ? "ready" : "skipped" });
  }

  // The writer retains the current publication when a recovery fails.
  for (const { target, error } of failures) {
    const finishedAt = error.failed_at ?? deps.now();
    const attempt = terminalAttempt(target, "failed", finishedAt, error);
    const manifest = target.preserveReadyManifest
      ? rollForward(target.preserveReadyManifest, attempt, finishedAt)
      : failedManifest(
          target,
          {
            sourceType: target.sourceType,
            error,
            attempt,
            content: contentFactsOf(target),
            ...(target.sourceDate === undefined ? {} : { source_date: target.sourceDate }),
          },
          finishedAt,
        );
    const committed = await deps.corpus.fail(target, manifest);
    await discardResultContent(target, deps);
    report.push({ id: target.id, status: committed ? "failed" : "skipped", reason: error.message });
  }

  return report;
}

function terminalAttempt(
  target: SidecarTarget,
  status: "succeeded" | "failed",
  finishedAt: string,
  error?: ManifestError,
): ProcessingAttemptSummary | null {
  if (target.attemptId === undefined) return null;
  if (target.attemptStartedAt === undefined || target.trigger === undefined) {
    throw new Error(`sidecar target ${target.id} has an incomplete attempt identity`);
  }
  return {
    id: target.attemptId,
    trigger: target.trigger,
    status,
    ...(status === "succeeded"
      ? { stage: "write_indexes" as const }
      : error?.stage === undefined
        ? {}
        : { stage: error.stage }),
    started_at: target.attemptStartedAt,
    finished_at: finishedAt,
    ...(error === undefined ? {} : { error }),
  };
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
    ...(target.enrichmentDegradation === undefined
      ? {}
      : { enrichment_degradation: target.enrichmentDegradation }),
  };
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

// A failed published recovery or a superseded attempt no longer serves these
// captured bytes. The shared guard retains current content, including a failed
// first ingest's diagnostics. Retry cleanup on completed replay too: a delete
// failure keeps the sidecar even though the SQL terminal commit succeeded.
async function discardResultContent(target: SidecarTarget, deps: WriteDeps): Promise<void> {
  if (!target.attemptId) return;
  const layout = r2KeyLayout();
  await deps.corpus.discardContent(
    { readingId: target.id, keyPrefix: target.keyPrefix, attemptId: target.attemptId },
    {
      rawKey: layout.revisionRawKey(target.keyPrefix, target.attemptId, rawExtFromContentType(target.contentType)),
      extractedKey: layout.revisionExtractedKey(target.keyPrefix, target.attemptId),
    },
    key => deps.r2.delete(key),
  );
}
