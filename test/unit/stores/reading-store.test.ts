import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ReadingStore,
  buildKeyPrefix,
  PointerExistsError,
} from "../../../src/modules/stores/reading-store";
import type { Manifest } from "../../../src/schemas/manifest";

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

describe("ReadingStore — listManifests", () => {
  it("returns manifests newest-first", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const ids = ["rd_a", "rd_b", "rd_c"];
    const times = [
      "2026-04-26T20:00:00.000Z",
      "2026-04-26T20:00:01.000Z",
      "2026-04-26T20:00:02.000Z",
    ];
    for (let i = 0; i < ids.length; i++) {
      const m = emptyManifest({ id: ids[i]!, created_at: times[i]!, updated_at: times[i]! });
      await store.writeManifest(buildKeyPrefix(m.id, m.created_at), m);
    }
    const page = await store.listManifests({ limit: 10 });
    expect(page.items.map((m) => m.id)).toEqual(["rd_c", "rd_b", "rd_a"]);
    expect(page.next_cursor).toBeUndefined();
  });

  it("paginates with limit + cursor", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    for (let i = 0; i < 5; i++) {
      const time = `2026-04-26T20:00:0${i}.000Z`;
      const m = emptyManifest({ id: `rd_${i}`, created_at: time, updated_at: time });
      await store.writeManifest(buildKeyPrefix(m.id, m.created_at), m);
    }
    const page1 = await store.listManifests({ limit: 2 });
    expect(page1.items.map((m) => m.id)).toEqual(["rd_4", "rd_3"]);
    expect(page1.next_cursor).toBeDefined();
    const page2 = await store.listManifests({ limit: 2, cursor: page1.next_cursor });
    expect(page2.items.map((m) => m.id)).toEqual(["rd_2", "rd_1"]);
    const page3 = await store.listManifests({ limit: 2, cursor: page2.next_cursor });
    expect(page3.items.map((m) => m.id)).toEqual(["rd_0"]);
    expect(page3.next_cursor).toBeUndefined();
  });
});
