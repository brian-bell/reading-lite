import {
  ManifestSchema,
  ProcessingAttemptSchema,
  ByUrlPointerSchema,
  type Manifest,
  type ProcessingAttempt,
  type ByUrlPointer,
} from "../../schemas/manifest";
import {
  ListIndexSchema,
  type ListIndex,
  type ListIndexItem,
} from "../../schemas/api";
import { sha256Hex } from "../../services";

export class PointerExistsError extends Error {
  constructor(public readonly urlHash: string) {
    super(`by-url pointer already exists for hash ${urlHash}`);
    this.name = "PointerExistsError";
  }
}

export interface StoredByUrlPointer {
  pointer: ByUrlPointer;
  etag: string;
}

const MANIFEST_FILE = "manifest.json";
const EXTRACTED_FILE = "extracted.md";
const RAW_PREFIX = "raw.";
const ATTEMPTS_PREFIX = "attempts/";
const BY_URL_PREFIX = "index/by-url/";
const BY_ID_PREFIX = "index/by-id/";
const READINGS_PREFIX = "readings/";
const LIST_INDEX_KEY = "index/list.json";

export function buildKeyPrefix(id: string, createdAtIso: string): string {
  // Compact UTC timestamp: 2026-04-26T20:00:00.000Z → 2026/04/26T200000Z
  const m = createdAtIso.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/,
  );
  if (!m) throw new Error(`buildKeyPrefix: invalid ISO timestamp: ${createdAtIso}`);
  const [, y, mo, d, h, mi, s] = m;
  return `${READINGS_PREFIX}${y}/${mo}/${d}T${h}${mi}${s}Z-${id}`;
}

export interface RawObject {
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  body: ReadableStream | null;
  contentType: string;
  size: number;
}

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
  if (m.novelty_verdict !== undefined) item.novelty_verdict = m.novelty_verdict;
  if (m.error !== undefined) item.error = m.error;
  if (m.active_attempt !== undefined) item.active_attempt = m.active_attempt;
  if (m.last_attempt !== undefined) item.last_attempt = m.last_attempt;
  return item;
}

export interface ReadingObjectInfo {
  key: string;
  size: number;
  uploaded?: string;
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

export class ReadingStore {
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

  async writeManifest(keyPrefix: string, manifest: Manifest): Promise<void> {
    await this.bucket.put(`${keyPrefix}/${MANIFEST_FILE}`, JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  async readManifest(keyPrefix: string): Promise<Manifest | null> {
    const obj = await this.bucket.get(`${keyPrefix}/${MANIFEST_FILE}`);
    if (!obj) return null;
    const json: unknown = JSON.parse(await obj.text());
    return ManifestSchema.parse(json);
  }

  async writeRaw(
    keyPrefix: string,
    ext: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.bucket.put(`${keyPrefix}/${RAW_PREFIX}${ext}`, bytes, {
      httpMetadata: { contentType },
    });
  }

  async readRaw(keyPrefix: string, ext: string): Promise<RawObject | null> {
    const obj = await this.bucket.get(`${keyPrefix}/${RAW_PREFIX}${ext}`);
    if (!obj) return null;
    return {
      arrayBuffer: () => obj.arrayBuffer(),
      text: () => obj.text(),
      body: obj.body,
      contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
      size: obj.size,
    };
  }

  async writeExtracted(keyPrefix: string, markdown: string): Promise<void> {
    await this.bucket.put(`${keyPrefix}/${EXTRACTED_FILE}`, markdown, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
  }

  async readExtracted(keyPrefix: string): Promise<RawObject | null> {
    const obj = await this.bucket.get(`${keyPrefix}/${EXTRACTED_FILE}`);
    if (!obj) return null;
    return {
      arrayBuffer: () => obj.arrayBuffer(),
      text: () => obj.text(),
      body: obj.body,
      contentType: obj.httpMetadata?.contentType ?? "text/markdown; charset=utf-8",
      size: obj.size,
    };
  }

  async writeAttempt(keyPrefix: string, attempt: ProcessingAttempt): Promise<void> {
    await this.bucket.put(
      `${keyPrefix}/${ATTEMPTS_PREFIX}${attempt.id}.json`,
      JSON.stringify(attempt),
      {
        httpMetadata: { contentType: "application/json" },
      },
    );
  }

  async listAttempts(keyPrefix: string, limit = 20): Promise<ProcessingAttempt[]> {
    const prefix = `${keyPrefix}/${ATTEMPTS_PREFIX}`;
    // Two-phase listing: first collect all keys + their R2 upload times, then
    // GET only the top `limit` by upload time. Upload time correlates with
    // started_at strongly enough for diagnostic ordering, and bounding the
    // number of GETs by `limit` avoids an unbounded N+1 read on readings with
    // many retries.
    const candidates: Array<{ key: string; uploadedMs: number }> = [];
    let cursor: string | undefined;
    do {
      const list = await this.bucket.list({
        prefix,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const obj of list.objects) {
        if (!obj.key.endsWith(".json")) continue;
        candidates.push({
          key: obj.key,
          uploadedMs: obj.uploaded?.getTime() ?? 0,
        });
      }
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);

    // Upload time DESC, then key DESC as a deterministic tiebreak: rapid writes
    // (and the test pool's frozen clock) can share an upload timestamp, and an
    // unstable sort there would non-deterministically drop attempts from the
    // shortlist between calls. Note the key is NOT a recency proxy — attempt ids
    // are random (newAttemptId → mintReadingId) — so when more attempts than
    // `limit` share an upload timestamp, the slice keeps an arbitrary subset and
    // may drop the newest-by-started_at. That requires >limit (default 20)
    // attempts in the same R2 upload millisecond on one reading, which doesn't
    // happen in production; the tiebreak only buys deterministic ordering. If
    // exact recency under ties ever matters, embed a sortable timestamp in the
    // attempt id so the key becomes a true recency proxy.
    candidates.sort(
      (a, b) =>
        b.uploadedMs - a.uploadedMs || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0),
    );
    const top = candidates.slice(0, limit);

    const attempts: ProcessingAttempt[] = [];
    for (const { key } of top) {
      const body = await this.bucket.get(key);
      if (!body) continue;
      const json: unknown = JSON.parse(await body.text());
      const parsed = ProcessingAttemptSchema.safeParse(json);
      if (parsed.success) attempts.push(parsed.data);
    }

    // Final ordering on started_at — upload time is "close enough" for the
    // shortlist but the response should sort by the wall-clock semantics the
    // caller relies on.
    attempts.sort((a, b) =>
      a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0,
    );
    return attempts;
  }

  async listReadingObjects(keyPrefix: string): Promise<ReadingObjectInfo[]> {
    const list = await this.bucket.list({ prefix: `${keyPrefix}/`, limit: 1000 });
    return list.objects.map((obj) => ({
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded?.toISOString(),
    }));
  }

  async writeByUrlPointer(
    urlHash: string,
    pointer: ByUrlPointer,
    opts: { ifNotExists?: boolean } = {},
  ): Promise<void> {
    const key = `${BY_URL_PREFIX}${urlHash}`;
    const putOpts: R2PutOptions = {
      httpMetadata: { contentType: "application/json" },
    };
    if (opts.ifNotExists) putOpts.onlyIf = new Headers({ "If-None-Match": "*" });
    const result = await this.bucket.put(key, JSON.stringify(pointer), putOpts);
    if (opts.ifNotExists && result === null) throw new PointerExistsError(urlHash);
  }

  async readByUrlPointer(urlHash: string): Promise<ByUrlPointer | null> {
    const obj = await this.bucket.get(`${BY_URL_PREFIX}${urlHash}`);
    if (!obj) return null;
    const json: unknown = JSON.parse(await obj.text());
    return ByUrlPointerSchema.parse(json);
  }

  async readByUrlPointerWithEtag(urlHash: string): Promise<StoredByUrlPointer | null> {
    const obj = await this.bucket.get(`${BY_URL_PREFIX}${urlHash}`);
    if (!obj) return null;
    const json: unknown = JSON.parse(await obj.text());
    return {
      pointer: ByUrlPointerSchema.parse(json),
      etag: obj.etag,
    };
  }

  async replaceByUrlPointerIfCurrent(
    urlHash: string,
    expectedEtag: string,
    pointer: ByUrlPointer,
  ): Promise<boolean> {
    const result = await this.bucket.put(
      `${BY_URL_PREFIX}${urlHash}`,
      JSON.stringify(pointer),
      {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagMatches: expectedEtag },
      },
    );
    return result !== null;
  }

  async writeByIdPointer(id: string, pointer: ByUrlPointer): Promise<void> {
    await this.bucket.put(`${BY_ID_PREFIX}${id}`, JSON.stringify(pointer), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  async readByIdPointer(id: string): Promise<ByUrlPointer | null> {
    const obj = await this.bucket.get(`${BY_ID_PREFIX}${id}`);
    if (!obj) return null;
    const json: unknown = JSON.parse(await obj.text());
    return ByUrlPointerSchema.parse(json);
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

  async appendOrReplaceListIndexItem(item: ListIndexItem): Promise<void> {
    await this.mutateListIndex((items) => [
      ...items.filter((i) => i.id !== item.id),
      item,
    ]);
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

  async findListIndexItem(id: string): Promise<ListIndexItem | null> {
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
      const rebuilt = await this.rebuildListIndex();
      for (const item of rebuilt.items) {
        if (item.url === url) candidates.set(item.key_prefix, item);
      }
    }

    return this.findNewestManifestByUrl([...candidates.values()], url, await sha256Hex(url));
  }

  async listManifests(params: ListManifestsParams): Promise<ListManifestsResult> {
    let index = await this.readListIndex();
    if (!index) {
      const rebuilt = await this.rebuildListIndex();
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
        const hay = `${item.title ?? ""}\n${item.tldr ?? ""}\n${item.url}`.toLowerCase();
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
    matches.sort((a, b) => {
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

  private async rebuildListIndex(): Promise<{ items: ListIndexItem[]; complete: boolean }> {
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
