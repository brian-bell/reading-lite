import { afterEach, describe, expect, it, vi } from "vitest";
import { purgeReading } from "../../src/reading-purge";
import { sha256Hex } from "../../src/services";
import { nodeReadingsFor } from "../helpers/node-readings";
import { founderTenant } from "../helpers/tenant-fixtures";

afterEach(() => vi.restoreAllMocks());

describe("purgeReading", () => {
  // The row delete is the irreversible half. A cleanup that fails after it
  // cannot be retried through the API (the id is a 404 by then), so it must
  // not turn the completed purge into an error.
  it("reports the purge when the refresh-checkpoint cleanup fails", async () => {
    const readings = nodeReadingsFor(founderTenant());
    const url = "https://example.com/purge";
    await readings.seed({
      id: "rd_PURGE",
      url,
      url_hash: await sha256Hex(url),
      status: "failed",
      content_type: "application/octet-stream",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T20:00:00.000Z",
      updated_at: "2026-04-26T20:00:00.000Z",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await purgeReading(
      {
        writer: readings.writer,
        content: readings.content,
        deleteRefreshCheckpoint: async () => {
          throw new Error("D1 blip");
        },
      },
      "rd_PURGE",
      { pendingTtlSeconds: 300, now: "2026-04-26T20:10:00.000Z" },
    );

    expect(out).toMatchObject({ kind: "purged", report: { id: "rd_PURGE", by_url_released: true } });
    expect(await readings.manifest("rd_PURGE")).toBeNull();
  });
});
