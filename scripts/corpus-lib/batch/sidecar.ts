import { promises as fs } from "node:fs";
import type { Sidecar } from "./types";

// The sidecar lives next to the audit index: ./index.json -> ./index.batch.json.
// It records the in-flight batch so a crashed/interrupted poll resumes without
// re-submitting (and re-billing) the summarize step.
export function sidecarPath(indexPath: string): string {
  return indexPath.replace(/\.json$/i, "") + ".batch.json";
}

export async function loadSidecar(path: string): Promise<Sidecar | null> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as Sidecar;
  } catch {
    return null;
  }
}

export async function saveSidecar(path: string, sidecar: Sidecar): Promise<void> {
  await fs.writeFile(path, JSON.stringify(sidecar, null, 2) + "\n");
}

export async function clearSidecar(path: string): Promise<void> {
  await fs.rm(path, { force: true });
}
