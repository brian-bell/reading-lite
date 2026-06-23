import { promises as fs } from "node:fs";
import type { Sidecar } from "./types";

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
  // an array, or an object missing batchId/targets) must NOT be mistaken for absent:
  // `null` in particular would slip past callers' `if (existing)` guard and resubmit
  // a second, double-billed batch. Validate the shape and fail closed otherwise.
  if (!isSidecarShape(parsed)) throw malformedSidecarError(path);
  return parsed;
}

function isSidecarShape(value: unknown): value is Sidecar {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Sidecar).batchId === "string" &&
    Array.isArray((value as Sidecar).targets)
  );
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
