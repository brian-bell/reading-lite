import {
  ManifestSchema,
  type Manifest,
  type ManifestStatus,
} from "../../schemas/manifest";
import {
  ListIndexSchema,
  type ListIndex,
  type ListIndexItem,
} from "../../schemas/api";
import { sha256Hex } from "../../services";

// R2 layout this module reads: the list index object, plus the manifests it
// scans/parses to rebuild and to resolve URL ownership. `ReadingStore` imports
// these so the object layout stays single-homed (reading-store.ts → list-index.ts,
// no back-edge).
export const LIST_INDEX_KEY = "index/list.json";
export const MANIFEST_FILE = "manifest.json";
export const READINGS_PREFIX = "readings/";

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

export interface FindManifestByUrlOptions {
  deepScan?: boolean;
}

// URL-ownership preference when duplicate readings exist for one URL: a
// completed `ready` reading owns the URL over an in-flight `pending` one, which
// in turn beats a `failed` one. Used to break ties in findNewestManifestByUrl
// before falling back to recency.
const OWNERSHIP_RANK: Record<ManifestStatus, number> = {
  ready: 3,
  pending: 2,
  failed: 1,
};

function ownershipRank(status: ManifestStatus): number {
  return OWNERSHIP_RANK[status] ?? 0;
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
  if (m.error !== undefined) item.error = m.error;
  if (m.active_attempt !== undefined) item.active_attempt = m.active_attempt;
  if (m.last_attempt !== undefined) item.last_attempt = m.last_attempt;
  return item;
}

// Deps for the optimistic-concurrency loop on index/list.json. Injectable so
// tests can drive contention deterministically and skip real backoff sleeps.
export interface ListIndexCasDeps {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface ResolvedCasDeps {
  maxAttempts: number;
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

// Owns index/list.json: the optimistic-concurrency mutate loop, the q/tag
// filter+sort+paginate read path (q is title/tldr/url/keywords), URL-ownership
// resolution (the ready>pending>failed ranking), and the full-bucket rebuild
// fallback. `ReadingStore`
// composes one and delegates its public index methods here.
export class ListIndexStore {
  private readonly cas: ResolvedCasDeps;

  constructor(
    private readonly bucket: R2Bucket,
    casDeps: ListIndexCasDeps = {},
  ) {
    this.cas = {
      maxAttempts: casDeps.maxAttempts ?? 8,
      baseDelayMs: casDeps.baseDelayMs ?? 20,
      sleep: casDeps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: casDeps.random ?? Math.random,
    };
  }

  async readListIndex(): Promise<ListIndex | null> {
    const obj = await this.bucket.get(LIST_INDEX_KEY);
    if (!obj) return null;
    const json: unknown = JSON.parse(await obj.text());
    return ListIndexSchema.parse(json);
  }

  async writeListIndex(index: ListIndex): Promise<void> {
    await this.bucket.put(LIST_INDEX_KEY, JSON.stringify(index), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  async appendOrReplace(item: ListIndexItem): Promise<void> {
    await this.mutateListIndex((items) => [
      ...items.filter((i) => i.id !== item.id),
      item,
    ]);
  }

  async remove(id: string): Promise<void> {
    const index = await this.readListIndex();
    if (!index) return;
    await this.mutateListIndex((items) => items.filter((i) => i.id !== id));
  }

  async removeIf(
    id: string,
    predicate: (item: ListIndexItem) => boolean,
  ): Promise<void> {
    const index = await this.readListIndex();
    if (!index) return;
    await this.mutateListIndex((items) =>
      items.filter((i) => i.id !== id || !predicate(i)),
    );
  }

  // Read-modify-write of index/list.json guarded by an R2 compare-and-set:
  // the put is conditional on the etag we read (If-None-Match:* when the object
  // is absent). A concurrent writer changes the etag, R2 returns null for our
  // put, and we re-read + re-apply rather than clobbering their item. This is
  // what lets the queue consumer run with max_concurrency > 1 without losing
  // index entries to last-writer-wins.
  private async mutateListIndex(
    mutate: (items: ListIndexItem[]) => ListIndexItem[],
  ): Promise<void> {
    for (let attempt = 0; attempt < this.cas.maxAttempts; attempt++) {
      const obj = await this.bucket.get(LIST_INDEX_KEY);
      const current = obj
        ? ListIndexSchema.parse(JSON.parse(await obj.text()))
        : { version: 1 as const, items: [] };
      const next: ListIndex = { version: 1, items: mutate(current.items) };

      const onlyIf: R2PutOptions["onlyIf"] = obj
        ? { etagMatches: obj.etag }
        : new Headers({ "If-None-Match": "*" });
      const res = await this.bucket.put(LIST_INDEX_KEY, JSON.stringify(next), {
        httpMetadata: { contentType: "application/json" },
        onlyIf,
      });
      if (res !== null) return;

      if (attempt < this.cas.maxAttempts - 1) {
        await this.cas.sleep(this.casBackoffMs(attempt));
      }
    }
    throw new Error(
      `list index write failed: exhausted ${this.cas.maxAttempts} CAS attempts under contention`,
    );
  }

  // Exponential backoff with full jitter, mirroring http-retry.
  private casBackoffMs(attempt: number): number {
    const ceiling = this.cas.baseDelayMs * 2 ** attempt;
    return Math.floor(this.cas.random() * ceiling);
  }

  async find(id: string): Promise<ListIndexItem | null> {
    const index = await this.readListIndex();
    return index?.items.find((i) => i.id === id) ?? null;
  }

  async findManifestByUrl(
    url: string,
    opts: FindManifestByUrlOptions = {},
  ): Promise<{ keyPrefix: string; manifest: Manifest } | null> {
    const index = await this.readListIndex();
    const candidates = new Map<string, ListIndexItem>();
    const indexedMatches = (index?.items ?? []).filter((item) => item.url === url);
    for (const item of indexedMatches) {
      if (item.url === url) candidates.set(item.key_prefix, item);
    }

    // Avoid turning every first-time URL submit into a full bucket scan. We
    // scan when there is no index to consult, when an indexed same-URL row
    // needs stale-index reconciliation, or when a damaged owner asks for the
    // strongest repair path explicitly.
    if (!index || indexedMatches.length > 0 || opts.deepScan) {
      const rebuilt = await this.rebuild();
      for (const item of rebuilt.items) {
        if (item.url === url) candidates.set(item.key_prefix, item);
      }
    }

    return this.findNewestManifestByUrl([...candidates.values()], url, await sha256Hex(url));
  }

  async list(params: ListManifestsParams): Promise<ListManifestsResult> {
    let index = await this.readListIndex();
    if (!index) {
      const rebuilt = await this.rebuild();
      index = { version: 1, items: rebuilt.items };
      // Persist only when the rebuild was complete and non-empty. Skipping the
      // write on `truncated` avoids permanently shadowing a >1000-manifest
      // bucket with an incomplete index; skipping on `empty` avoids creating a
      // stub on a totally cold bucket.
      if (rebuilt.complete && rebuilt.items.length > 0) {
        await this.writeListIndex(index);
      } else if (!rebuilt.complete) {
        console.warn(
          `rebuildListIndex: R2 list returned truncated:true (>${rebuilt.items.length} manifests); not persisting partial index`,
        );
      }
    }

    const q = params.q?.trim().toLowerCase() ?? "";
    const tag = params.tag?.trim().toLowerCase() ?? "";

    const filtered = index.items.filter((item) => {
      if (q !== "") {
        const hay = `${item.title ?? ""}\n${item.tldr ?? ""}\n${item.url}\n${(item.keywords ?? []).join("\n")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (tag !== "") {
        const tags = (item.tags ?? []).map((t) => t.toLowerCase());
        if (!tags.includes(tag)) return false;
      }
      return true;
    });

    filtered.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

    const slice = filtered.slice(params.offset, params.offset + params.limit);
    return { readings: slice, total_filtered: filtered.length };
  }

  private async findNewestManifestByUrl(
    items: ListIndexItem[],
    url: string,
    urlHash: string,
  ): Promise<{ keyPrefix: string; manifest: Manifest } | null> {
    const matches = items.filter((item) => item.url === url);
    // Ownership rank first, recency second. A URL can have duplicate readings
    // (the recurring "failed orphan-dup" corpus state: a failed re-submit left
    // beside an earlier ready copy). The ready copy owns the URL, so a `ready`
    // owner must beat a *newer* `failed` one — ranking purely by updated_at would
    // repair the by-url pointer to the failed duplicate and orphan the ready
    // summary by URL. Within a status class, newest-by-updated_at still wins.
    matches.sort((a, b) => {
      const rankDiff = ownershipRank(b.status) - ownershipRank(a.status);
      if (rankDiff !== 0) return rankDiff;
      const aTime = a.updated_at ?? a.created_at;
      const bTime = b.updated_at ?? b.created_at;
      return aTime < bTime ? 1 : aTime > bTime ? -1 : 0;
    });
    for (const item of matches) {
      const manifest = await this.readManifest(item.key_prefix);
      if (manifest?.url === url && manifest.url_hash === urlHash) {
        return { keyPrefix: item.key_prefix, manifest };
      }
    }
    return null;
  }

  // Minimal manifest read for ownership resolution. ListIndexStore reads
  // manifests directly (rather than depending on ReadingStore) to keep the
  // dependency graph acyclic.
  private async readManifest(keyPrefix: string): Promise<Manifest | null> {
    const obj = await this.bucket.get(`${keyPrefix}/${MANIFEST_FILE}`);
    if (!obj) return null;
    const json: unknown = JSON.parse(await obj.text());
    return ManifestSchema.parse(json);
  }

  async rebuild(): Promise<{ items: ListIndexItem[]; complete: boolean }> {
    // Recovery fallback: scan readings/ for manifests, parse each, and
    // synthesise an index when URL ownership/index state is missing or stale.
    // The result is persisted by callers only when every page was read.
    const manifestKeys: string[] = [];
    let cursor: string | undefined;
    let complete = true;
    do {
      const list = await this.bucket.list({
        prefix: READINGS_PREFIX,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      manifestKeys.push(
        ...list.objects
          .map((o) => o.key)
          .filter((k) => k.endsWith(`/${MANIFEST_FILE}`)),
      );
      if (list.truncated && !list.cursor) complete = false;
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);

    const items: ListIndexItem[] = [];
    for (const key of manifestKeys) {
      const obj = await this.bucket.get(key);
      if (!obj) continue;
      const json: unknown = JSON.parse(await obj.text());
      const parsed = ManifestSchema.safeParse(json);
      if (!parsed.success) continue;
      const keyPrefix = key.slice(0, -("/" + MANIFEST_FILE).length);
      items.push(manifestToIndexItem(parsed.data, keyPrefix));
    }
    return { items, complete };
  }
}
