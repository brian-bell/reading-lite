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
// recency and returns the first whose manifest genuinely matches the URL.
export async function findByUrlInList(
  r2: R2Getter,
  url: string,
  urlHash: string,
): Promise<{ id: string; key_prefix: string; manifest: Manifest } | null> {
  const raw = await r2.get(LIST_INDEX_KEY);
  if (!raw) return null;
  let items: ListIndexItem[] = [];
  try {
    const parsed = JSON.parse(raw) as { items?: ListIndexItem[] };
    if (Array.isArray(parsed.items)) items = parsed.items;
  } catch {
    return null;
  }

  const matches = items.filter(
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
    const manifest = await readManifest(r2, item.key_prefix);
    if (manifest?.url === url && manifest.url_hash === urlHash) {
      return { id: item.id, key_prefix: item.key_prefix, manifest };
    }
  }
  return null;
}

// The ownership-read trio prepareFreshMarkdown wants, bound to one R2 client.
export function r2ReadDeps(r2: R2Getter): {
  getByUrl(urlHash: string): Promise<ByUrlPointer | null>;
  readManifest(keyPrefix: string): Promise<Manifest | null>;
  findByUrlInList(
    url: string,
    urlHash: string,
  ): Promise<{ id: string; key_prefix: string; manifest: Manifest } | null>;
} {
  return {
    getByUrl: (urlHash) => getByUrl(r2, urlHash),
    readManifest: (keyPrefix) => readManifest(r2, keyPrefix),
    findByUrlInList: (url, urlHash) => findByUrlInList(r2, url, urlHash),
  };
}
