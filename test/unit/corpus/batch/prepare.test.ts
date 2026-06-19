import { describe, expect, it, vi } from "vitest";
import { prepareTargets } from "../../../../scripts/corpus-lib/batch/prepare";
import type { Manifest } from "../../../../src/schemas/manifest";
import type { AuditRow } from "../../../../scripts/corpus-lib/types";

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_a",
    url: "https://example.com/a",
    url_hash: "a".repeat(64),
    status: "failed",
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...over,
  } as Manifest;
}

function row(over: Partial<AuditRow> = {}): AuditRow {
  return {
    category: "failed",
    url: "https://example.com/a",
    short: "example.com/a",
    reading_id: "rd_a",
    key_prefix: "readings/2026/01/01T000000Z-rd_a",
    attempts: 1,
    ...over,
  };
}

describe("prepareTargets", () => {
  it("resolves a target from the existing manifest", async () => {
    const readManifest = vi.fn(async () => manifest());
    const { targets, dropped } = await prepareTargets([row()], { readManifest });
    expect(dropped).toHaveLength(0);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      readingId: "rd_a",
      url: "https://example.com/a",
      urlHash: "a".repeat(64),
      keyPrefix: "readings/2026/01/01T000000Z-rd_a",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(readManifest).toHaveBeenCalledWith("readings/2026/01/01T000000Z-rd_a");
  });

  it("drops a row whose manifest is missing", async () => {
    const readManifest = vi.fn(async () => null);
    const { targets, dropped } = await prepareTargets([row()], { readManifest });
    expect(targets).toHaveLength(0);
    expect(dropped).toEqual([{ readingId: "rd_a", reason: expect.stringMatching(/manifest/i) }]);
  });

  it("carries the manifest so a ready reading's snapshot can be preserved", async () => {
    const readManifest = vi.fn(async () => manifest({ status: "ready", title: "Kept" }));
    const { targets } = await prepareTargets([row()], { readManifest });
    expect(targets[0]!.manifest.status).toBe("ready");
    expect(targets[0]!.manifest.title).toBe("Kept");
  });
});
