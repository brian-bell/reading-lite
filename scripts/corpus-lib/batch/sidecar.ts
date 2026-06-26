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

const PersistedSidecarSchema = z.union([
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
    const parsed = JSON.parse(await fs.readFile(path, "utf8"));
    return PersistedSidecarSchema.parse(parsed) as PersistedSidecar;
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
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(sidecar, null, 2) + "\n");
  await fs.rename(tmp, path);
}

export async function clearSidecar(path: string): Promise<void> {
  await fs.rm(path, { force: true });
}
