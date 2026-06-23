import { ManifestSchema, type ByUrlPointer, type ManifestStatus } from "../../../src/schemas/manifest";
import { ListIndexItemSchema, type ListIndexItem } from "../../../src/schemas/api";
import { manifestToIndexItem, MANIFEST_FILE, READINGS_PREFIX } from "../../../src/modules/stores/list-index";

// The subset of the R2 client this resolver needs: read an object and list keys.
type R2Reader = {
  get(key: string): Promise<string | null>;
  listKeys(): Promise<string[]>;
};

const LIST_INDEX_KEY = "index/list.json";

const OWNERSHIP_RANK: Record<ManifestStatus, number> = { ready: 3, pending: 2, failed: 1 };

// Best owner first: ready > pending > failed, then most recent. Mirrors
// ListIndexStore's recency tie-break on updated_at ?? created_at.
function byOwnershipThenRecency(a: ListIndexItem, b: ListIndexItem): number {
  const ra = OWNERSHIP_RANK[a.status] ?? 0;
  const rb = OWNERSHIP_RANK[b.status] ?? 0;
  if (ra !== rb) return rb - ra;
  return Date.parse(b.updated_at ?? b.created_at) - Date.parse(a.updated_at ?? a.created_at);
}

// Lazily index index/list.json by URL (the master list, which includes legacy
// readings with no by-url pointer) and return ALL candidate pointers for a URL,
// ranked best-first — ready > pending > failed, then most recent. prepareFreshMarkdown
// re-reads and verifies each candidate's manifest until one matches, so a stale top
// row can't mask a valid lower one. Read once and cached across articles.
//
// Index-state handling mirrors the worker's ownership resolver exactly:
//   - absent index/list.json  -> rebuild candidates from a full manifest scan, so a
//                                pointerless legacy reading is still adopted (the
//                                worker's findManifestByUrl rebuilds when readListIndex
//                                returns null). An empty bucket yields no candidates.
//   - present but corrupt      -> FAIL CLOSED (the worker throws in readListIndex). A
//                                silent "treat as empty" would disable cold-legacy
//                                adoption and duplicate already-ingested URLs.
export function makeListCandidatesResolver(r2: R2Reader): (url: string) => Promise<ByUrlPointer[]> {
  let byUrl: Map<string, ListIndexItem[]> | null = null;

  const indexByUrl = (items: ListIndexItem[]): Map<string, ListIndexItem[]> => {
    const map = new Map<string, ListIndexItem[]>();
    for (const item of items) {
      const group = map.get(item.url) ?? [];
      group.push(item);
      map.set(item.url, group);
    }
    for (const group of map.values()) group.sort(byOwnershipThenRecency);
    return map;
  };

  const load = async (): Promise<Map<string, ListIndexItem[]>> => {
    const raw = await r2.get(LIST_INDEX_KEY);
    // Absent: a genuinely cold/empty corpus OR a bucket whose index was never built
    // or was deleted during surgery. Rebuild from manifests so pointerless legacy
    // readings are adopted, exactly as the worker does.
    if (raw === null) return indexByUrl(await rebuildFromManifests(r2));
    // Present-but-corrupt: fail closed (mirrors the worker throwing in readListIndex).
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `index/list.json exists but is unparseable — refusing to ingest. Treating it as ` +
          `empty would disable cold-legacy adoption and duplicate already-ingested URLs. ` +
          `Inspect/repair the list index before retrying.`,
      );
    }
    const rawItems = (parsed as { items?: unknown }).items;
    if (!Array.isArray(rawItems)) {
      throw new Error(
        `index/list.json is missing its "items" array — refusing to ingest, since treating ` +
          `it as empty would disable cold-legacy adoption and duplicate already-ingested URLs.`,
      );
    }
    const items: ListIndexItem[] = [];
    for (const candidate of rawItems) {
      const item = ListIndexItemSchema.safeParse(candidate);
      if (item.success) items.push(item.data);
    }
    return indexByUrl(items);
  };

  return async (url: string): Promise<ByUrlPointer[]> => {
    if (!byUrl) byUrl = await load();
    return (byUrl.get(url) ?? []).map((item) => ({ id: item.id, key_prefix: item.key_prefix }));
  };
}

// Mirror ListIndexStore.rebuild(): scan readings/ for manifests, parse each (skipping
// unreadable/invalid ones), and synthesize index items. The cold-legacy fallback when
// index/list.json is absent.
async function rebuildFromManifests(r2: R2Reader): Promise<ListIndexItem[]> {
  const keys = await r2.listKeys();
  const manifestKeys = keys.filter(
    (k) => k.startsWith(READINGS_PREFIX) && k.endsWith(`/${MANIFEST_FILE}`),
  );
  const items: ListIndexItem[] = [];
  for (const key of manifestKeys) {
    const raw = await r2.get(key);
    if (raw === null) continue;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    const parsed = ManifestSchema.safeParse(json);
    if (!parsed.success) continue;
    const keyPrefix = key.slice(0, -(`/${MANIFEST_FILE}`).length);
    items.push(manifestToIndexItem(parsed.data, keyPrefix));
  }
  return items;
}
