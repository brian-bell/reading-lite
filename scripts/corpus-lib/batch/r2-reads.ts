import { ManifestSchema, type Manifest, type ManifestStatus } from "../../../src/schemas/manifest";
import type { ListIndexItem } from "../../../src/schemas/api";
import type { ByUrlPointer } from "./prepare-fresh-markdown";

const LIST_INDEX_KEY = "index/list.json";

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

const READINGS_PREFIX = "readings/";
const MANIFEST_SUFFIX = "/manifest.json";

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

export async function getByUrl(r2: R2Getter, urlHash: string): Promise<ByUrlPointer | null> {
  const raw = await r2.get(`index/by-url/${urlHash}`);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<ByUrlPointer>;
  if (typeof parsed.id !== "string" || typeof parsed.key_prefix !== "string") return null;
  return { id: parsed.id, key_prefix: parsed.key_prefix };
}

export async function readManifest(r2: R2Getter, keyPrefix: string): Promise<Manifest | null> {
  const raw = await r2.get(`${keyPrefix}/manifest.json`);
  return raw ? ManifestSchema.parse(JSON.parse(raw)) : null;
}

// The cold-legacy lookup, mirroring the Worker's findManifestByUrl: resolve a
// URL's owner through index/list.json when no live by-url pointer exists. A
// failed fresh ingest leaves a by-id pointer + list row but no by-url pointer,
// so this is how a rerun finds it. Ranks same-URL rows by ownership then
// recency and returns the first whose manifest genuinely matches the URL. The
// verified manifest is the source of truth for the owner id, not the list row:
// a stale/cross-wired row can carry a different id than the manifest its
// key_prefix points at, and re-ingesting under the row id would overwrite that
// manifest under the wrong reading id.
//
// When index/list.json is missing or unparseable we rebuild candidate rows from
// a full manifest scan, exactly as the Worker's findManifestByUrl falls back to
// rebuild(). Returning null here instead would treat an already-owned URL as
// unclaimed on a corpus whose index was deleted/corrupted (manifests intact),
// minting a duplicate reading and repointing by-url at it on success.
//
// `forceScan` mirrors the Worker's `deepScan: true` repair policy for a damaged
// by-url pointer: scan the bucket even when the index parses, then merge the scan
// with the index rows. A stale index that lost the owner's row would otherwise
// let a damaged-pointer re-ingest mint a duplicate and overwrite by-url, orphaning
// the real owner. Plain cold (no pointer) lookups leave forceScan off so a
// first-time URL submit doesn't pay for a full bucket scan (matching the Worker).
export async function findByUrlInList(
  r2: R2Lister,
  url: string,
  urlHash: string,
  opts: { forceScan?: boolean } = {},
): Promise<{ id: string; key_prefix: string; manifest: Manifest } | null> {
  const indexed = await readListIndexRows(r2);
  const rows = await resolveOwnerRows(r2, indexed, opts.forceScan === true);

  const matches = rows.filter(
    (i) => i.url === url && typeof i.key_prefix === "string" && typeof i.id === "string",
  );
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

// Decide the candidate owner rows to rank. Without forceScan: trust the index
// when it parses, else rebuild from a scan. With forceScan (damaged-pointer
// repair): always scan and merge with the index rows so a stale index that
// dropped the owner's row still surfaces it. Scanned rows win per key_prefix —
// they carry the freshly read manifest.
async function resolveOwnerRows(
  r2: R2Lister,
  indexed: OwnerRow[] | null,
  forceScan: boolean,
): Promise<OwnerRow[]> {
  if (!forceScan) return indexed ?? (await rebuildRowsFromManifests(r2));
  const scanned = await rebuildRowsFromManifests(r2);
  const byPrefix = new Map<string, OwnerRow>();
  for (const row of indexed ?? []) byPrefix.set(row.key_prefix, row);
  for (const row of scanned) byPrefix.set(row.key_prefix, row);
  return [...byPrefix.values()];
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
    const manifest = await readManifest(r2, keyPrefix);
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
  getByUrl(urlHash: string): Promise<ByUrlPointer | null>;
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
