import type { Manifest } from "../../../src/schemas/manifest";
import type { AuditRow } from "../types";
import type { BatchTarget, DroppedTarget } from "./types";

export interface PrepareDeps {
  // Reads the current manifest for a key prefix (PostgreSQL), or null if absent.
  readManifest(keyPrefix: string): Promise<Manifest | null>;
  newAttemptId(): string;
  now(): string;
}

export interface PrepareResult {
  targets: BatchTarget[];
  dropped: DroppedTarget[];
}

// Resolve audit rows into batch targets. The existing manifest is authoritative
// for created_at / url_hash / content fields and the ready-snapshot to preserve
// on failure, so a row without a manifest can't be summarized and is dropped.
export async function prepareTargets(
  rows: AuditRow[],
  deps: PrepareDeps,
): Promise<PrepareResult> {
  const targets: BatchTarget[] = [];
  const dropped: DroppedTarget[] = [];
  for (const row of rows) {
    const manifest = await deps.readManifest(row.key_prefix);
    if (!manifest) {
      dropped.push({ readingId: row.reading_id, reason: "reading not found in PostgreSQL" });
      continue;
    }
    targets.push({
      readingId: manifest.id,
      url: manifest.url,
      urlHash: manifest.url_hash,
      keyPrefix: row.key_prefix,
      createdAt: manifest.created_at,
      attemptId: deps.newAttemptId(),
      attemptStartedAt: deps.now(),
      trigger: "reprocess",
      manifest,
    });
  }
  return { targets, dropped };
}
