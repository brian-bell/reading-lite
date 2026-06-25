import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { findByUrlInList } from "../../../../scripts/corpus-lib/batch/r2-reads";
import type { Manifest } from "../../../../src/schemas/manifest";

function hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const URL = "https://example.com/a";

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_X",
    url: URL,
    url_hash: hex(URL),
    source_type: "markdown",
    status: "failed",
    content_type: "text/markdown; charset=utf-8",
    content_status: "failed",
    content_bytes: 0,
    content_sha256: "a".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...over,
  } as Manifest;
}

// Minimal R2 client backed by an in-memory map. `listKeys` returns every seeded
// key so the missing-index rebuild scan can find manifests, mirroring the real
// paging R2 client.
function r2(seed: Record<string, string>) {
  return {
    get: async (k: string) => seed[k] ?? null,
    listKeys: async () => Object.keys(seed),
  };
}

function listIndex(items: object[]): string {
  return JSON.stringify({ version: 1, items });
}

describe("findByUrlInList", () => {
  it("returns null on a truly cold bucket (no index, no manifests)", async () => {
    expect(await findByUrlInList(r2({}), URL, hex(URL))).toBeNull();
  });

  it("rebuilds from a manifest scan when index/list.json is absent", async () => {
    // The Worker's findManifestByUrl rebuilds from manifests when the index is
    // missing; this offline path must too, or a corpus whose index was deleted
    // (but whose manifests survive) would mint a duplicate over an owned URL.
    const kp = "readings/kp-failed";
    const seed = {
      [`${kp}/manifest.json`]: JSON.stringify(manifest({ id: "rd_F", status: "failed" })),
    };
    const found = await findByUrlInList(r2(seed), URL, hex(URL));
    expect(found?.id).toBe("rd_F");
    expect(found?.key_prefix).toBe(kp);
    expect(found?.manifest.status).toBe("failed");
  });

  it("rebuilds and prefers a ready owner over a failed duplicate when the index is absent", async () => {
    const readyKp = "readings/kp-ready";
    const failedKp = "readings/kp-failed";
    const seed = {
      [`${readyKp}/manifest.json`]: JSON.stringify(manifest({ id: "rd_READY", status: "ready" })),
      [`${failedKp}/manifest.json`]: JSON.stringify(
        manifest({ id: "rd_FAIL", status: "failed", updated_at: "2026-03-01T00:00:00.000Z" }),
      ),
    };
    const found = await findByUrlInList(r2(seed), URL, hex(URL));
    expect(found?.id).toBe("rd_READY");
  });

  it("rebuilds when index/list.json is present but unparseable", async () => {
    const kp = "readings/kp-failed";
    const seed = {
      "index/list.json": "{ not json",
      [`${kp}/manifest.json`]: JSON.stringify(manifest({ id: "rd_F", status: "failed" })),
    };
    const found = await findByUrlInList(r2(seed), URL, hex(URL));
    expect(found?.id).toBe("rd_F");
  });

  it("resolves a failed reading by URL through the list index (the no-by-url-pointer case)", async () => {
    const kp = "readings/kp-failed";
    const seed = {
      "index/list.json": listIndex([{ id: "rd_F", key_prefix: kp, url: URL, status: "failed", created_at: "2026-01-01T00:00:00.000Z" }]),
      [`${kp}/manifest.json`]: JSON.stringify(manifest({ id: "rd_F", status: "failed" })),
    };
    const found = await findByUrlInList(r2(seed), URL, hex(URL));
    expect(found?.id).toBe("rd_F");
    expect(found?.key_prefix).toBe(kp);
    expect(found?.manifest.status).toBe("failed");
  });

  it("prefers a ready owner over a newer failed duplicate (ownership rank)", async () => {
    const readyKp = "readings/kp-ready";
    const failedKp = "readings/kp-failed";
    const seed = {
      "index/list.json": listIndex([
        // the failed row is newer, but the ready copy owns the URL
        { id: "rd_FAIL", key_prefix: failedKp, url: URL, status: "failed", created_at: "2026-03-01T00:00:00.000Z" },
        { id: "rd_READY", key_prefix: readyKp, url: URL, status: "ready", created_at: "2026-01-01T00:00:00.000Z" },
      ]),
      [`${readyKp}/manifest.json`]: JSON.stringify(manifest({ id: "rd_READY", status: "ready" })),
      [`${failedKp}/manifest.json`]: JSON.stringify(manifest({ id: "rd_FAIL", status: "failed" })),
    };
    const found = await findByUrlInList(r2(seed), URL, hex(URL));
    expect(found?.id).toBe("rd_READY");
  });

  it("returns the manifest's id, not the list row's, when the row is cross-wired", async () => {
    // Stale/cross-wired index: the row's id is wrong, but its key_prefix points
    // at a real manifest for this URL. The verified manifest is the source of
    // truth, so re-ingest must target the manifest's own id — not the row id,
    // which would overwrite the manifest under the wrong reading id.
    const kp = "readings/kp-crosswired";
    const seed = {
      "index/list.json": listIndex([{ id: "rd_STALE", key_prefix: kp, url: URL, status: "failed", created_at: "2026-01-01T00:00:00.000Z" }]),
      [`${kp}/manifest.json`]: JSON.stringify(manifest({ id: "rd_REAL", status: "failed" })),
    };
    const found = await findByUrlInList(r2(seed), URL, hex(URL));
    expect(found?.id).toBe("rd_REAL");
    expect(found?.key_prefix).toBe(kp);
  });

  it("skips a list row whose manifest does not actually match the URL", async () => {
    const kp = "readings/kp-mismatch";
    const seed = {
      "index/list.json": listIndex([{ id: "rd_M", key_prefix: kp, url: URL, status: "failed", created_at: "2026-01-01T00:00:00.000Z" }]),
      // manifest belongs to a different URL — a stale/cross-wired index row
      [`${kp}/manifest.json`]: JSON.stringify(
        manifest({ id: "rd_M", url: "https://example.com/other", url_hash: hex("https://example.com/other") }),
      ),
    };
    expect(await findByUrlInList(r2(seed), URL, hex(URL))).toBeNull();
  });

  it("ignores rows for other URLs", async () => {
    const seed = {
      "index/list.json": listIndex([
        { id: "rd_O", key_prefix: "readings/kp-o", url: "https://example.com/other", status: "failed", created_at: "2026-01-01T00:00:00.000Z" },
      ]),
    };
    expect(await findByUrlInList(r2(seed), URL, hex(URL))).toBeNull();
  });
});
