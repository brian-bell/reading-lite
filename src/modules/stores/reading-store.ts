import {
  ManifestSchema,
  ByUrlPointerSchema,
  type Manifest,
  type ByUrlPointer,
} from "../../schemas/manifest";
import {
  ListIndexSchema,
  type ListIndex,
  type ListIndexItem,
} from "../../schemas/api";

export class PointerExistsError extends Error {
  constructor(public readonly urlHash: string) {
    super(`by-url pointer already exists for hash ${urlHash}`);
    this.name = "PointerExistsError";
  }
}

const MANIFEST_FILE = "manifest.json";
const EXTRACTED_FILE = "extracted.md";
const RAW_PREFIX = "raw.";
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
  return item;
}

export class ReadingStore {
  constructor(private readonly bucket: R2Bucket) {}

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

  async writeByUrlPointer(
    urlHash: string,
    pointer: ByUrlPointer,
    opts: { ifNotExists?: boolean } = {},
  ): Promise<void> {
    const key = `${BY_URL_PREFIX}${urlHash}`;
    if (opts.ifNotExists) {
      const existing = await this.bucket.head(key);
      if (existing) throw new PointerExistsError(urlHash);
    }
    await this.bucket.put(key, JSON.stringify(pointer), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  async readByUrlPointer(urlHash: string): Promise<ByUrlPointer | null> {
    const obj = await this.bucket.get(`${BY_URL_PREFIX}${urlHash}`);
    if (!obj) return null;
    const json: unknown = JSON.parse(await obj.text());
    return ByUrlPointerSchema.parse(json);
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
    const existing = (await this.readListIndex()) ?? { version: 1 as const, items: [] };
    const items = existing.items.filter((i) => i.id !== item.id);
    items.push(item);
    await this.writeListIndex({ version: 1, items });
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

  private async rebuildListIndex(): Promise<{ items: ListIndexItem[]; complete: boolean }> {
    // Personal-scale fallback: scan readings/ for manifests, parse each, and
    // synthesise an index. Used when index/list.json is missing (cold cache or
    // pre-migration data); the result is persisted by the caller (only when
    // complete) so subsequent reads are O(index-size).
    const list = await this.bucket.list({ prefix: READINGS_PREFIX, limit: 1000 });
    const manifestKeys = list.objects
      .map((o) => o.key)
      .filter((k) => k.endsWith(`/${MANIFEST_FILE}`));
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
    return { items, complete: !list.truncated };
  }
}
