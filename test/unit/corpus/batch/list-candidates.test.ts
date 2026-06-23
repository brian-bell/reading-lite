import { describe, expect, it, vi } from "vitest";
import { makeListCandidatesResolver } from "../../../../scripts/corpus-lib/batch/list-candidates";
import type { Manifest } from "../../../../src/schemas/manifest";

// Minimal R2 reader stub: a key->value map for get(), keys() for listKeys().
function fakeR2(objects: Record<string, string>) {
  const get = vi.fn(async (key: string) => objects[key] ?? null);
  const listKeys = vi.fn(async () => Object.keys(objects));
  return { get, listKeys };
}

function manifest(over: Partial<Manifest> = {}): Manifest {
  const url = over.url ?? "https://example.com/a";
  return {
    id: "rd_x",
    url,
    url_hash: "a".repeat(64),
    source_type: "url",
    status: "ready",
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 1,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...over,
  } as Manifest;
}

function listIndex(items: Array<Record<string, unknown>>): string {
  return JSON.stringify({ version: 1, items });
}

const URL_A = "https://example.com/a";

describe("makeListCandidatesResolver", () => {
  it("returns ranked candidates from a present index (ready > pending > failed, then recency)", async () => {
    const r2 = fakeR2({
      "index/list.json": listIndex([
        { id: "rd_failed", key_prefix: "readings/kp-failed", url: URL_A, status: "failed", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
        { id: "rd_ready", key_prefix: "readings/kp-ready", url: URL_A, status: "ready", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
        { id: "rd_pending", key_prefix: "readings/kp-pending", url: URL_A, status: "pending", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
      ]),
    });
    const resolve = makeListCandidatesResolver(r2);
    const candidates = await resolve(URL_A);
    expect(candidates.map((c) => c.id)).toEqual(["rd_ready", "rd_pending", "rd_failed"]);
  });

  it("returns [] from a present index with no row for the URL", async () => {
    const r2 = fakeR2({ "index/list.json": listIndex([]) });
    const resolve = makeListCandidatesResolver(r2);
    expect(await resolve(URL_A)).toEqual([]);
  });

  it("rebuilds candidates from R2 manifests when the index is ABSENT (adopts pointerless legacy)", async () => {
    // No index/list.json, but a legacy ready reading exists in the bucket. Mirror the
    // worker: scan manifests and surface it so it is adopted, not duplicated.
    const r2 = fakeR2({
      "readings/2026/01/01T000000Z-rd_legacy/manifest.json": JSON.stringify(
        manifest({ id: "rd_legacy", url: URL_A, status: "ready" }),
      ),
      "readings/2026/01/01T000000Z-rd_other/manifest.json": JSON.stringify(
        manifest({ id: "rd_other", url: "https://example.com/OTHER", status: "ready" }),
      ),
      "index/by-url/abc": "{}", // non-manifest key must be ignored by the scan
    });
    const resolve = makeListCandidatesResolver(r2);
    const candidates = await resolve(URL_A);
    expect(candidates).toEqual([{ id: "rd_legacy", key_prefix: "readings/2026/01/01T000000Z-rd_legacy" }]);
    expect(await resolve("https://example.com/OTHER")).toEqual([
      { id: "rd_other", key_prefix: "readings/2026/01/01T000000Z-rd_other" },
    ]);
  });

  it("returns [] (not an error) when the index is absent and the bucket is empty", async () => {
    const r2 = fakeR2({});
    const resolve = makeListCandidatesResolver(r2);
    expect(await resolve(URL_A)).toEqual([]);
  });

  it("skips unparseable/invalid manifests during the rebuild", async () => {
    const r2 = fakeR2({
      "readings/2026/01/01T000000Z-rd_bad/manifest.json": "{ not json",
      "readings/2026/01/01T000000Z-rd_wrong/manifest.json": JSON.stringify({ id: "rd_wrong" }),
      "readings/2026/01/01T000000Z-rd_ok/manifest.json": JSON.stringify(manifest({ id: "rd_ok", url: URL_A })),
    });
    const resolve = makeListCandidatesResolver(r2);
    expect(await resolve(URL_A)).toEqual([{ id: "rd_ok", key_prefix: "readings/2026/01/01T000000Z-rd_ok" }]);
  });

  it("fails closed on a present-but-unparseable index (does NOT silently treat as empty)", async () => {
    const r2 = fakeR2({ "index/list.json": "{ corrupt" });
    const resolve = makeListCandidatesResolver(r2);
    await expect(resolve(URL_A)).rejects.toThrow(/unparseable/i);
  });

  it("fails closed on a present index missing its items array", async () => {
    const r2 = fakeR2({ "index/list.json": JSON.stringify({ version: 1 }) });
    const resolve = makeListCandidatesResolver(r2);
    await expect(resolve(URL_A)).rejects.toThrow(/items/i);
  });

  it("loads the index once and caches across calls", async () => {
    const r2 = fakeR2({ "index/list.json": listIndex([]) });
    const resolve = makeListCandidatesResolver(r2);
    await resolve(URL_A);
    await resolve("https://example.com/b");
    expect(r2.get).toHaveBeenCalledTimes(1);
  });
});
