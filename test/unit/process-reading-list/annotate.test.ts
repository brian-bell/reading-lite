import { describe, expect, it } from "vitest";
import { applyResults } from "../../../scripts/process-reading-list-lib/annotate";
import type { SubmitResult } from "../../../scripts/import-bookmarks-lib/submit";

const NOW = "2026-06-17T00:00:00.000Z";

function result(partial: Partial<SubmitResult> & Pick<SubmitResult, "url" | "classification">): SubmitResult {
  return { index: 1, total: 1, ...partial };
}

describe("applyResults", () => {
  it("marks a newly-queued (202/new) entry submitted but not processed", () => {
    const map = new Map<string, SubmitResult>([
      ["https://a.example", result({ url: "https://a.example", classification: "new", id: "rd_1" })],
    ]);
    const { entries, summary } = applyResults([{ url: "https://a.example", processed: false }], map, NOW);
    expect(entries[0]).toEqual({
      url: "https://a.example",
      processed: false,
      submitted: true,
      reading_id: "rd_1",
      submitted_at: NOW,
    });
    expect(summary.queued).toBe(1);
  });

  it("flips an existing (200) entry to processed:true", () => {
    const map = new Map<string, SubmitResult>([
      ["https://a.example", result({ url: "https://a.example", classification: "existing", id: "rd_9" })],
    ]);
    const { entries, summary } = applyResults([{ url: "https://a.example", processed: false }], map, NOW);
    expect(entries[0]).toMatchObject({ processed: true, reading_id: "rd_9", submitted_at: NOW });
    expect(summary.confirmed).toBe(1);
  });

  it("clears a stale submit_error when a later attempt succeeds", () => {
    const map = new Map<string, SubmitResult>([
      ["https://a.example", result({ url: "https://a.example", classification: "new", id: "rd_2" })],
    ]);
    const { entries } = applyResults(
      [{ url: "https://a.example", processed: false, submit_error: "401 unauthorized" }],
      map,
      NOW,
    );
    expect(entries[0]).not.toHaveProperty("submit_error");
    expect(entries[0]).toMatchObject({ submitted: true, reading_id: "rd_2" });
  });

  it("records an error without changing processed", () => {
    const map = new Map<string, SubmitResult>([
      ["https://a.example", result({ url: "https://a.example", classification: "error", error: "500 boom" })],
    ]);
    const { entries, summary } = applyResults([{ url: "https://a.example", processed: false }], map, NOW);
    expect(entries[0]).toEqual({ url: "https://a.example", processed: false, submit_error: "500 boom" });
    expect(summary.errors).toBe(1);
  });

  it("leaves entries with no result untouched and does not mutate input", () => {
    const input = [{ url: "https://a.example", processed: false }];
    const { entries } = applyResults(input, new Map(), NOW);
    expect(entries[0]).toEqual({ url: "https://a.example", processed: false });
    expect(input[0]).toEqual({ url: "https://a.example", processed: false });
    expect(entries[0]).not.toBe(input[0]);
  });
});
