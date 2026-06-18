import { describe, expect, it } from "vitest";
import {
  classifyPending,
  dedupeByUrl,
  isNewsletterHost,
  isTeaser,
  shortUrl,
  siblingStatuses,
} from "../../../scripts/corpus-lib/classify";
import type { ListItem } from "../../../scripts/corpus-lib/types";

const item = (o: Partial<ListItem>): ListItem => ({
  id: "rd_x",
  url: "https://a.com/p",
  status: "pending",
  created_at: "2026-06-01T00:00:00.000Z",
  key_prefix: "readings/x",
  ...o,
});

describe("shortUrl", () => {
  it("strips scheme/www/trailing slash and truncates", () => {
    expect(shortUrl("https://www.example.com/a/b/")).toBe("example.com/a/b");
  });
});

describe("siblingStatuses + classifyPending", () => {
  it("marks pending as orphan-dup when the url also has a ready record", () => {
    const items = [
      item({ id: "rd_1", url: "https://a.com/dup", status: "pending" }),
      item({ id: "rd_2", url: "https://a.com/dup", status: "ready" }),
      item({ id: "rd_3", url: "https://a.com/solo", status: "pending" }),
    ];
    const sib = siblingStatuses(items);
    expect(classifyPending("https://a.com/dup", sib, true)).toBe("orphan-dup");
    expect(classifyPending("https://a.com/solo", sib, true)).toBe("stranded");
    expect(classifyPending("https://a.com/solo", sib, false)).toBe("fresh");
  });
});

describe("dedupeByUrl", () => {
  it("collapses by url, counts records, keeps newest as representative", () => {
    const out = dedupeByUrl([
      { url: "https://a.com/p", created_at: "2026-01-01T00:00:00.000Z", id: "old" },
      { url: "https://a.com/p", created_at: "2026-06-01T00:00:00.000Z", id: "new" },
      { url: "https://b.com/q", created_at: "2026-01-01T00:00:00.000Z", id: "b" },
    ]);
    expect(out).toHaveLength(2);
    const a = out.find((d) => d.rep.url === "https://a.com/p")!;
    expect(a.count).toBe(2);
    expect((a.rep as { id: string }).id).toBe("new");
  });
});

describe("isNewsletterHost", () => {
  it("matches pragmaticengineer and substack hosts", () => {
    expect(isNewsletterHost("https://newsletter.pragmaticengineer.com/p/x")).toBe(true);
    expect(isNewsletterHost("https://foo.substack.com/p/x")).toBe(true);
    expect(isNewsletterHost("https://example.com/x")).toBe(false);
  });
});

describe("isTeaser", () => {
  it("flags short content", () => {
    expect(isTeaser("a".repeat(400))).toBe(true);
  });
  it("flags short-ish content with a cutoff marker", () => {
    expect(isTeaser("x".repeat(3000) + "\nThis post is for paid subscribers")).toBe(true);
  });
  it("does NOT flag a full article that merely has a subscribe footer", () => {
    expect(isTeaser("x".repeat(20000) + "\nSubscribe now to get more")).toBe(false);
  });
});
