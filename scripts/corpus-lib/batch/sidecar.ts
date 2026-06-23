import { promises as fs } from "node:fs";
import { z } from "zod";
import { ManifestSchema } from "../../../src/schemas/manifest";
import type { Sidecar } from "./types";

// The sidecar is a crash-recovery marker read from disk, so it crosses a trust
// seam: validate the full shape (per repo convention) before honoring it as a
// resumable batch. `targets` must be non-empty — a real in-flight batch always
// carries at least one target (submit is skipped when there are zero), so an
// empty/under-specified sidecar is corruption that must not be resumed-then-cleared.
const SidecarTargetSchema = z.object({
  customId: z.string(),
  keyPrefix: z.string(),
  id: z.string(),
  url: z.string(),
  urlHash: z.string(),
  createdAt: z.string(),
  sourceType: z.enum(["url", "markdown"]),
  contentType: z.string(),
  contentStatus: z.string(),
  contentBytes: z.number(),
  contentSha256: z.string(),
  extractedBytes: z.number().optional(),
  queryEmbedTokens: z.number(),
  preserveReadyManifest: ManifestSchema.optional(),
});

const SidecarSchema = z.object({
  batchId: z.string(),
  model: z.string(),
  processingStatus: z.string(),
  resultsUrl: z.string().nullable(),
  targets: z.array(SidecarTargetSchema).nonempty(),
});

// The sidecar lives next to the audit index: ./index.json -> ./index.batch.json.
// It records the in-flight batch so a crashed/interrupted poll resumes without
// re-submitting (and re-billing) the summarize step.
export function sidecarPath(indexPath: string): string {
  return indexPath.replace(/\.json$/i, "") + ".batch.json";
}

export async function loadSidecar(path: string): Promise<Sidecar | null> {
  // A genuinely-absent sidecar means "no in-flight batch" → proceed. But a read
  // error or a truncated/malformed file must NOT be mistaken for absent: a crash
  // mid-write (after Anthropic create was billed) can leave a corrupt sidecar, and
  // silently treating it as missing would resubmit a second, double-billed batch.
  // Fail closed so the operator reconciles manually.
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw malformedSidecarError(path);
  }
  // A syntactically-valid file that isn't a real Sidecar (e.g. `null`, a primitive,
  // an array, an object missing/empty targets, or targets missing identity fields)
  // must NOT be mistaken for absent or honored as resumable: `null` would slip past
  // callers' `if (existing)` guard and resubmit a second, double-billed batch, while
  // a malformed-but-truthy sidecar could be polled, mis-written, then cleared —
  // losing the only recovery marker for a billed batch. Validate the full shape and
  // fail closed otherwise.
  const result = SidecarSchema.safeParse(parsed);
  if (!result.success) throw malformedSidecarError(path);
  return result.data;
}

function malformedSidecarError(path: string): Error {
  return new Error(
    `batch sidecar at ${path} exists but is unreadable/malformed — a previous run may ` +
      `have crashed mid-write after creating (and being billed for) a batch. Check the ` +
      `Anthropic console, then delete the sidecar before retrying.`,
  );
}

export async function saveSidecar(path: string, sidecar: Sidecar): Promise<void> {
  await fs.writeFile(path, JSON.stringify(sidecar, null, 2) + "\n");
}

export async function clearSidecar(path: string): Promise<void> {
  await fs.rm(path, { force: true });
}
