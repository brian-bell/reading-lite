import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReadingStore,
  buildKeyPrefix,
  manifestToIndexItem,
  PointerExistsError,
} from "../../../src/modules/stores/reading-store";
import type { Manifest } from "../../../src/schemas/manifest";
import type { ListIndex, ListIndexItem } from "../../../src/schemas/api";

function emptyManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_TEST",
    url: "https://example.com/a",
    url_hash: "a".repeat(64),
    status: "pending",
    content_type: "application/octet-stream",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: "2026-04-26T20:00:00.000Z",
    updated_at: "2026-04-26T20:00:00.000Z",
    ...overrides,
  };
}

function indexItem(overrides: Partial<ListIndexItem> = {}): ListIndexItem {
  return {
    id: "rd_TEST",
    key_prefix: "readings/2026/04/26T200000Z-rd_TEST",
    url: "https://example.com/a",
    status: "ready",
    created_at: "2026-04-26T20:00:00.000Z",
    ...overrides,
  };
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) {
    await env.READINGS_BUCKET.delete(obj.key);
  }
}

beforeEach(clearBucket);
afterEach(clearBucket);

describe("buildKeyPrefix", () => {
  it("produces sortable timestamped prefixes", () => {
    const a = buildKeyPrefix("rd_a", "2026-04-26T20:00:00.000Z");
    const b = buildKeyPrefix("rd_b", "2026-04-26T20:00:01.000Z");
    expect(a).toMatch(/^readings\/2026\/04\/26T200000Z-rd_a$/);
    expect(b).toMatch(/^readings\/2026\/04\/26T200001Z-rd_b$/);
    expect(a < b).toBe(true);
  });
});

describe("ReadingStore — manifests", () => {
  it("round-trips a manifest", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const m = emptyManifest({ id: "rd_X", title: "X" });
    const prefix = buildKeyPrefix(m.id, m.created_at);
    await store.writeManifest(prefix, m);
    const read = await store.readManifest(prefix);
    expect(read).toEqual(m);
  });

  it("returns null when manifest is missing", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const prefix = buildKeyPrefix("rd_missing", "2026-04-26T20:00:00.000Z");
    expect(await store.readManifest(prefix)).toBeNull();
  });

  it("rejects a manifest that fails schema validation", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const m = emptyManifest({ id: "rd_X" });
    const prefix = buildKeyPrefix(m.id, m.created_at);
    await env.READINGS_BUCKET.put(`${prefix}/manifest.json`, JSON.stringify({ ...m, status: "weird" }));
    await expect(store.readManifest(prefix)).rejects.toThrow();
  });
});

describe("ReadingStore — raw + extracted bytes", () => {
  it("round-trips raw bytes with content type", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const prefix = buildKeyPrefix("rd_X", "2026-04-26T20:00:00.000Z");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.writeRaw(prefix, "html", bytes, "text/html; charset=utf-8");
    const read = await store.readRaw(prefix, "html");
    expect(read).not.toBeNull();
    expect(new Uint8Array(await read!.arrayBuffer())).toEqual(bytes);
    expect(read!.contentType).toBe("text/html; charset=utf-8");
  });

  it("round-trips extracted markdown", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const prefix = buildKeyPrefix("rd_X", "2026-04-26T20:00:00.000Z");
    await store.writeExtracted(prefix, "# Hello\n\nworld");
    const read = await store.readExtracted(prefix);
    expect(read).not.toBeNull();
    expect(await read!.text()).toBe("# Hello\n\nworld");
  });

  it("returns null for missing raw / extracted", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const prefix = buildKeyPrefix("rd_X", "2026-04-26T20:00:00.000Z");
    expect(await store.readRaw(prefix, "html")).toBeNull();
    expect(await store.readExtracted(prefix)).toBeNull();
  });
});

describe("ReadingStore — by-url pointer", () => {
  it("round-trips a by-url pointer", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const hash = "a".repeat(64);
    const prefix = buildKeyPrefix("rd_X", "2026-04-26T20:00:00.000Z");
    await store.writeByUrlPointer(hash, { id: "rd_X", key_prefix: prefix });
    const read = await store.readByUrlPointer(hash);
    expect(read).toEqual({ id: "rd_X", key_prefix: prefix });
  });

  it("returns null when pointer is missing", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    expect(await store.readByUrlPointer("0".repeat(64))).toBeNull();
  });

  it("ifNotExists=true throws PointerExistsError on duplicate write", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const hash = "a".repeat(64);
    const prefix = buildKeyPrefix("rd_X", "2026-04-26T20:00:00.000Z");
    await store.writeByUrlPointer(hash, { id: "rd_X", key_prefix: prefix }, { ifNotExists: true });
    await expect(
      store.writeByUrlPointer(hash, { id: "rd_Y", key_prefix: prefix }, { ifNotExists: true }),
    ).rejects.toBeInstanceOf(PointerExistsError);
    // The original pointer is preserved.
    const read = await store.readByUrlPointer(hash);
    expect(read?.id).toBe("rd_X");
  });
});

describe("ReadingStore — by-id pointer", () => {
  it("round-trips a by-id pointer", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const prefix = buildKeyPrefix("rd_X", "2026-04-26T20:00:00.000Z");
    await store.writeByIdPointer("rd_X", { id: "rd_X", key_prefix: prefix });
    expect(await store.readByIdPointer("rd_X")).toEqual({ id: "rd_X", key_prefix: prefix });
  });

  it("returns null when by-id pointer is missing", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    expect(await store.readByIdPointer("rd_missing")).toBeNull();
  });
});

describe("manifestToIndexItem", () => {
  it("carries updated_at when set on the manifest", () => {
    const m = emptyManifest({
      status: "ready",
      updated_at: "2026-04-26T20:00:05.000Z",
    });
    const item = manifestToIndexItem(m, "readings/2026/04/26T200000Z-rd_TEST");
    expect(item.updated_at).toBe("2026-04-26T20:00:05.000Z");
  });
});

describe("ReadingStore — list index round-trip", () => {
  it("readListIndex returns null when missing", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    expect(await store.readListIndex()).toBeNull();
  });

  it("round-trips an empty index", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const empty: ListIndex = { version: 1, items: [] };
    await store.writeListIndex(empty);
    expect(await store.readListIndex()).toEqual(empty);
  });

  it("round-trips a populated index", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const idx: ListIndex = {
      version: 1,
      items: [indexItem({ id: "rd_a" }), indexItem({ id: "rd_b" })],
    };
    await store.writeListIndex(idx);
    expect(await store.readListIndex()).toEqual(idx);
  });
});

describe("ReadingStore — appendOrReplaceListIndexItem", () => {
  it("creates an index when none exists and appends the item", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    await store.appendOrReplaceListIndexItem(indexItem({ id: "rd_a" }));
    const idx = await store.readListIndex();
    expect(idx).not.toBeNull();
    expect(idx!.items.map((i) => i.id)).toEqual(["rd_a"]);
  });

  it("replaces an existing item with the same id", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    await store.appendOrReplaceListIndexItem(
      indexItem({ id: "rd_a", status: "pending", title: undefined }),
    );
    await store.appendOrReplaceListIndexItem(
      indexItem({ id: "rd_a", status: "ready", title: "After" }),
    );
    const idx = await store.readListIndex();
    expect(idx!.items).toHaveLength(1);
    expect(idx!.items[0]!.status).toBe("ready");
    expect(idx!.items[0]!.title).toBe("After");
  });

  it("appends multiple distinct items", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    await store.appendOrReplaceListIndexItem(indexItem({ id: "rd_a" }));
    await store.appendOrReplaceListIndexItem(indexItem({ id: "rd_b" }));
    await store.appendOrReplaceListIndexItem(indexItem({ id: "rd_c" }));
    const idx = await store.readListIndex();
    expect(idx!.items.map((i) => i.id).sort()).toEqual(["rd_a", "rd_b", "rd_c"]);
  });
});

describe("ReadingStore — listManifests", () => {
  async function seedIndex(store: ReadingStore, items: ListIndexItem[]) {
    await store.writeListIndex({ version: 1, items });
  }

  it("returns items newest-first by created_at", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    await seedIndex(store, [
      indexItem({ id: "rd_a", created_at: "2026-04-26T20:00:00.000Z" }),
      indexItem({ id: "rd_b", created_at: "2026-04-26T20:00:01.000Z" }),
      indexItem({ id: "rd_c", created_at: "2026-04-26T20:00:02.000Z" }),
    ]);
    const page = await store.listManifests({ offset: 0, limit: 10 });
    expect(page.readings.map((r) => r.id)).toEqual(["rd_c", "rd_b", "rd_a"]);
    expect(page.total_filtered).toBe(3);
  });

  it("paginates with offset+limit; total_filtered is the unpaged count", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const items: ListIndexItem[] = [];
    for (let i = 0; i < 5; i++) {
      items.push(indexItem({ id: `rd_${i}`, created_at: `2026-04-26T20:00:0${i}.000Z` }));
    }
    await seedIndex(store, items);
    const page1 = await store.listManifests({ offset: 0, limit: 2 });
    expect(page1.readings.map((r) => r.id)).toEqual(["rd_4", "rd_3"]);
    expect(page1.total_filtered).toBe(5);
    const page2 = await store.listManifests({ offset: 2, limit: 2 });
    expect(page2.readings.map((r) => r.id)).toEqual(["rd_2", "rd_1"]);
    const page3 = await store.listManifests({ offset: 4, limit: 2 });
    expect(page3.readings.map((r) => r.id)).toEqual(["rd_0"]);
  });

  it("filters by q across title, tldr, and url (case-insensitive)", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    await seedIndex(store, [
      indexItem({ id: "rd_a", title: "Rust async", url: "https://example.com/rust" }),
      indexItem({ id: "rd_b", title: "Go concurrency", tldr: "Goroutines and channels" }),
      indexItem({ id: "rd_c", title: "Python async", tldr: "asyncio overview", url: "https://example.com/py" }),
    ]);

    const byTitle = await store.listManifests({ offset: 0, limit: 10, q: "RUST" });
    expect(byTitle.readings.map((r) => r.id)).toEqual(["rd_a"]);

    const byTldr = await store.listManifests({ offset: 0, limit: 10, q: "goroutines" });
    expect(byTldr.readings.map((r) => r.id)).toEqual(["rd_b"]);

    const byUrl = await store.listManifests({ offset: 0, limit: 10, q: "/py" });
    expect(byUrl.readings.map((r) => r.id)).toEqual(["rd_c"]);

    const noMatch = await store.listManifests({ offset: 0, limit: 10, q: "elixir" });
    expect(noMatch.readings).toEqual([]);
    expect(noMatch.total_filtered).toBe(0);
  });

  it("filters by tag (exact, case-insensitive)", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    await seedIndex(store, [
      indexItem({ id: "rd_a", tags: ["AI", "infra"] }),
      indexItem({ id: "rd_b", tags: ["ai"] }),
      indexItem({ id: "rd_c", tags: ["ml"] }),
      indexItem({ id: "rd_d", tags: undefined }),
    ]);
    const page = await store.listManifests({ offset: 0, limit: 10, tag: "ai" });
    expect(page.readings.map((r) => r.id).sort()).toEqual(["rd_a", "rd_b"]);
    expect(page.total_filtered).toBe(2);
  });

  it("ANDs q and tag together", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    await seedIndex(store, [
      indexItem({ id: "rd_a", title: "Rust async", tags: ["rust"] }),
      indexItem({ id: "rd_b", title: "Rust web", tags: ["web"] }),
      indexItem({ id: "rd_c", title: "Go async", tags: ["rust"] }),
    ]);
    const page = await store.listManifests({ offset: 0, limit: 10, q: "rust", tag: "rust" });
    expect(page.readings.map((r) => r.id)).toEqual(["rd_a"]);
  });

  it("returns an empty page when index is missing AND no manifests exist", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const page = await store.listManifests({ offset: 0, limit: 10 });
    expect(page.readings).toEqual([]);
    expect(page.total_filtered).toBe(0);
  });

  it("falls back to scan-and-rebuild when index missing but manifests exist; persists the rebuilt index", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const ids = ["rd_a", "rd_b", "rd_c"];
    const times = [
      "2026-04-26T20:00:00.000Z",
      "2026-04-26T20:00:01.000Z",
      "2026-04-26T20:00:02.000Z",
    ];
    for (let i = 0; i < ids.length; i++) {
      const m = emptyManifest({
        id: ids[i]!,
        status: "ready",
        title: `T-${ids[i]!}`,
        tldr: "x",
        tags: ["t"],
        created_at: times[i]!,
        updated_at: times[i]!,
      });
      await store.writeManifest(buildKeyPrefix(m.id, m.created_at), m);
    }
    expect(await store.readListIndex()).toBeNull();

    const page = await store.listManifests({ offset: 0, limit: 10 });
    expect(page.readings.map((r) => r.id)).toEqual(["rd_c", "rd_b", "rd_a"]);

    const idx = await store.readListIndex();
    expect(idx).not.toBeNull();
    expect(idx!.items.map((i) => i.id).sort()).toEqual(["rd_a", "rd_b", "rd_c"]);
  });

  it("does not persist a rebuilt index when R2 list is truncated", async () => {
    // Stub the bucket so list() reports truncated:true. The rebuild path should
    // still serve the partial result for this request, but must NOT write the
    // partial back to index/list.json (otherwise a single truncated rebuild
    // would permanently shadow a >1000-manifest bucket with an incomplete
    // index).
    const m = emptyManifest({
      id: "rd_a",
      status: "ready",
      title: "T",
      created_at: "2026-04-26T20:00:00.000Z",
    });
    const keyPrefix = buildKeyPrefix(m.id, m.created_at);
    const manifestKey = `${keyPrefix}/manifest.json`;
    const manifestBody = JSON.stringify(m);

    const puts: Array<{ key: string }> = [];
    const bucket = {
      get: async (key: string) => {
        if (key === "index/list.json") return null;
        if (key === manifestKey) {
          return {
            text: async () => manifestBody,
          } as unknown as R2ObjectBody;
        }
        return null;
      },
      put: async (key: string) => {
        puts.push({ key });
      },
      list: async () => ({
        objects: [{ key: manifestKey }],
        truncated: true,
      }),
    } as unknown as R2Bucket;

    const store = new ReadingStore(bucket);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = await store.listManifests({ offset: 0, limit: 10 });
    expect(page.readings.map((r) => r.id)).toEqual(["rd_a"]);
    expect(puts.find((p) => p.key === "index/list.json")).toBeUndefined();
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});
