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

// Minimal R2 getter backed by an in-memory map.
function r2(seed: Record<string, string>) {
  return { get: async (k: string) => seed[k] ?? null };
}

function listIndex(items: object[]): string {
  return JSON.stringify({ version: 1, items });
}

describe("findByUrlInList", () => {
  it("returns null when there is no list index", async () => {
    expect(await findByUrlInList(r2({}), URL, hex(URL))).toBeNull();
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
