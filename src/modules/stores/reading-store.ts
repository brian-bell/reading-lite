import {
  ManifestSchema,
  ByUrlPointerSchema,
  type Manifest,
  type ByUrlPointer,
} from "../../schemas/manifest";

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
  items: Manifest[];
  next_cursor?: string;
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

  async listManifests({
    cursor,
    limit,
  }: {
    cursor?: string;
    limit: number;
  }): Promise<ListManifestsResult> {
    // Personal-scale pagination: list all readings/ keys (R2 returns up to 1000),
    // filter to manifests, reverse for newest-first, then page in-memory by offset.
    const list = await this.bucket.list({ prefix: READINGS_PREFIX, limit: 1000 });
    const manifestKeys = list.objects
      .map((o) => o.key)
      .filter((k) => k.endsWith(`/${MANIFEST_FILE}`));
    manifestKeys.reverse();
    const offset = cursor ? parseInt(cursor, 10) : 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`invalid cursor: ${cursor}`);
    }
    const slice = manifestKeys.slice(offset, offset + limit);
    const items: Manifest[] = [];
    for (const key of slice) {
      const obj = await this.bucket.get(key);
      if (!obj) continue;
      const json: unknown = JSON.parse(await obj.text());
      const parsed = ManifestSchema.safeParse(json);
      if (parsed.success) items.push(parsed.data);
    }
    const nextOffset = offset + limit;
    return {
      items,
      next_cursor: nextOffset < manifestKeys.length ? String(nextOffset) : undefined,
    };
  }
}
