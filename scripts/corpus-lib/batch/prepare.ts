import type { Manifest } from "../../../src/schemas/manifest";
import type { AuditRow } from "../types";
import type { BatchTarget, DroppedTarget } from "./types";

export interface PrepareDeps {
  // Reads the current manifest for a key prefix (R2 via S3), or null if absent.
  readManifest(keyPrefix: string): Promise<Manifest | null>;
  // The cold-legacy URL-ownership lookup (ready>pending>failed rank, then
  // recency), mirroring the Worker's findManifestByUrl / the fresh-ingest path.
  // The recover path needs it so an audit row for a failed duplicate isn't
  // recovered (and its by-url eagerly claimed) when a *pointerless* ready/pending
  // owner for the same URL already exists — otherwise the eager claim would
  // redirect online ownership to the worse reading.
  findByUrlInList(
    url: string,
    urlHash: string,
  ): Promise<{ id: string; key_prefix: string; manifest: Manifest } | null>;
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
      dropped.push({ readingId: row.reading_id, reason: "manifest not found in bucket" });
      continue;
    }
    // Honor cold-legacy ownership before we let the eager claim write a by-url
    // pointer to this (failed/pending) row: if a DIFFERENT reading already owns
    // the URL as ready/pending — even with no by-url pointer of its own — this
    // row is an orphan duplicate. Drop it rather than redirect the URL to the
    // worse reading. (A different *failed* owner is left to the claim phase, which
    // defers the second one off the by-url slot.)
    const cold = await deps.findByUrlInList(manifest.url, manifest.url_hash);
    if (cold && cold.id !== manifest.id && (cold.manifest.status === "ready" || cold.manifest.status === "pending")) {
      dropped.push({
        readingId: manifest.id,
        reason: `URL already owned by a ${cold.manifest.status} reading (${cold.id}); not recovering this duplicate`,
      });
      continue;
    }
    targets.push({
      readingId: manifest.id,
      url: manifest.url,
      urlHash: manifest.url_hash,
      keyPrefix: row.key_prefix,
      createdAt: manifest.created_at,
      manifest,
    });
  }
  return { targets, dropped };
}
