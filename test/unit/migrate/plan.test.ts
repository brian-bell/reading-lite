import { describe, expect, it } from "vitest";
import {
  mapRowToManifest,
  planReading,
  extFromContentType,
  type BacklitRow,
} from "../../../scripts/migrate-lib/plan";

const baseRow: BacklitRow = {
  id: "rd_abc",
  url: "https://example.com/a",
  url_hash: "a".repeat(64),
  title: "Title",
  tldr: "Short summary.",
  tags: ["t1"],
  keywords: ["k1"],
  people: [],
  orgs: [],
  novelty_verdict: "novel",
  connections: [],
  summary_markdown: "body",
  embedding: new Array(1536).fill(0.1),
  content_type: "text/html",
  content_status: "captured",
  content_bytes: 1234,
  extracted_bytes: 567,
  content_sha256: "b".repeat(64),
  fetched_at: "2026-04-25T20:00:00.000Z",
  created_at: "2026-04-25T20:00:00.000Z",
  updated_at: "2026-04-25T20:00:01.000Z",
};

describe("mapRowToManifest", () => {
  it("maps a fully populated row to a ready manifest", () => {
    const m = mapRowToManifest(baseRow);
    expect(m.status).toBe("ready");
    expect(m.id).toBe(baseRow.id);
    expect(m.title).toBe("Title");
    expect(m.tldr).toBe("Short summary.");
    expect(m.novelty_verdict).toBe("novel");
    expect(m.usage).toBeUndefined();
  });

  it("omits null optional fields rather than persisting them as null", () => {
    const row = { ...baseRow, title: null, fetched_at: null, extracted_bytes: null };
    const m = mapRowToManifest(row);
    expect("title" in m).toBe(false);
    expect("fetched_at" in m).toBe(false);
    expect("extracted_bytes" in m).toBe(false);
  });

  it("rejects a row with an invalid url_hash", () => {
    const bad = { ...baseRow, url_hash: "abc" };
    expect(() => mapRowToManifest(bad)).toThrow();
  });
});

describe("planReading", () => {
  it("computes a sortable key prefix and the right raw extension", () => {
    const planned = planReading(baseRow);
    expect(planned.keyPrefix).toMatch(/^readings\/2026\/04\/25T200000Z-rd_abc$/);
    expect(planned.rawExt).toBe("html");
    expect(planned.embedding).toHaveLength(1536);
  });
});

describe("extFromContentType", () => {
  it.each([
    ["text/html; charset=utf-8", "html"],
    ["application/xhtml+xml", "html"],
    ["application/pdf", "pdf"],
    ["application/json", "json"],
    ["text/plain", "txt"],
    ["text/markdown", "txt"],
    ["application/octet-stream", "bin"],
  ])("maps %s → %s", (input, expected) => {
    expect(extFromContentType(input)).toBe(expected);
  });
});
