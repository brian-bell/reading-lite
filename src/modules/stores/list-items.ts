// The list query's parameters and result, and the URL-ownership ranking that
// decides which of several readings for one URL owns it. PostgreSQL serves the
// list (PgReadingStore); these are the shared, storage-free pieces.

import type { ManifestStatus } from "../../schemas/manifest";
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
