import { describe, expect, it, vi } from "vitest";
import {
  submitMarkdownAll,
  type MarkdownSubmitResult,
} from "../../../scripts/import-markdown-lib/submit";
import type { ReadingApiOutcome } from "../../../scripts/lib/reading-api";

// The loop owns orchestration only; HTTP mechanics live behind the injected
// Reading API client and are tested with it.
describe("submitMarkdownAll", () => {
  it("imports articles serially, forwarding body fields and the email decision", async () => {
    let inFlight = 0;
    let peak = 0;
    const importMarkdown = vi.fn(async (_body: unknown): Promise<ReadingApiOutcome> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { kind: "activated", id: "rd_x" };
    });

    const results: MarkdownSubmitResult[] = [];
    const summary = await submitMarkdownAll(
      [
        { sourceUrl: "https://example.com/a", title: "A", markdown: "# A\n\nbody", filePath: "/tmp/a.md" },
        { sourceUrl: "https://example.com/b", markdown: "# B\n\nbody", filePath: "/tmp/b.md" },
      ],
      {
        api: { importMarkdown },
        email: false,
        onResult: (result) => {
          results.push(result);
        },
      },
    );

    expect(peak).toBe(1);
    expect(summary).toMatchObject({ total: 2, new: 2, existing: 0, errors: 0 });
    expect(importMarkdown.mock.calls[0]![0]).toEqual({
      source_url: "https://example.com/a",
      markdown: "# A\n\nbody",
      title: "A",
      email: false,
    });
    expect(importMarkdown.mock.calls[1]![0]).toEqual({
      source_url: "https://example.com/b",
      markdown: "# B\n\nbody",
      email: false,
    });
    expect(results.map((r) => r.filePath)).toEqual(["/tmp/a.md", "/tmp/b.md"]);
  });

  it("classifies existing and initializing owners as existing, and failures as errors", async () => {
    const outcomes: ReadingApiOutcome[] = [
      { kind: "existing", id: "rd_a" },
      { kind: "initializing", id: "rd_b" },
      { kind: "http_error", status: 500, message: "boom" },
    ];
    let i = 0;
    const results: MarkdownSubmitResult[] = [];
    const summary = await submitMarkdownAll(
      ["a", "b", "c"].map((n) => ({
        sourceUrl: `https://example.com/${n}`,
        markdown: "# x",
        filePath: `/tmp/${n}.md`,
      })),
      {
        api: { importMarkdown: async () => outcomes[i++]! },
        email: true,
        onResult: (r) => void results.push(r),
      },
    );
    expect(summary).toMatchObject({ new: 0, existing: 2, errors: 1 });
    expect(results[0]!.classification).toBe("existing");
    expect(results[1]!.classification).toBe("existing");
    expect(results[1]!.id).toBe("rd_b");
    expect(results[2]!.classification).toBe("error");
    expect(results[2]!.error).toMatch(/500/);
  });

  it("reports index/total on every result", async () => {
    const results: MarkdownSubmitResult[] = [];
    await submitMarkdownAll(
      ["a", "b"].map((n) => ({
        sourceUrl: `https://example.com/${n}`,
        markdown: "# x",
        filePath: `/tmp/${n}.md`,
      })),
      {
        api: { importMarkdown: async () => ({ kind: "activated", id: "rd_x" }) },
        email: false,
        onResult: (r) => void results.push(r),
      },
    );
    expect(results.map((r) => [r.index, r.total])).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
