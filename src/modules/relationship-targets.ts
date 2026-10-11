import type {
  GetReadingRelationshipsResponse,
  ListIndexItem,
  RelationshipRow,
  RelationshipsReading,
  RelationshipTarget,
  RelationshipTargets,
} from "../schemas/api";
import type { Manifest } from "../schemas/manifest";
import { applyStaleness } from "./staleness";

/**
 * Read-time enrichment for `GET /api/readings/:id`: the reading's connection
 * and tension targets resolved against the same tenant's readings
 * (PgReadingStore.relationshipTargets). Response-only — never stored on the
 * manifest. An id with no reading row is
 * removed or unavailable and is omitted, so callers render the removed card.
 */

export function relationshipTargetIds(
  manifest: Pick<Manifest, "connections" | "tensions">,
): string[] {
  const ids = new Set<string>();
  for (const c of manifest.connections ?? []) ids.add(c.id);
  for (const t of manifest.tensions ?? []) ids.add(t.id);
  return [...ids];
}

// Status goes through the same stale annotation as the list view, so a target
// shows the status the library would show for it.
export function projectRelationshipTargets(
  ids: readonly string[],
  items: readonly ListIndexItem[],
  ttlSeconds: number,
  nowIso: string,
): RelationshipTargets {
  const wanted = new Set(ids);
  const targets: RelationshipTargets = {};
  for (const item of items) {
    if (!wanted.has(item.id)) continue;
    const row = applyStaleness(item, ttlSeconds, nowIso);
    const target: RelationshipTarget = { url: row.url, status: row.status, created_at: row.created_at };
    if (row.title !== undefined) target.title = row.title;
    targets[row.id] = target;
  }
  return targets;
}

// GET /api/readings/relationships: each reading after the same stale
// annotation, cut to what the frontend builds threads from.
export function projectRelationshipGraph(
  graph: { readings: readonly ListIndexItem[]; relationships: readonly RelationshipRow[] },
  ttlSeconds: number,
  nowIso: string,
): GetReadingRelationshipsResponse {
  return {
    readings: graph.readings.map((item) => {
      const row = applyStaleness(item, ttlSeconds, nowIso);
      const reading: RelationshipsReading = { id: row.id, url: row.url, status: row.status, created_at: row.created_at };
      if (row.title !== undefined) reading.title = row.title;
      if (row.tags !== undefined) reading.tags = row.tags;
      return reading;
    }),
    relationships: [...graph.relationships],
  };
}
