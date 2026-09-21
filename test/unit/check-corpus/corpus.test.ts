import { describe, expect, it } from "vitest";
import {
  annotateEntries,
  buildCorpusUrlSet,
} from "../../../scripts/check-corpus-lib/corpus";

// What the command's reading_urls lookup hands this module: one row per
// exported URL it found, with that reading's status.
const CORPUS_ITEMS = [
  { url: "https://a.example/post", status: "ready" },
  { url: "https://b.example/post", status: "pending" },
  { url: "https://c.example/post", status: "failed" },
  { url: "https://d.example/post", status: "ready" },
];

describe("buildCorpusUrlSet", () => {
  it("includes only ready URLs by default", () => {
    const set = buildCorpusUrlSet(CORPUS_ITEMS);
    expect(set.has("https://a.example/post")).toBe(true);
    expect(set.has("https://d.example/post")).toBe(true);
    expect(set.has("https://b.example/post")).toBe(false);
    expect(set.has("https://c.example/post")).toBe(false);
    expect(set.size).toBe(2);
  });

  it("honors an explicit status allow-list", () => {
    const set = buildCorpusUrlSet(CORPUS_ITEMS, {
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
