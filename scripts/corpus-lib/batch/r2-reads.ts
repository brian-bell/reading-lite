import { ManifestSchema, type Manifest, type ManifestStatus } from "../../../src/schemas/manifest";
import type { ListIndexItem } from "../../../src/schemas/api";
import type { ByUrlLookup, ByUrlPointer } from "./prepare-fresh-markdown";
import {
  LIST_INDEX_KEY,
  MANIFEST_FILE,
  READINGS_PREFIX,
  r2KeyLayout,
} from "../../../src/modules/stores/layout";

// Relative-key spelling only: keys built here are handed to a tenant-rooted
// client (withKeyRoot) or tenant-rooted R2Deps, which apply the operator's
// --tenant key root. This module never sees the root (s1k.4.3).
const layout = r2KeyLayout();

// URL-ownership preference when duplicate readings exist for one URL, mirroring
// ListIndexStore's OWNERSHIP_RANK: a ready reading owns the URL over a pending
// one, which beats a failed one. Recency breaks ties within a status class.
const OWNERSHIP_RANK: Record<ManifestStatus, number> = { ready: 3, pending: 2, failed: 1 };

// The two R2 reads the bulk paths share: the by-url ownership pointer and the
// manifest behind a key prefix. Single-homed so the recover path, the
// fresh-markdown run, and the CLI dry-run can't drift in how they parse them.
export interface R2Getter {
  get(key: string): Promise<string | null>;
}

// findByUrlInList needs a full-bucket scan to rebuild ownership when
// index/list.json is missing, so it requires listKeys on top of get.
export interface R2Lister extends R2Getter {
  listKeys(): Promise<string[]>;
}

const MANIFEST_SUFFIX = `/${MANIFEST_FILE}`;

// The minimal owner row the cold lookup ranks over. Index rows read the manifest
// lazily during verification; rebuilt rows already hold it (the scan read it).
interface OwnerRow {
  id: string;
  key_prefix: string;
  url: string;
  status: ManifestStatus;
  created_at: string;
  updated_at?: string;
  manifest?: Manifest;
}

// null = no object (unclaimed). "damaged" = object present but unusable (non-JSON
// or missing id/key_prefix) — surfaced distinctly so fresh ingest can skip the
// occupied slot rather than treating a corrupt claim as unclaimed and risking a
// duplicate mint. The Worker's strict ByUrlPointerSchema.parse throws on the same
// input; for an offline bulk run we degrade to "damaged" so one bad pointer can
// be reported without aborting the whole ingest.
export async function getByUrl(r2: R2Getter, urlHash: string): Promise<ByUrlLookup | null> {
  const raw = await r2.get(layout.byUrlKey(urlHash));
  if (!raw) return null;
  let parsed: Partial<ByUrlPointer>;
  try {
    parsed = JSON.parse(raw) as Partial<ByUrlPointer>;
  } catch {
    return "damaged";
  }
  if (typeof parsed.id !== "string" || typeof parsed.key_prefix !== "string") return "damaged";
  return { id: parsed.id, key_prefix: parsed.key_prefix };
}

export async function readManifest(r2: R2Getter, keyPrefix: string): Promise<Manifest | null> {
  const raw = await r2.get(layout.manifestKey(keyPrefix));
  return raw ? ManifestSchema.parse(JSON.parse(raw)) : null;
}

// Like readManifest but tolerant: returns null instead of throwing on missing,
// non-JSON, or schema-drifted manifests. Used only by the full-bucket rebuild
// scan, where one corrupt object must not abort ownership resolution — mirroring
// the Worker's rebuild(), which safeParses and skips bad manifests. The targeted
// by-url owner read stays strict (readManifest) so a damaged claim still surfaces.
async function safeReadManifest(r2: R2Getter, keyPrefix: string): Promise<Manifest | null> {
  const raw = await r2.get(`${keyPrefix}${MANIFEST_SUFFIX}`);
  if (!raw) return null;
  try {
    const parsed = ManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// The cold-legacy lookup, mirroring the Worker's findManifestByUrl: resolve a
// URL's owner through index/list.json when no live by-url pointer exists. A
// prior legacy failed ingest may have a by-id pointer + list row but no by-url
// pointer, so this is how a rerun finds it. Ranks same-URL rows by ownership then
// recency and returns the first whose manifest genuinely matches the URL. The
// verified manifest is the source of truth for the owner id, not the list row:
// a stale/cross-wired row can carry a different id than the manifest its
// key_prefix points at, and re-ingesting under the row id would overwrite that
// manifest under the wrong reading id.
//
// The scan/merge helper remains available for callers that need Worker-parity
// repair behavior. It rebuilds candidate rows from a full manifest scan when ANY
// of:
//   - the index is missing/unparseable (a deleted/corrupted index would
//     otherwise read an owned URL as unclaimed → duplicate mint + by-url
//     overwrite);
//   - the parsed index already holds a row for this URL (stale same-URL
//     reconciliation: the indexed row may point at a missing/mismatched manifest
//     while the real owner has fallen out of the index);
//   - `forceScan` is set by a repair caller that needs a full scan even when the
//     index looks parseable.
// A brand-new URL with a parseable index and no matching row scans nothing, so a
// first-time submit never pays for a full bucket scan (matching the Worker).
// Scanned rows win per key_prefix — they carry the freshly read manifest.
export async function findByUrlInList(
  r2: R2Lister,
  url: string,
  urlHash: string,
  opts: { forceScan?: boolean } = {},
): Promise<{ id: string; key_prefix: string; manifest: Manifest } | null> {
  const indexed = await readListIndexRows(r2);
  const indexedMatches = (indexed ?? []).filter(
    (i) => i.url === url && typeof i.key_prefix === "string" && typeof i.id === "string",
  );

  const byPrefix = new Map<string, OwnerRow>();
  for (const row of indexedMatches) byPrefix.set(row.key_prefix, row);
  if (indexed === null || indexedMatches.length > 0 || opts.forceScan === true) {
    for (const row of await rebuildRowsFromManifests(r2)) {
      if (row.url === url) byPrefix.set(row.key_prefix, row);
    }
  }

  const matches = [...byPrefix.values()];
  matches.sort((a, b) => {
    const rankDiff = (OWNERSHIP_RANK[b.status] ?? 0) - (OWNERSHIP_RANK[a.status] ?? 0);
    if (rankDiff !== 0) return rankDiff;
    const aTime = a.updated_at ?? a.created_at;
    const bTime = b.updated_at ?? b.created_at;
    return aTime < bTime ? 1 : aTime > bTime ? -1 : 0;
  });

  for (const item of matches) {
    // Rebuilt rows already carry the scanned manifest; index rows read it lazily.
    const manifest = item.manifest ?? (await readManifest(r2, item.key_prefix));
    if (manifest?.url === url && manifest.url_hash === urlHash) {
      return { id: manifest.id, key_prefix: item.key_prefix, manifest };
    }
  }
  return null;
}

// Parse index/list.json into owner rows, or null when it is absent/unparseable
// so the caller can fall back to a manifest scan.
async function readListIndexRows(r2: R2Getter): Promise<OwnerRow[] | null> {
  const raw = await r2.get(LIST_INDEX_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { items?: ListIndexItem[] };
    if (!Array.isArray(parsed.items)) return null;
    return parsed.items.map((i) => ({
      id: i.id,
      key_prefix: i.key_prefix,
      url: i.url,
      status: i.status,
      created_at: i.created_at,
      ...(i.updated_at === undefined ? {} : { updated_at: i.updated_at }),
    }));
  } catch {
    return null;
  }
}

// Recovery fallback mirroring ListIndexStore.rebuild(): scan readings/ for
// manifests and synthesize owner rows from them. The manifest is carried on the
// row so the verify loop doesn't re-read it.
async function rebuildRowsFromManifests(r2: R2Lister): Promise<OwnerRow[]> {
  const keys = await r2.listKeys();
  const rows: OwnerRow[] = [];
  for (const key of keys) {
    if (!key.startsWith(READINGS_PREFIX) || !key.endsWith(MANIFEST_SUFFIX)) continue;
    const keyPrefix = key.slice(0, -MANIFEST_SUFFIX.length);
    // Tolerate one corrupt/schema-drifted manifest: skip it rather than abort the
    // whole scan (and with it the bulk ingest), exactly as the Worker's rebuild().
    const manifest = await safeReadManifest(r2, keyPrefix);
    if (!manifest) continue;
    rows.push({
      id: manifest.id,
      key_prefix: keyPrefix,
      url: manifest.url,
      status: manifest.status,
      created_at: manifest.created_at,
      ...(manifest.updated_at === undefined ? {} : { updated_at: manifest.updated_at }),
      manifest,
    });
  }
  return rows;
}

// The ownership-read trio prepareFreshMarkdown wants, bound to one R2 client.
export function r2ReadDeps(r2: R2Lister): {
  getByUrl(urlHash: string): Promise<ByUrlLookup | null>;
  readManifest(keyPrefix: string): Promise<Manifest | null>;
  findByUrlInList(
    url: string,
    urlHash: string,
    opts?: { forceScan?: boolean },
  ): Promise<{ id: string; key_prefix: string; manifest: Manifest } | null>;
} {
  return {
    getByUrl: (urlHash) => getByUrl(r2, urlHash),
    readManifest: (keyPrefix) => readManifest(r2, keyPrefix),
    findByUrlInList: (url, urlHash, opts) => findByUrlInList(r2, url, urlHash, opts),
  };
}
