import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReadingStore,
  buildKeyPrefix,
  manifestToIndexItem,
  PointerExistsError,
} from "../../../src/modules/stores/reading-store";
import type { Manifest, ProcessingAttempt } from "../../../src/schemas/manifest";
import type { ListIndex, ListIndexItem } from "../../../src/schemas/api";
import { sha256Hex } from "../../../src/services";

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

function attempt(overrides: Partial<ProcessingAttempt> = {}): ProcessingAttempt {
  return {
    id: "at_TEST",
    trigger: "submit",
    status: "running",
    stage: "queued",
    started_at: "2026-04-26T20:00:00.000Z",
    reading_id: "rd_TEST",
    url: "https://example.com/a",
    url_hash: "a".repeat(64),
    key_prefix: "readings/2026/04/26T200000Z-rd_TEST",
    events: [{ stage: "queued", status: "started", at: "2026-04-26T20:00:00.000Z" }],
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

  it("ifNotExists=true allows only one concurrent writer to claim a by-url pointer", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const hash = "b".repeat(64);
    const prefixA = buildKeyPrefix("rd_A", "2026-04-26T20:00:00.000Z");
    const prefixB = buildKeyPrefix("rd_B", "2026-04-26T20:00:01.000Z");

    const results = await Promise.allSettled([
      store.writeByUrlPointer(hash, { id: "rd_A", key_prefix: prefixA }, { ifNotExists: true }),
      store.writeByUrlPointer(hash, { id: "rd_B", key_prefix: prefixB }, { ifNotExists: true }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(PointerExistsError);
    const read = await store.readByUrlPointer(hash);
    expect(read?.id === "rd_A" || read?.id === "rd_B").toBe(true);
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

describe("ReadingStore — loadReadingById", () => {
  it("returns null when the by-id pointer is missing", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    expect(await store.loadReadingById("rd_missing")).toBeNull();
  });

  it("returns null when the pointer exists but the manifest is missing", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const prefix = buildKeyPrefix("rd_X", "2026-04-26T20:00:00.000Z");
    await store.writeByIdPointer("rd_X", { id: "rd_X", key_prefix: prefix });
    expect(await store.loadReadingById("rd_X")).toBeNull();
  });

  it("returns the key prefix and manifest when both are present", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const m = emptyManifest({ id: "rd_X", title: "X" });
    const prefix = buildKeyPrefix(m.id, m.created_at);
    await store.writeManifest(prefix, m);
    await store.writeByIdPointer(m.id, { id: m.id, key_prefix: prefix });
    expect(await store.loadReadingById(m.id)).toEqual({ keyPrefix: prefix, manifest: m });
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

  it("carries attempt summaries", () => {
    const active = {
      id: "at_1",
      trigger: "reprocess" as const,
      status: "running" as const,
      stage: "fetch_source" as const,
      started_at: "2026-04-26T20:00:05.000Z",
    };
    const last = {
      id: "at_0",
      trigger: "submit" as const,
      status: "succeeded" as const,
      stage: "write_indexes" as const,
      started_at: "2026-04-26T20:00:00.000Z",
      finished_at: "2026-04-26T20:00:04.000Z",
    };
    const m = emptyManifest({
      status: "ready",
      active_attempt: active,
      last_attempt: last,
    });
    const item = manifestToIndexItem(m, "readings/2026/04/26T200000Z-rd_TEST");
    expect(item.active_attempt).toEqual(active);
    expect(item.last_attempt).toEqual(last);
  });
});

describe("ReadingStore — attempts and object diagnostics", () => {
  it("round-trips attempts newest-first", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const prefix = "readings/2026/04/26T200000Z-rd_TEST";
    await store.writeAttempt(prefix, attempt({ id: "at_old" }));
    await store.writeAttempt(
      prefix,
      attempt({
        id: "at_new",
        started_at: "2026-04-26T20:00:10.000Z",
        events: [{ stage: "queued", status: "started", at: "2026-04-26T20:00:10.000Z" }],
      }),
    );

    const attempts = await store.listAttempts(prefix);
    expect(attempts.map((a) => a.id)).toEqual(["at_new", "at_old"]);
  });

  it("reads every attempt object before applying the newest limit", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const prefix = "readings/2026/04/26T200000Z-rd_TEST";
    for (let i = 0; i < 21; i++) {
      const second = String(i).padStart(2, "0");
      await store.writeAttempt(
        prefix,
        attempt({
          id: `at_${second}`,
          started_at: `2026-04-26T20:00:${second}.000Z`,
          events: [{ stage: "queued", status: "started", at: `2026-04-26T20:00:${second}.000Z` }],
        }),
      );
    }
    await store.writeAttempt(
      prefix,
      attempt({
        id: "at_zz",
        started_at: "2026-04-26T20:01:00.000Z",
        events: [{ stage: "queued", status: "started", at: "2026-04-26T20:01:00.000Z" }],
      }),
    );

    // `at_zz` is deliberately both the newest by started_at AND the
    // lexically-largest key. Under the test pool's tied upload timestamps the
    // shortlist is sliced by key DESC, so this asserts deterministic selection
    // — NOT that recency-by-started_at is preserved when keys tie (it isn't;
    // attempt ids are random — see the listAttempts sort comment).
    const attempts = await store.listAttempts(prefix, 1);
    expect(attempts.map((a) => a.id)).toEqual(["at_zz"]);
  });

  it("bounds bucket.get calls by the limit (does not read every attempt object)", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const prefix = "readings/2026/04/26T200000Z-rd_TEST";
    for (let i = 0; i < 5; i++) {
      const second = String(i).padStart(2, "0");
      await store.writeAttempt(
        prefix,
        attempt({
          id: `at_${second}`,
          started_at: `2026-04-26T20:00:${second}.000Z`,
          events: [{ stage: "queued", status: "started", at: `2026-04-26T20:00:${second}.000Z` }],
        }),
      );
    }

    const getSpy = vi.spyOn(env.READINGS_BUCKET, "get");
    const attempts = await store.listAttempts(prefix, 2);
    expect(attempts).toHaveLength(2);
    expect(getSpy).toHaveBeenCalledTimes(2);
    getSpy.mockRestore();
  });

  it("lists reading objects for diagnostics", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const prefix = "readings/2026/04/26T200000Z-rd_TEST";
    await store.writeRaw(prefix, "html", new Uint8Array([1, 2]), "text/html");
    await store.writeExtracted(prefix, "# x");

    const objects = await store.listReadingObjects(prefix);
    expect(objects.map((o) => o.key).sort()).toEqual([
      `${prefix}/extracted.md`,
      `${prefix}/raw.html`,
    ]);
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

  it("does not create an empty index when removing from a cold bucket", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);

    await store.removeListIndexItem("rd_missing");

    await expect(store.readListIndex()).resolves.toBeNull();
  });

  it("removes an item only when the predicate matches", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    await store.appendOrReplaceListIndexItem(
      indexItem({ id: "rd_a", status: "pending" }),
    );

    await store.removeListIndexItemIf("rd_a", (item) => item.status === "ready");
    await expect(store.readListIndex()).resolves.toMatchObject({
      items: [{ id: "rd_a", status: "pending" }],
    });

    await store.removeListIndexItemIf("rd_a", (item) => item.status === "pending");
    await expect(store.readListIndex()).resolves.toMatchObject({ items: [] });
  });

  it("retries and merges a concurrent write instead of clobbering it", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET, { sleep: async () => {} });
    await store.appendOrReplaceListIndexItem(indexItem({ id: "rd_a" }));

    const realPut = env.READINGS_BUCKET.put.bind(env.READINGS_BUCKET);
    let injected = false;
    const spy = vi
      .spyOn(env.READINGS_BUCKET, "put")
      .mockImplementation((async (key: string, value: unknown, options?: unknown) => {
        // On our first conditional write, simulate a different writer landing
        // rd_b between our read and our put, then fail our precondition.
        if (key === "index/list.json" && !injected) {
          injected = true;
          const cur = await env.READINGS_BUCKET.get("index/list.json");
          const parsed = JSON.parse(await cur!.text()) as ListIndex;
          parsed.items.push(indexItem({ id: "rd_b" }));
          await realPut("index/list.json", JSON.stringify(parsed), {
            httpMetadata: { contentType: "application/json" },
          });
          return null;
        }
        return realPut(key, value as ArrayBuffer, options as R2PutOptions);
      }) as typeof env.READINGS_BUCKET.put);

    await store.appendOrReplaceListIndexItem(indexItem({ id: "rd_c" }));
    spy.mockRestore();

    const idx = await store.readListIndex();
    expect(idx!.items.map((i) => i.id).sort()).toEqual(["rd_a", "rd_b", "rd_c"]);
  });

  it("throws after exhausting CAS attempts under persistent contention", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET, {
      maxAttempts: 3,
      sleep: async () => {},
    });
    await store.appendOrReplaceListIndexItem(indexItem({ id: "rd_a" }));

    const spy = vi
      .spyOn(env.READINGS_BUCKET, "put")
      .mockResolvedValue(null as unknown as R2Object);
    await expect(
      store.appendOrReplaceListIndexItem(indexItem({ id: "rd_b" })),
    ).rejects.toThrow(/list index/i);
    spy.mockRestore();
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

  it("paginates scan-and-rebuild before persisting the rebuilt index", async () => {
    const first = emptyManifest({
      id: "rd_a",
      status: "ready",
      title: "A",
      created_at: "2026-04-26T20:00:00.000Z",
    });
    const second = emptyManifest({
      id: "rd_b",
      status: "ready",
      title: "B",
      created_at: "2026-04-26T20:00:01.000Z",
    });
    const firstKey = `${buildKeyPrefix(first.id, first.created_at)}/manifest.json`;
    const secondKey = `${buildKeyPrefix(second.id, second.created_at)}/manifest.json`;
    const puts: Array<{ key: string; value: string }> = [];
    const listCalls: Array<string | undefined> = [];
    const bucket = {
      get: async (key: string) => {
        if (key === "index/list.json") return null;
        if (key === firstKey) {
          return { text: async () => JSON.stringify(first) } as unknown as R2ObjectBody;
        }
        if (key === secondKey) {
          return { text: async () => JSON.stringify(second) } as unknown as R2ObjectBody;
        }
        return null;
      },
      put: async (key: string, value: string) => {
        puts.push({ key, value });
      },
      list: async (opts?: R2ListOptions) => {
        listCalls.push(opts?.cursor);
        if (!opts?.cursor) {
          return {
            objects: [{ key: firstKey }],
            truncated: true,
            cursor: "next-page",
          };
        }
        return {
          objects: [{ key: secondKey }],
          truncated: false,
        };
      },
    } as unknown as R2Bucket;

    const store = new ReadingStore(bucket);
    const page = await store.listManifests({ offset: 0, limit: 10 });

    expect(page.readings.map((r) => r.id)).toEqual(["rd_b", "rd_a"]);
    expect(listCalls).toEqual([undefined, "next-page"]);
    const indexWrite = puts.find((p) => p.key === "index/list.json");
    expect(indexWrite).toBeDefined();
    expect(JSON.parse(indexWrite!.value)).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: "rd_a" }),
        expect.objectContaining({ id: "rd_b" }),
      ]),
    });
  });

  it("ignores stale exact-url index rows whose manifest belongs to another URL", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const requestedUrl = "https://example.com/requested";
    const other = emptyManifest({
      id: "rd_other",
      url: "https://example.com/other",
      url_hash: "b".repeat(64),
      status: "ready",
      created_at: "2026-04-26T20:00:00.000Z",
      updated_at: "2026-04-26T20:00:00.000Z",
    });
    const otherPrefix = buildKeyPrefix(other.id, other.created_at);
    await store.writeManifest(otherPrefix, other);
    await store.appendOrReplaceListIndexItem({
      ...manifestToIndexItem(other, otherPrefix),
      url: requestedUrl,
    });

    await expect(store.findManifestByUrl(requestedUrl)).resolves.toBeNull();
  });

  it("does not scan manifests when the list index has no rows for the URL", async () => {
    const requestedUrl = "https://example.com/requested";
    const listIndex: ListIndex = {
      version: 1,
      items: [
        indexItem({
          id: "rd_other",
          key_prefix: "readings/2026/04/26T200000Z-rd_other",
          url: "https://example.com/other",
        }),
      ],
    };
    let listCalls = 0;
    const bucket = {
      get: async (key: string) => {
        if (key === "index/list.json") {
          return { text: async () => JSON.stringify(listIndex) } as unknown as R2ObjectBody;
        }
        throw new Error(`unexpected object read: ${key}`);
      },
      list: async () => {
        listCalls++;
        return { objects: [], truncated: false };
      },
    } as unknown as R2Bucket;

    const store = new ReadingStore(bucket);

    await expect(store.findManifestByUrl(requestedUrl)).resolves.toBeNull();
    expect(listCalls).toBe(0);
  });

  it("prefers a ready owner over a newer failed duplicate of the same URL", async () => {
    // Damaged-pointer repair (and legacy adoption) resolve URL ownership through
    // findManifestByUrl. When a URL has both a ready reading and a *newer* failed
    // duplicate (the recurring "failed orphan-dup" corpus state), the ready copy
    // owns the URL and must win — ranking purely by recency would adopt the
    // failed copy and orphan the ready summary by URL.
    const store = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/dup";
    const urlHash = await sha256Hex(url);

    const ready = emptyManifest({
      id: "rd_ready",
      url,
      url_hash: urlHash,
      status: "ready",
      created_at: "2026-04-26T20:00:00.000Z",
      updated_at: "2026-04-26T20:00:00.000Z",
    });
    const failed = emptyManifest({
      id: "rd_failed",
      url,
      url_hash: urlHash,
      status: "failed",
      created_at: "2026-04-26T20:05:00.000Z",
      updated_at: "2026-04-26T20:05:00.000Z",
    });
    await store.writeManifest(buildKeyPrefix(ready.id, ready.created_at), ready);
    await store.writeManifest(buildKeyPrefix(failed.id, failed.created_at), failed);

    const found = await store.findManifestByUrl(url);
    expect(found?.manifest.id).toBe("rd_ready");
  });

  it("prefers a ready owner over a newer pending duplicate of the same URL", async () => {
    // The middle rank (pending) must also lose to ready: an in-flight reprocess
    // (newer, pending) must not steal URL ownership from the completed ready copy.
    const store = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/dup-pending";
    const urlHash = await sha256Hex(url);

    const ready = emptyManifest({
      id: "rd_ready",
      url,
      url_hash: urlHash,
      status: "ready",
      created_at: "2026-04-26T20:00:00.000Z",
      updated_at: "2026-04-26T20:00:00.000Z",
    });
    const pending = emptyManifest({
      id: "rd_pending",
      url,
      url_hash: urlHash,
      status: "pending",
      created_at: "2026-04-26T20:05:00.000Z",
      updated_at: "2026-04-26T20:05:00.000Z",
    });
    await store.writeManifest(buildKeyPrefix(ready.id, ready.created_at), ready);
    await store.writeManifest(buildKeyPrefix(pending.id, pending.created_at), pending);

    const found = await store.findManifestByUrl(url);
    expect(found?.manifest.id).toBe("rd_ready");
  });

  it("prefers the newest reading among same-status duplicates of the same URL", async () => {
    // The status tiebreak must not override recency *within* a status class:
    // two ready copies still resolve to the most recently updated one.
    const store = new ReadingStore(env.READINGS_BUCKET);
    const url = "https://example.com/dup-ready";
    const urlHash = await sha256Hex(url);

    const older = emptyManifest({
      id: "rd_older",
      url,
      url_hash: urlHash,
      status: "ready",
      created_at: "2026-04-26T20:00:00.000Z",
      updated_at: "2026-04-26T20:00:00.000Z",
    });
    const newer = emptyManifest({
      id: "rd_newer",
      url,
      url_hash: urlHash,
      status: "ready",
      created_at: "2026-04-26T20:05:00.000Z",
      updated_at: "2026-04-26T20:05:00.000Z",
    });
    await store.writeManifest(buildKeyPrefix(older.id, older.created_at), older);
    await store.writeManifest(buildKeyPrefix(newer.id, newer.created_at), newer);

    const found = await store.findManifestByUrl(url);
    expect(found?.manifest.id).toBe("rd_newer");
  });
});
