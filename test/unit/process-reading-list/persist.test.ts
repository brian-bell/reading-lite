import { describe, expect, it } from "vitest";
import type { ReadingListEntry } from "../../../scripts/check-corpus-lib/corpus";
import type { SubmitResult } from "../../../scripts/import-bookmarks-lib/submit";
import { createResultSink } from "../../../scripts/process-reading-list-lib/persist";

const NOW = "2026-06-17T00:00:00.000Z";

function result(partial: Partial<SubmitResult> & Pick<SubmitResult, "url" | "classification">): SubmitResult {
  return { index: 1, total: 1, ...partial };
}

describe("createResultSink", () => {
  it("flushes the cumulative annotation after each non-skipped result", async () => {
    const entries: ReadingListEntry[] = [
      { url: "https://a.example", processed: false },
      { url: "https://b.example", processed: false },
    ];
    const flushes: ReadingListEntry[][] = [];
    const sink = createResultSink({
      entries,
      now: NOW,
      flush: async (e) => {
        flushes.push(e);
      },
    });

    await sink.onResult(result({ url: "https://a.example", classification: "new", id: "rd_1" }));

    // The first accepted URL is persisted immediately — an interrupt here must
    // not lose the 202 outcome.
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toContainEqual({
      url: "https://a.example",
      processed: false,
      submitted: true,
      reading_id: "rd_1",
      submitted_at: NOW,
    });

    await sink.onResult(result({ url: "https://b.example", classification: "existing", id: "rd_2" }));
    expect(flushes).toHaveLength(2);
    expect(flushes[1]).toContainEqual(
      expect.objectContaining({ url: "https://b.example", processed: true, reading_id: "rd_2" }),
    );
  });

  it("does not flush (or count) skipped results", async () => {
    const entries: ReadingListEntry[] = [{ url: "https://a.example", processed: false }];
    const flushes: ReadingListEntry[][] = [];
    const sink = createResultSink({ entries, now: NOW, flush: async (e) => void flushes.push(e) });

    await sink.onResult(result({ url: "https://a.example", classification: "skipped" }));

    expect(flushes).toHaveLength(0);
    expect(sink.skipped).toBe(1);
  });

  it("exposes the running summary derived from accumulated results", async () => {
    const entries: ReadingListEntry[] = [
      { url: "https://a.example", processed: false },
      { url: "https://b.example", processed: false },
    ];
    const sink = createResultSink({ entries, now: NOW, flush: async () => {} });

    await sink.onResult(result({ url: "https://a.example", classification: "new", id: "rd_1" }));
    await sink.onResult(result({ url: "https://b.example", classification: "existing", id: "rd_2" }));

    expect(sink.summary()).toEqual({ confirmed: 1, queued: 1, errors: 0 });
  });
});
