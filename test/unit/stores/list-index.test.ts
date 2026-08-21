import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListIndexStore, manifestToIndexItem } from "../../../src/modules/stores/list-index";
import { buildKeyPrefix } from "../../../src/modules/stores/reading-store";
import type { Manifest } from "../../../src/schemas/manifest";
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

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) {
    await env.READINGS_BUCKET.delete(obj.key);
  }
}

beforeEach(clearBucket);
afterEach(clearBucket);

describe("ListIndexStore — appendOrReplace / remove (CAS)", () => {
  it("creates an index when none exists and appends the item", async () => {
    const index = new ListIndexStore(env.READINGS_BUCKET);
    await index.appendOrReplace(indexItem({ id: "rd_a" }));
    const idx = await index.readListIndex();
    expect(idx!.items.map((i) => i.id)).toEqual(["rd_a"]);
  });

  it("is idempotent on id: replacing keeps a single row with the latest fields", async () => {
    const index = new ListIndexStore(env.READINGS_BUCKET);
    await index.appendOrReplace(indexItem({ id: "rd_a", status: "pending", title: undefined }));
    await index.appendOrReplace(indexItem({ id: "rd_a", status: "ready", title: "After" }));
    const idx = await index.readListIndex();
    expect(idx!.items).toHaveLength(1);
    expect(idx!.items[0]!.status).toBe("ready");
    expect(idx!.items[0]!.title).toBe("After");
  });

  it("does not create an empty index when removing from a cold bucket", async () => {
    const index = new ListIndexStore(env.READINGS_BUCKET);
    await index.remove("rd_missing");
    await expect(index.readListIndex()).resolves.toBeNull();
  });

  it("removeIf deletes only when the predicate matches", async () => {
    const index = new ListIndexStore(env.READINGS_BUCKET);
    await index.appendOrReplace(indexItem({ id: "rd_a", status: "pending" }));

    await index.removeIf("rd_a", (item) => item.status === "ready");
    await expect(index.readListIndex()).resolves.toMatchObject({
      items: [{ id: "rd_a", status: "pending" }],
    });

    await index.removeIf("rd_a", (item) => item.status === "pending");
    await expect(index.readListIndex()).resolves.toMatchObject({ items: [] });
  });

  it("retries and merges a concurrent write instead of clobbering it", async () => {
    const index = new ListIndexStore(env.READINGS_BUCKET, { sleep: async () => {} });
    await index.appendOrReplace(indexItem({ id: "rd_a" }));

    const realPut = env.READINGS_BUCKET.put.bind(env.READINGS_BUCKET);
    let injected = false;
    const spy = vi
      .spyOn(env.READINGS_BUCKET, "put")
      .mockImplementation((async (key: string, value: unknown, options?: unknown) => {
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

    await index.appendOrReplace(indexItem({ id: "rd_c" }));
    spy.mockRestore();

    const idx = await index.readListIndex();
    expect(idx!.items.map((i) => i.id).sort()).toEqual(["rd_a", "rd_b", "rd_c"]);
  });

  it("throws after exhausting CAS attempts under persistent contention", async () => {
    const index = new ListIndexStore(env.READINGS_BUCKET, {
      maxAttempts: 3,
      sleep: async () => {},
    });
    await index.appendOrReplace(indexItem({ id: "rd_a" }));

    const spy = vi
      .spyOn(env.READINGS_BUCKET, "put")
      .mockResolvedValue(null as unknown as R2Object);
    await expect(index.appendOrReplace(indexItem({ id: "rd_b" }))).rejects.toThrow(/list index/i);
    spy.mockRestore();
  });

  it("bounds backoff sleeps under contention (exponential, full-jitter, never above the ceiling)", async () => {
    const sleeps: number[] = [];
    const index = new ListIndexStore(env.READINGS_BUCKET, {
      maxAttempts: 4,
      baseDelayMs: 10,
      random: () => 1, // worst case: full ceiling each attempt
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await index.appendOrReplace(indexItem({ id: "rd_a" }));

    const spy = vi
      .spyOn(env.READINGS_BUCKET, "put")
      .mockResolvedValue(null as unknown as R2Object);
    await expect(index.appendOrReplace(indexItem({ id: "rd_b" }))).rejects.toThrow();
    spy.mockRestore();

    // maxAttempts=4 → one sleep after each of the first 3 failures (none after
    // the final attempt). Full jitter with random()=1 hits the ceiling
    // base * 2**attempt for attempt = 0,1,2.
    expect(sleeps).toEqual([10, 20, 40]);
  });
});

describe("ListIndexStore — findManifestByUrl ownership ranking", () => {
  it("prefers a ready owner over a newer failed duplicate of the same URL", async () => {
    const index = new ListIndexStore(env.READINGS_BUCKET);
    const url = "https://example.com/dup";
    const urlHash = await sha256Hex(url);
    const ready = emptyManifest({
      id: "rd_ready", url, url_hash: urlHash, status: "ready",
      created_at: "2026-04-26T20:00:00.000Z", updated_at: "2026-04-26T20:00:00.000Z",
    });
    const failed = emptyManifest({
      id: "rd_failed", url, url_hash: urlHash, status: "failed",
      created_at: "2026-04-26T20:05:00.000Z", updated_at: "2026-04-26T20:05:00.000Z",
    });
    await writeManifest(ready);
    await writeManifest(failed);

    const found = await index.findManifestByUrl(url);
    expect(found?.manifest.id).toBe("rd_ready");
  });

  it("prefers a ready owner over a newer pending duplicate of the same URL", async () => {
    const index = new ListIndexStore(env.READINGS_BUCKET);
    const url = "https://example.com/dup-pending";
    const urlHash = await sha256Hex(url);
    const ready = emptyManifest({
      id: "rd_ready", url, url_hash: urlHash, status: "ready",
      created_at: "2026-04-26T20:00:00.000Z", updated_at: "2026-04-26T20:00:00.000Z",
    });
    const pending = emptyManifest({
      id: "rd_pending", url, url_hash: urlHash, status: "pending",
      created_at: "2026-04-26T20:05:00.000Z", updated_at: "2026-04-26T20:05:00.000Z",
    });
    await writeManifest(ready);
    await writeManifest(pending);

    const found = await index.findManifestByUrl(url);
    expect(found?.manifest.id).toBe("rd_ready");
  });

  it("prefers the newest reading among same-status duplicates of the same URL", async () => {
    const index = new ListIndexStore(env.READINGS_BUCKET);
    const url = "https://example.com/dup-ready";
    const urlHash = await sha256Hex(url);
    const older = emptyManifest({
      id: "rd_older", url, url_hash: urlHash, status: "ready",
      created_at: "2026-04-26T20:00:00.000Z", updated_at: "2026-04-26T20:00:00.000Z",
    });
    const newer = emptyManifest({
      id: "rd_newer", url, url_hash: urlHash, status: "ready",
      created_at: "2026-04-26T20:05:00.000Z", updated_at: "2026-04-26T20:05:00.000Z",
    });
    await writeManifest(older);
    await writeManifest(newer);

    const found = await index.findManifestByUrl(url);
    expect(found?.manifest.id).toBe("rd_newer");
  });

  it("ignores stale exact-url index rows whose manifest belongs to another URL", async () => {
    const index = new ListIndexStore(env.READINGS_BUCKET);
    const requestedUrl = "https://example.com/requested";
    const other = emptyManifest({
      id: "rd_other", url: "https://example.com/other", url_hash: "b".repeat(64),
      status: "ready", created_at: "2026-04-26T20:00:00.000Z", updated_at: "2026-04-26T20:00:00.000Z",
    });
    const otherPrefix = buildKeyPrefix(other.id, other.created_at);
    await writeManifest(other);
    await index.appendOrReplace({ ...manifestToIndexItem(other, otherPrefix), url: requestedUrl });

    await expect(index.findManifestByUrl(requestedUrl)).resolves.toBeNull();
  });

  it("does not scan manifests when the list index has no rows for the URL", async () => {
    const requestedUrl = "https://example.com/requested";
    const listIndex: ListIndex = {
      version: 1,
      items: [indexItem({ id: "rd_other", url: "https://example.com/other" })],
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

    const index = new ListIndexStore(bucket);
    await expect(index.findManifestByUrl(requestedUrl)).resolves.toBeNull();
    expect(listCalls).toBe(0);
  });
});

describe("ListIndexStore — list (filter / sort / paginate)", () => {
  async function seed(index: ListIndexStore, items: ListIndexItem[]) {
    await index.writeListIndex({ version: 1, items });
  }

  it("returns items newest-first by created_at with total_filtered", async () => {
    const index = new ListIndexStore(env.READINGS_BUCKET);
    await seed(index, [
      indexItem({ id: "rd_a", created_at: "2026-04-26T20:00:00.000Z" }),
      indexItem({ id: "rd_b", created_at: "2026-04-26T20:00:01.000Z" }),
      indexItem({ id: "rd_c", created_at: "2026-04-26T20:00:02.000Z" }),
    ]);
    const page = await index.list({ offset: 0, limit: 10 });
    expect(page.readings.map((r) => r.id)).toEqual(["rd_c", "rd_b", "rd_a"]);
    expect(page.total_filtered).toBe(3);
  });

  it("paginates with offset+limit; total_filtered is the unpaged count", async () => {
    const index = new ListIndexStore(env.READINGS_BUCKET);
    const items: ListIndexItem[] = [];
    for (let i = 0; i < 5; i++) {
      items.push(indexItem({ id: `rd_${i}`, created_at: `2026-04-26T20:00:0${i}.000Z` }));
    }
    await seed(index, items);
    const page = await index.list({ offset: 2, limit: 2 });
    expect(page.readings.map((r) => r.id)).toEqual(["rd_2", "rd_1"]);
    expect(page.total_filtered).toBe(5);
  });

  it("filters by q (title/tldr/url) and tag, ANDed, case-insensitive", async () => {
    const index = new ListIndexStore(env.READINGS_BUCKET);
    await seed(index, [
      indexItem({ id: "rd_a", title: "Rust async", tags: ["rust"], url: "https://example.com/rust" }),
      indexItem({ id: "rd_b", title: "Rust web", tags: ["web"] }),
      indexItem({ id: "rd_c", title: "Go async", tags: ["rust"] }),
    ]);
    const page = await index.list({ offset: 0, limit: 10, q: "RUST", tag: "rust" });
    expect(page.readings.map((r) => r.id)).toEqual(["rd_a"]);
  });
});

describe("manifestToIndexItem", () => {
  it("copies keywords when present and omits the field when absent", () => {
    const withKeywords = manifestToIndexItem(
      emptyManifest({ id: "rd_kw", keywords: ["soft skills", "sales"] }),
      "readings/2026/04/26T200000Z-rd_kw",
    );
    expect(withKeywords.keywords).toEqual(["soft skills", "sales"]);

    const without = manifestToIndexItem(emptyManifest({ id: "rd_plain" }), "readings/2026/04/26T200000Z-rd_plain");
    expect(without.keywords).toBeUndefined();
  });
});

describe("ListIndexStore — rebuild", () => {
  it("synthesizes items from a bucket scan and reports completeness", async () => {
    const index = new ListIndexStore(env.READINGS_BUCKET);
    const ids = ["rd_a", "rd_b", "rd_c"];
    const times = [
      "2026-04-26T20:00:00.000Z",
      "2026-04-26T20:00:01.000Z",
      "2026-04-26T20:00:02.000Z",
    ];
    for (let i = 0; i < ids.length; i++) {
      await writeManifest(emptyManifest({ id: ids[i]!, status: "ready", created_at: times[i]!, updated_at: times[i]! }));
    }

    const rebuilt = await index.rebuild();
    expect(rebuilt.complete).toBe(true);
    expect(rebuilt.items.map((i) => i.id).sort()).toEqual(["rd_a", "rd_b", "rd_c"]);
  });

  it("reports complete:false when the R2 scan is truncated", async () => {
    const m = emptyManifest({ id: "rd_a", status: "ready", created_at: "2026-04-26T20:00:00.000Z" });
    const manifestKey = `${buildKeyPrefix(m.id, m.created_at)}/manifest.json`;
    const bucket = {
      get: async (key: string) =>
        key === manifestKey ? ({ text: async () => JSON.stringify(m) } as unknown as R2ObjectBody) : null,
      list: async () => ({ objects: [{ key: manifestKey }], truncated: true }),
    } as unknown as R2Bucket;

    const index = new ListIndexStore(bucket);
    const rebuilt = await index.rebuild();
    expect(rebuilt.items.map((i) => i.id)).toEqual(["rd_a"]);
    expect(rebuilt.complete).toBe(false);
  });
});

describe("ListIndexStore — tenant keyRoot isolation", () => {
  it("rebuilds and lists only manifests under its own root", async () => {
    const a = new ListIndexStore(env.READINGS_BUCKET, {
      keyRoot: "u/usr_550e8400-e29b-41d4-a716-446655440000/",
    });
    const b = new ListIndexStore(env.READINGS_BUCKET, {
      keyRoot: "u/usr_11111111-1111-4111-8111-111111111111/",
    });
    const prefix = "readings/2026/04/26T200000Z-rd_TEST";
    await env.READINGS_BUCKET.put(
      `u/usr_550e8400-e29b-41d4-a716-446655440000/${prefix}/manifest.json`,
      JSON.stringify(emptyManifest({ id: "rd_A" })),
    );
    await env.READINGS_BUCKET.put(
      `u/usr_11111111-1111-4111-8111-111111111111/${prefix}/manifest.json`,
      JSON.stringify(emptyManifest({ id: "rd_B" })),
    );

    const rebuiltA = await a.rebuild();
    const rebuiltB = await b.rebuild();
    expect(rebuiltA.items.map((i) => i.id)).toEqual(["rd_A"]);
    expect(rebuiltA.items[0]?.key_prefix).toBe(prefix);
    expect(rebuiltB.items.map((i) => i.id)).toEqual(["rd_B"]);
    expect(rebuiltB.items[0]?.key_prefix).toBe(prefix);
  });
});

async function writeManifest(m: Manifest): Promise<void> {
  await env.READINGS_BUCKET.put(`${buildKeyPrefix(m.id, m.created_at)}/manifest.json`, JSON.stringify(m), {
    httpMetadata: { contentType: "application/json" },
  });
}
