// The list-row shape a reading projects to, and the URL-ownership ranking that
// decides which of several readings for one URL owns it. PostgreSQL serves the
// list (PgReadingStore); these are the shared, storage-free pieces.

import type { Manifest, ManifestStatus } from "../../schemas/manifest";
import type { ListIndexItem } from "../../schemas/api";

export interface ListManifestsResult {
  readings: ListIndexItem[];
  total_filtered: number;
}

export interface ListManifestsParams {
  offset: number;
  limit: number;
  q?: string;
  tag?: string;
}

// URL-ownership preference when duplicate readings exist for one URL: a
// completed `ready` reading owns the URL over an in-flight `pending` one, which
// in turn beats a `failed` one, before falling back to recency.
const OWNERSHIP_RANK: Record<ManifestStatus, number> = {
  ready: 3,
  pending: 2,
  failed: 1,
};

// Sorts the strongest URL owner first: ownership rank, then newest by
// updated_at. Exported so the PostgreSQL importer ranks duplicates the same way.
export function compareUrlOwnership(
  a: Pick<ListIndexItem, "status" | "created_at" | "updated_at">,
  b: Pick<ListIndexItem, "status" | "created_at" | "updated_at">,
): number {
  const rankDiff = OWNERSHIP_RANK[b.status] - OWNERSHIP_RANK[a.status];
  if (rankDiff !== 0) return rankDiff;
  const aTime = a.updated_at ?? a.created_at;
  const bTime = b.updated_at ?? b.created_at;
  return aTime < bTime ? 1 : aTime > bTime ? -1 : 0;
}

export function manifestToIndexItem(
  m: Manifest,
  keyPrefix: string,
): ListIndexItem {
  const item: ListIndexItem = {
    id: m.id,
    key_prefix: keyPrefix,
    url: m.url,
    status: m.status,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
  if (m.title !== undefined) item.title = m.title;
  if (m.tldr !== undefined) item.tldr = m.tldr;
  if (m.tags !== undefined) item.tags = m.tags;
  if (m.keywords !== undefined) item.keywords = m.keywords;
  if (m.novelty_verdict !== undefined) item.novelty_verdict = m.novelty_verdict;
  if (m.similarity !== undefined) item.similarity = m.similarity;
  if (m.source_date !== undefined) item.source_date = m.source_date;
  if (m.error !== undefined) item.error = m.error;
  if (m.active_attempt !== undefined) item.active_attempt = m.active_attempt;
  if (m.last_attempt !== undefined) item.last_attempt = m.last_attempt;
  if (m.enrichment_degradation !== undefined) item.enrichment_degradation = m.enrichment_degradation;
  return item;
}
