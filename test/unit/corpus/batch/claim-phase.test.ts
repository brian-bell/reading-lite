import { describe, expect, it, vi } from "vitest";
import { claimByUrlSlots } from "../../../../scripts/corpus-lib/batch/claim-phase";
import { PointerExistsError } from "../../../../scripts/lib/cf-clients";
import type { ExtractedTarget } from "../../../../scripts/corpus-lib/batch/types";
import { ByUrlPointerSchema, ManifestSchema, type Manifest } from "../../../../src/schemas/manifest";
import { ownedManifestMatches } from "../../../../src/modules/reading-claim";

const MD = "text/markdown; charset=utf-8";

function fakeR2(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const etags = new Map<string, number>();
  const etagOf = (key: string) => String(etags.get(key) ?? 0);
  return {
    store,
    put: vi.fn(async (key: string, body: Uint8Array | string, opts?: { ifNoneMatch?: "*"; ifMatch?: string }) => {
      if (opts?.ifNoneMatch === "*" && store.has(key)) throw new PointerExistsError(key);
      if (opts?.ifMatch !== undefined && (!store.has(key) || opts.ifMatch !== etagOf(key))) throw new PointerExistsError(key);
      store.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
      etags.set(key, (etags.get(key) ?? 0) + 1);
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    getWithEtag: vi.fn(async (key: string) => (store.has(key) ? { body: store.get(key)!, etag: etagOf(key) } : null)),
    head: vi.fn(async (key: string) => store.has(key)),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    listKeys: vi.fn(async () => [...store.keys()]),
  };
}

function extractedTarget(over: { id?: string; url?: string; urlHash?: string; keyPrefix?: string } = {}): ExtractedTarget {
  const id = over.id ?? "rd_a";
  const url = over.url ?? `https://example.com/${id}`;
  const urlHash = over.urlHash ?? "a".repeat(64);
  const keyPrefix = over.keyPrefix ?? `readings/2026/01/01T000000Z-${id}`;
  const createdAt = "2026-01-01T00:00:00.000Z";
  const manifest = {
    id,
    url,
    url_hash: urlHash,
    source_type: "markdown",
    status: "pending",
    content_type: MD,
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: createdAt,
    updated_at: createdAt,
  } as Manifest;
  return {
    target: { readingId: id, url, urlHash, keyPrefix, createdAt, manifest },
    markdown: "# body",
    fresh: {
      raw: new TextEncoder().encode("# body"),
      content_type: MD,
      content_status: "captured",
      content_bytes: 10,
      content_sha256: "b".repeat(64),
      markdown: "# body",
    },
  };
}

function manifestJson(over: Partial<Manifest>): string {
  const m = {
    id: "rd_a",
    url: "https://example.com/rd_a",
    url_hash: "a".repeat(64),
    source_type: "markdown",
    status: "failed",
    content_type: MD,
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Manifest;
  return JSON.stringify(ManifestSchema.parse(m));
}

const deps = (r2: ReturnType<typeof fakeR2>) => ({ r2, now: () => "2026-02-02T00:00:00.000Z" });

describe("claimByUrlSlots", () => {
  it("claims an empty slot: byte-compatible by-url pointer + pending manifest + by-id + list row", async () => {
    const r2 = fakeR2();
    const st = extractedTarget();
    const { kept, deferred } = await claimByUrlSlots([st], deps(r2));

    expect(kept).toHaveLength(1);
    expect(deferred).toHaveLength(0);

    // by-url pointer is byte-compatible with the online schema and owns the URL.
    const pointerRaw = r2.store.get(`index/by-url/${"a".repeat(64)}`)!;
    const pointer = ByUrlPointerSchema.parse(JSON.parse(pointerRaw));
    expect(pointer).toEqual({ id: "rd_a", key_prefix: "readings/2026/01/01T000000Z-rd_a" });

    const manifest = ManifestSchema.parse(JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!));
    expect(manifest.status).toBe("pending");
    expect(ownedManifestMatches(pointer, manifest, st.target.url, "a".repeat(64))).toBe(true);

    // by-id pointer present and matching.
    expect(JSON.parse(r2.store.get("index/by-id/rd_a")!)).toEqual(pointer);

    // pending list row present.
    const list = JSON.parse(r2.store.get("index/list.json")!) as { items: Array<{ id: string; status: string }> };
    expect(list.items.find((i) => i.id === "rd_a")?.status).toBe("pending");
  });

  it("persists fresh content artifacts BEFORE the pending manifest (so a captured-pending manifest never lacks its content)", async () => {
    const r2 = fakeR2();
    const keyPrefix = "readings/2026/01/01T000000Z-rd_a";
    const putOrder: string[] = [];
    const origPut = r2.put;
    r2.put = vi.fn(async (key: string, body: Uint8Array | string, opts?: { ifNoneMatch?: "*" }) => {
      putOrder.push(key);
      await origPut(key, body, opts);
    });

    await claimByUrlSlots([extractedTarget()], deps(r2));

    // raw + extracted are both written, and both BEFORE the manifest.
    expect(r2.store.get(`${keyPrefix}/raw.md`)).toBe("# body");
    expect(r2.store.get(`${keyPrefix}/extracted.md`)).toBe("# body");
    const rawIdx = putOrder.indexOf(`${keyPrefix}/raw.md`);
    const extractedIdx = putOrder.indexOf(`${keyPrefix}/extracted.md`);
    const manifestIdx = putOrder.indexOf(`${keyPrefix}/manifest.json`);
    expect(rawIdx).toBeGreaterThanOrEqual(0);
    expect(rawIdx).toBeLessThan(manifestIdx);
    expect(extractedIdx).toBeLessThan(manifestIdx);
  });

  it("conflict but the slot is already ours (failed) → overwrites the manifest to pending, keeps it", async () => {
    const urlHash = "a".repeat(64);
    const keyPrefix = "readings/2026/01/01T000000Z-rd_a";
    const r2 = fakeR2({
      [`index/by-url/${urlHash}`]: JSON.stringify({ id: "rd_a", key_prefix: keyPrefix }),
      [`${keyPrefix}/manifest.json`]: manifestJson({ status: "failed" }),
    });
    const { kept, deferred } = await claimByUrlSlots([extractedTarget()], deps(r2));

    expect(kept).toHaveLength(1);
    expect(deferred).toHaveLength(0);
    const manifest = ManifestSchema.parse(JSON.parse(r2.store.get(`${keyPrefix}/manifest.json`)!));
    expect(manifest.status).toBe("pending");
  });

  it("conflict but the slot is already ours AND ready → DROPS it from the batch without degrading the ready manifest", async () => {
    const urlHash = "a".repeat(64);
    const keyPrefix = "readings/2026/01/01T000000Z-rd_a";
    const readyJson = manifestJson({ status: "ready", title: "T", tldr: "x", tags: [], keywords: [], people: [], orgs: [], summary_markdown: "s" });
    const r2 = fakeR2({
      [`index/by-url/${urlHash}`]: JSON.stringify({ id: "rd_a", key_prefix: keyPrefix }),
      [`${keyPrefix}/manifest.json`]: readyJson,
    });
    const { kept, deferred } = await claimByUrlSlots([extractedTarget()], deps(r2));

    // Not summarized (so a batch failure can never overwrite the ready manifest).
    expect(kept).toHaveLength(0);
    expect(deferred).toEqual([{ id: "rd_a", url: "https://example.com/rd_a", reason: expect.stringMatching(/already ready/) }]);
    // Manifest untouched — still the ready bytes.
    expect(r2.store.get(`${keyPrefix}/manifest.json`)).toBe(readyJson);
  });

  it("freshly claims an empty by-url slot whose key_prefix already holds a READY manifest → does NOT degrade it to pending", async () => {
    // A legacy/cold ready reading that lacks a by-url pointer: the conditional
    // create succeeds (empty slot), but the existing ready manifest + summary must
    // survive — only the missing pointer is added.
    const urlHash = "a".repeat(64);
    const keyPrefix = "readings/2026/01/01T000000Z-rd_a";
    const readyJson = manifestJson({ status: "ready", title: "T", tldr: "x", tags: [], keywords: [], people: [], orgs: [], summary_markdown: "s" });
    const r2 = fakeR2({ [`${keyPrefix}/manifest.json`]: readyJson }); // NOTE: no by-url pointer seeded
    const { kept, deferred } = await claimByUrlSlots([extractedTarget()], deps(r2));

    // Dropped from the batch (not re-summarized), ready manifest preserved.
    expect(kept).toHaveLength(0);
    expect(deferred).toHaveLength(1);
    // The ready manifest was left untouched (summary preserved).
    expect(r2.store.get(`${keyPrefix}/manifest.json`)).toBe(readyJson);
    // The previously-missing by-url pointer was created, pointing at the reading.
    expect(JSON.parse(r2.store.get(`index/by-url/${urlHash}`)!)).toEqual({ id: "rd_a", key_prefix: keyPrefix });
  });

  it("conflict owned by a DIFFERENT id → defers (drops the target, writes nothing under our id)", async () => {
    const urlHash = "a".repeat(64);
    const r2 = fakeR2({
      [`index/by-url/${urlHash}`]: JSON.stringify({ id: "rd_other", key_prefix: "readings/2026/01/01T000000Z-rd_other" }),
    });
    const { kept, deferred } = await claimByUrlSlots([extractedTarget()], deps(r2));

    expect(kept).toHaveLength(0);
    expect(deferred).toEqual([{ id: "rd_a", url: "https://example.com/rd_a", reason: expect.any(String) }]);
    // Our id's manifest and by-id were never written.
    expect(r2.store.has("readings/2026/01/01T000000Z-rd_a/manifest.json")).toBe(false);
    expect(r2.store.has("index/by-id/rd_a")).toBe(false);
    // The foreign claim is untouched.
    expect(JSON.parse(r2.store.get(`index/by-url/${urlHash}`)!).id).toBe("rd_other");
  });

  it("merges all kept pending rows into index/list.json in a single write", async () => {
    const r2 = fakeR2();
    const a = extractedTarget({ id: "rd_a", url: "https://example.com/a", urlHash: "a".repeat(64), keyPrefix: "readings/2026/01/01T000000Z-rd_a" });
    const b = extractedTarget({ id: "rd_b", url: "https://example.com/b", urlHash: "c".repeat(64), keyPrefix: "readings/2026/01/01T000000Z-rd_b" });

    await claimByUrlSlots([a, b], deps(r2));

    const list = JSON.parse(r2.store.get("index/list.json")!) as { items: Array<{ id: string }> };
    expect(list.items.map((i) => i.id).sort()).toEqual(["rd_a", "rd_b"]);
    // Exactly one list.json write (single merge), not one per target.
    const listWrites = r2.put.mock.calls.filter((c) => c[0] === "index/list.json");
    expect(listWrites).toHaveLength(1);
  });
});
