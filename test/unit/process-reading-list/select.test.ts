import { describe, expect, it } from "vitest";
import { selectUnprocessed } from "../../../scripts/process-reading-list-lib/select";

describe("selectUnprocessed", () => {
  it("selects entries that are not processed and have a usable http url", () => {
    const { selected } = selectUnprocessed([
      { url: "https://a.example", processed: false },
      { url: "https://b.example", processed: true },
      { url: "https://c.example" },
    ]);
    expect(selected.map((s) => s.url)).toEqual(["https://a.example", "https://c.example"]);
    expect(selected[0]).toEqual({
      index: 0,
      url: "https://a.example",
      entry: { url: "https://a.example", processed: false },
    });
  });

  it("counts already-processed entries and skips them", () => {
    const r = selectUnprocessed([
      { url: "https://a.example", processed: true },
      { url: "https://b.example", processed: false },
    ]);
    expect(r.alreadyProcessed).toBe(1);
    expect(r.selected).toHaveLength(1);
  });

  it("skips entries missing a usable url and counts them", () => {
    const r = selectUnprocessed([
      { processed: false },
      { url: "", processed: false },
      { url: "ftp://x", processed: false },
      { url: "https://ok.example", processed: false },
    ]);
    expect(r.noUrl).toBe(3);
    expect(r.selected.map((s) => s.url)).toEqual(["https://ok.example"]);
  });

  it("skips entries already submitted unless resubmit is set", () => {
    const entries = [
      { url: "https://a.example", processed: false, submitted: true },
      { url: "https://b.example", processed: false },
    ];
    const def = selectUnprocessed(entries);
    expect(def.alreadySubmitted).toBe(1);
    expect(def.selected.map((s) => s.url)).toEqual(["https://b.example"]);

    const force = selectUnprocessed(entries, { resubmit: true });
    expect(force.selected.map((s) => s.url)).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
});
