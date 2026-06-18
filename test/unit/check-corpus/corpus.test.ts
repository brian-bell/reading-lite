import { describe, expect, it } from "vitest";
import {
  annotateEntries,
  buildCorpusUrlSet,
  parseListIndex,
} from "../../../scripts/check-corpus-lib/corpus";

const LIST_JSON = JSON.stringify({
  version: 1,
  items: [
    { id: "rd_1", url: "https://a.example/post", status: "ready" },
    { id: "rd_2", url: "https://b.example/post", status: "pending" },
    { id: "rd_3", url: "https://c.example/post", status: "failed" },
    { id: "rd_4", url: "https://d.example/post", status: "ready" },
  ],
});

describe("parseListIndex", () => {
  it("extracts url + status pairs from a list.json payload", () => {
    const items = parseListIndex(LIST_JSON);
    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({ url: "https://a.example/post", status: "ready" });
  });

  it("rejects payloads without an items array", () => {
    expect(() => parseListIndex("{}")).toThrow(/items/);
    expect(() => parseListIndex("[]")).toThrow(/items/);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseListIndex("not json")).toThrow();
  });
});

describe("buildCorpusUrlSet", () => {
  it("includes only ready URLs by default", () => {
    const set = buildCorpusUrlSet(parseListIndex(LIST_JSON));
    expect(set.has("https://a.example/post")).toBe(true);
    expect(set.has("https://d.example/post")).toBe(true);
    expect(set.has("https://b.example/post")).toBe(false);
    expect(set.has("https://c.example/post")).toBe(false);
    expect(set.size).toBe(2);
  });

  it("honors an explicit status allow-list", () => {
    const set = buildCorpusUrlSet(parseListIndex(LIST_JSON), {
      statuses: ["ready", "pending", "failed"],
    });
    expect(set.size).toBe(4);
  });
});

describe("annotateEntries", () => {
  const corpus = new Set(["https://a.example/post", "https://d.example/post"]);

  it("sets processed true/false by exact URL membership", () => {
    const { entries, summary } = annotateEntries(
      [
        { title: "A", url: "https://a.example/post" },
        { title: "Z", url: "https://z.example/post" },
      ],
      corpus,
    );
    expect(entries[0]).toEqual({ title: "A", url: "https://a.example/post", processed: true });
    expect(entries[1]).toEqual({ title: "Z", url: "https://z.example/post", processed: false });
    expect(summary).toEqual({ total: 2, processed: 1, unprocessed: 1, missingUrl: 0 });
  });

  it("treats entries without a usable url as unprocessed", () => {
    const { entries, summary } = annotateEntries(
      [{ title: "no url" }, { title: "empty", url: "" }],
      corpus,
    );
    expect(entries[0].processed).toBe(false);
    expect(entries[1].processed).toBe(false);
    expect(summary.missingUrl).toBe(2);
    expect(summary.unprocessed).toBe(2);
  });

  it("preserves existing keys and overwrites a stale processed flag", () => {
    const { entries } = annotateEntries(
      [{ title: "A", url: "https://a.example/post", status: "READ", processed: false }],
      corpus,
    );
    expect(entries[0]).toEqual({
      title: "A",
      url: "https://a.example/post",
      status: "READ",
      processed: true,
    });
  });

  it("does not mutate the input entries", () => {
    const input = [{ url: "https://a.example/post" }];
    annotateEntries(input, corpus);
    expect(input[0]).toEqual({ url: "https://a.example/post" });
  });
});
