import { promises as fs } from "node:fs";
import { dirname, basename, join } from "node:path";
import { z } from "zod";
import type { PersistedSidecar } from "./types";

// The sidecar lives next to the audit index: ./index.json -> ./index.batch.json.
// It records the in-flight batch so a crashed/interrupted poll resumes without
// re-submitting (and re-billing) the summarize step.
export function sidecarPath(indexPath: string): string {
  return indexPath.replace(/\.json$/i, "") + ".batch.json";
}

const SidecarTargetSchema = z
  .object({
    customId: z.string().min(1),
    keyPrefix: z.string().min(1),
    id: z.string().min(1),
    url: z.string().url(),
    urlHash: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string().datetime(),
    sourceType: z.enum(["url", "markdown"]),
    contentType: z.string().min(1),
    contentStatus: z.string().min(1),
    contentBytes: z.number().int().nonnegative(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    extractedBytes: z.number().int().nonnegative().optional(),
    queryEmbedTokens: z.number().int().nonnegative(),
    releaseByUrlOnFailure: z.literal(true).optional(),
    preserveReadyManifest: z.unknown().optional(),
  })
  .strip();

const ActivatingTargetSchema = z
  .object({
    id: z.string().min(1),
    customId: z.string().min(1),
    keyPrefix: z.string().min(1),
    url: z.string().url(),
    urlHash: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string().datetime(),
  })
  .strip();

const OpenAIReasoningEffortSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const V2SidecarSchema = z.union([
  z
    .object({
      version: z.literal(2),
      provider: z.literal("anthropic"),
      phase: z.literal("activating"),
      batchId: z.literal(""),
      model: z.string().min(1),
      processingStatus: z.literal("activating"),
      resultsUrl: z.null(),
      targets: z.array(ActivatingTargetSchema),
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      provider: z.literal("anthropic"),
      phase: z.literal("creating"),
      batchId: z.literal(""),
      model: z.string().min(1),
      processingStatus: z.literal("pending"),
      resultsUrl: z.null(),
      targets: z.array(SidecarTargetSchema),
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      provider: z.literal("anthropic"),
      phase: z.literal("submitted"),
      batchId: z.string().min(1),
      model: z.string().min(1),
      processingStatus: z.string().min(1),
      resultsUrl: z.string().url().nullable(),
      targets: z.array(SidecarTargetSchema),
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      provider: z.literal("openai"),
      phase: z.literal("activating"),
      runId: z.string().min(1),
      batchId: z.literal(""),
      inputFileId: z.null(),
      outputFileId: z.null(),
      errorFileId: z.null(),
      model: z.string().min(1),
      reasoningEffort: OpenAIReasoningEffortSchema,
      processingStatus: z.literal("activating"),
      targets: z.array(ActivatingTargetSchema),
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      provider: z.literal("openai"),
      phase: z.literal("uploading"),
      runId: z.string().min(1),
      batchId: z.literal(""),
      inputFileId: z.null(),
      outputFileId: z.null(),
      errorFileId: z.null(),
      model: z.string().min(1),
      reasoningEffort: OpenAIReasoningEffortSchema,
      processingStatus: z.literal("uploading"),
      targets: z.array(SidecarTargetSchema),
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      provider: z.literal("openai"),
      phase: z.literal("creating"),
      runId: z.string().min(1),
      batchId: z.literal(""),
      inputFileId: z.string().min(1),
      outputFileId: z.null(),
      errorFileId: z.null(),
      model: z.string().min(1),
      reasoningEffort: OpenAIReasoningEffortSchema,
      processingStatus: z.literal("creating"),
      targets: z.array(SidecarTargetSchema),
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      provider: z.literal("openai"),
      phase: z.literal("submitted"),
      runId: z.string().min(1),
      batchId: z.string().min(1),
      inputFileId: z.string().min(1),
      outputFileId: z.string().min(1).nullable(),
      errorFileId: z.string().min(1).nullable(),
      model: z.string().min(1),
      reasoningEffort: OpenAIReasoningEffortSchema,
      processingStatus: z.string().min(1),
      targets: z.array(SidecarTargetSchema),
    })
    .strict(),
]);

const LegacySidecarSchema = z.union([
  z
    .object({
      batchId: z.literal(""),
      model: z.string().min(1),
      processingStatus: z.literal("activating"),
      resultsUrl: z.null(),
      targets: z.array(ActivatingTargetSchema),
    })
    .strip(),
  z
    .object({
      batchId: z.string(),
      model: z.string().min(1),
      processingStatus: z.literal("pending"),
      resultsUrl: z.null(),
      targets: z.array(SidecarTargetSchema),
    })
    .strip(),
  z
    .object({
      batchId: z.string().min(1),
      model: z.string().min(1),
      processingStatus: z.string().min(1).refine((s) => s !== "pending" && s !== "activating"),
      resultsUrl: z.string().url().nullable(),
      targets: z.array(SidecarTargetSchema),
    })
    .strip(),
]);

export async function loadSidecar(path: string): Promise<PersistedSidecar | null> {
  try {
    const value = JSON.parse(await fs.readFile(path, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value
    ) {
      return V2SidecarSchema.parse(value) as PersistedSidecar;
    }

    const parsed = LegacySidecarSchema.parse(value);
    const phase = parsed.batchId
      ? "submitted"
      : parsed.processingStatus === "activating"
        ? "activating"
        : "creating";
    return {
      version: 2,
      provider: "anthropic",
      phase,
      ...parsed,
    } as PersistedSidecar;
  } catch (e) {
    if (typeof e === "object" && e && "code" in e && (e as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw new Error(
      `failed to load batch sidecar ${path}; manual reconciliation required before retrying: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

export async function saveSidecar(path: string, sidecar: PersistedSidecar): Promise<void> {
  const parsed = V2SidecarSchema.parse(sidecar);
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(parsed, null, 2) + "\n");
  await fs.rename(tmp, path);
}

export async function clearSidecar(path: string): Promise<void> {
  await fs.rm(path, { force: true });
  await fs.rm(inputJsonlPath(path), { force: true });
}

// Exact JSONL bytes persisted beside the sidecar so a resume from phase
// "uploading" with no remote file can re-upload the *same* payload. The bytes
// are written before the "uploading" checkpoint so a crash after either step
// leaves the sidecar in a state whose local bytes are recoverable.
export function inputJsonlPath(sidecarPath: string): string {
  return sidecarPath.replace(/\.json$/i, "") + ".input.jsonl";
}

export async function saveInputJsonl(
  sidecarPath: string,
  jsonl: string,
): Promise<void> {
  const path = inputJsonlPath(sidecarPath);
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, jsonl);
  await fs.rename(tmp, path);
}

export async function loadInputJsonl(
  sidecarPath: string,
): Promise<string | null> {
  try {
    return await fs.readFile(inputJsonlPath(sidecarPath), "utf8");
  } catch (e) {
    if (
      typeof e === "object" &&
      e &&
      "code" in e &&
      (e as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw e;
  }
}

export async function clearInputJsonl(sidecarPath: string): Promise<void> {
  await fs.rm(inputJsonlPath(sidecarPath), { force: true });
}
