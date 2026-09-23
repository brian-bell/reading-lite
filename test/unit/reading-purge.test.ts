import { describe, expect, it, vi } from "vitest";
import type { ContentStore } from "../../src/modules/stores/content-store";
import type { PgReadingWriter } from "../../src/modules/stores/postgres/reading-writer";
import { purgeReading } from "../../src/reading-purge";

// Rows first, objects second: once the row transaction commits the reading is
// purged, and the object sweep can only add to the report or be logged.

const OPTS = { pendingTtlSeconds: 300, now: "2026-04-26T20:00:00.000Z" };

function writerWith(outcome: Awaited<ReturnType<PgReadingWriter["purge"]>>): PgReadingWriter {
  return { purge: vi.fn(async () => outcome) } as unknown as PgReadingWriter;
}

function purgedRow() {
  return { kind: "purged" as const, keyPrefix: "readings/2026/04/26T200000Z-rd_1", urlReleased: true, embeddingRemoved: true };
}

describe("purgeReading", () => {
  it("counts both sweeps of the reading's prefix", async () => {
    const deletePrefix = vi.fn<ContentStore["deletePrefix"]>().mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    const out = await purgeReading({ writer: writerWith(purgedRow()), content: { deletePrefix } as unknown as ContentStore }, "rd_1", OPTS);

    expect(out).toEqual({
      kind: "purged",
      report: { id: "rd_1", vector_delete_requested: true, list_row_removed: true, by_url_released: true, objects_deleted: 4 },
    });
    expect(deletePrefix).toHaveBeenCalledTimes(2);
    expect(deletePrefix).toHaveBeenCalledWith("readings/2026/04/26T200000Z-rd_1");
  });

  // The row is gone and a retry would 404, so the object sweep failing is
  // logged with the prefix, not surfaced as a failed delete.
  it("reports the purge and logs the prefix when the object sweep throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const deletePrefix = vi.fn<ContentStore["deletePrefix"]>().mockResolvedValueOnce(2).mockRejectedValueOnce(new Error("R2 5xx"));

    const out = await purgeReading({ writer: writerWith(purgedRow()), content: { deletePrefix } as unknown as ContentStore }, "rd_1", OPTS);

    expect(out).toMatchObject({ kind: "purged", report: { id: "rd_1", by_url_released: true, objects_deleted: 2 } });
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]![0])).toContain("readings/2026/04/26T200000Z-rd_1/");
    error.mockRestore();
  });

  it.each([
    [{ kind: "not_found" as const }, { kind: "not_found" }],
    [{ kind: "conflict" as const }, { kind: "conflict", reason: "active_attempt" }],
  ])("sweeps nothing when the row verb answers %j", async (outcome, expected) => {
    const deletePrefix = vi.fn<ContentStore["deletePrefix"]>();
    const out = await purgeReading({ writer: writerWith(outcome), content: { deletePrefix } as unknown as ContentStore }, "rd_1", OPTS);
    expect(out).toEqual(expected);
    expect(deletePrefix).not.toHaveBeenCalled();
  });
});
