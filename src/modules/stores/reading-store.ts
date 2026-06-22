import {
  ManifestSchema,
  ProcessingAttemptSchema,
  ByUrlPointerSchema,
  type Manifest,
  type ProcessingAttempt,
  type ByUrlPointer,
} from "../../schemas/manifest";
import type { ListIndex, ListIndexItem } from "../../schemas/api";
import {
  ListIndexStore,
  MANIFEST_FILE,
  READINGS_PREFIX,
  manifestToIndexItem,
  type ListIndexCasDeps,
  type ListManifestsParams,
  type ListManifestsResult,
  type FindManifestByUrlOptions,
} from "./list-index";

// Re-exported so existing call sites keep importing the list-index surface from
// ReadingStore while the implementation lives in list-index.ts.
export {
  manifestToIndexItem,
  type ListIndexCasDeps,
  type ListManifestsParams,
  type ListManifestsResult,
  type FindManifestByUrlOptions,
};

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

export interface StoredManifest {
  manifest: Manifest;
  etag: string;
}

// MANIFEST_FILE and READINGS_PREFIX are owned by list-index.ts (the manifest
// scan + rebuild lives there) and imported above to keep the R2 layout
// single-homed.
const EXTRACTED_FILE = "extracted.md";
const RAW_PREFIX = "raw.";
const ATTEMPTS_PREFIX = "attempts/";
const BY_URL_PREFIX = "index/by-url/";
const BY_ID_PREFIX = "index/by-id/";

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

export interface ReadingObjectInfo {
  key: string;
  size: number;
  uploaded?: string;
}

export class ReadingStore {
  // The list-index subsystem (index/list.json CAS, q/tag search, URL-ownership
  // ranking, rebuild) lives in its own module; ReadingStore composes one and
  // delegates its public index methods so existing call sites are unchanged.
  private readonly listIndex: ListIndexStore;

  constructor(
    private readonly bucket: R2Bucket,
    casDeps: ListIndexCasDeps = {},
  ) {
    this.listIndex = new ListIndexStore(bucket, casDeps);
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

  async readManifestWithEtag(keyPrefix: string): Promise<StoredManifest | null> {
    const obj = await this.bucket.get(`${keyPrefix}/${MANIFEST_FILE}`);
    if (!obj) return null;
    const json: unknown = JSON.parse(await obj.text());
    return {
      manifest: ManifestSchema.parse(json),
      etag: obj.etag,
    };
  }

  async replaceManifestIfCurrent(
    keyPrefix: string,
    expectedEtag: string,
    manifest: Manifest,
  ): Promise<boolean> {
    const written = await this.bucket.put(
      `${keyPrefix}/${MANIFEST_FILE}`,
      JSON.stringify(manifest),
      {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagMatches: expectedEtag },
      },
    );
    return written !== null;
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

  // Resolve a reading id to its manifest via the by-id pointer hop. Returns
  // null when either the pointer or the manifest it points at is absent, so
  // callers branch once instead of repeating the two-read 404 dance.
  async loadReadingById(
    id: string,
  ): Promise<{ keyPrefix: string; manifest: Manifest } | null> {
    const ptr = await this.readByIdPointer(id);
    if (!ptr) return null;
    const manifest = await this.readManifest(ptr.key_prefix);
    if (!manifest) return null;
    return { keyPrefix: ptr.key_prefix, manifest };
  }

  // The list-index methods below delegate to the composed ListIndexStore. They
  // preserve the existing ReadingStore call surface (process-reading.ts,
  // attempt-activation.ts, reading-visibility.ts, router.ts, reading-claim.ts)
  // while the implementation — CAS loop, ownership ranking, search, rebuild —
  // lives in list-index.ts.
  async readListIndex(): Promise<ListIndex | null> {
    return this.listIndex.readListIndex();
  }

  async writeListIndex(index: ListIndex): Promise<void> {
    await this.listIndex.writeListIndex(index);
  }

  async appendOrReplaceListIndexItem(item: ListIndexItem): Promise<void> {
    await this.listIndex.appendOrReplace(item);
  }

  async removeListIndexItem(id: string): Promise<void> {
    await this.listIndex.remove(id);
  }

  async removeListIndexItemIf(
    id: string,
    predicate: (item: ListIndexItem) => boolean,
  ): Promise<void> {
    await this.listIndex.removeIf(id, predicate);
  }

  async findListIndexItem(id: string): Promise<ListIndexItem | null> {
    return this.listIndex.find(id);
  }

  async findManifestByUrl(
    url: string,
    opts: FindManifestByUrlOptions = {},
  ): Promise<{ keyPrefix: string; manifest: Manifest } | null> {
    return this.listIndex.findManifestByUrl(url, opts);
  }

  async listManifests(params: ListManifestsParams): Promise<ListManifestsResult> {
    return this.listIndex.list(params);
  }
}
