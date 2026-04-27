import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeBacklitRow } from "../../../scripts/migrate-lib/normalize";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const FETCHED = "2026-04-26T16:01:51Z";
const CREATED = "2026-04-26T16:02:36.038685Z";

function rawCaptured(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "bf_abc",
    url: "https://example.com/a",
    title: "T",
    tldr: "tldr",
    tags: ["t"],
    keywords: ["k"],
    people: ["p"],
    orgs: ["o"],
    novelty_verdict: "novel",
    connections: [{ reading_id: "bf_other", reason: "r" }],
    summary: "# md",
    embedding: new Array(1536).fill(0),
    content_type: "text/html; charset=utf-8",
    content_status: "captured",
    content_bytes: 1234,
    extracted_bytes: 567,
    content_sha256: "a".repeat(64),
    fetched_at: FETCHED,
    created_at: CREATED,
    ...over,
  };
}

describe("normalizeBacklitRow", () => {
  it("returns null for rows that never captured content", () => {
    expect(normalizeBacklitRow(rawCaptured({ content_status: "" }))).toBeNull();
    expect(normalizeBacklitRow(rawCaptured({ content_status: "raw_only" }))).toBeNull();
    expect(normalizeBacklitRow(rawCaptured({ content_status: "failed" }))).toBeNull();
  });

  it("computes url_hash as sha256(url)", () => {
    const row = normalizeBacklitRow(rawCaptured()) as Record<string, unknown>;
    expect(row.url_hash).toBe(sha256("https://example.com/a"));
  });

  it("falls back updated_at to created_at when missing", () => {
    const row = normalizeBacklitRow(rawCaptured()) as Record<string, unknown>;
    expect(row.updated_at).toBe(CREATED);
  });

  it("renames summary → summary_markdown", () => {
    const row = normalizeBacklitRow(rawCaptured({ summary: "## body" })) as Record<string, unknown>;
    expect(row.summary_markdown).toBe("## body");
    expect("summary" in row).toBe(false);
  });

  it("drops empty summary instead of forwarding it", () => {
    const row = normalizeBacklitRow(rawCaptured({ summary: "" })) as Record<string, unknown>;
    expect(row.summary_markdown).toBeUndefined();
  });

  it("remaps connections[].reading_id → id", () => {
    const row = normalizeBacklitRow(
      rawCaptured({
        connections: [
          { reading_id: "bf_one", reason: "r1" },
          { reading_id: "bf_two", reason: "r2" },
        ],
      }),
    ) as Record<string, unknown>;
    expect(row.connections).toEqual([
      { id: "bf_one", reason: "r1" },
      { id: "bf_two", reason: "r2" },
    ]);
  });

  it("drops connections that have no reading_id", () => {
    const row = normalizeBacklitRow(
      rawCaptured({
        connections: [
          { reading_id: "bf_one", reason: "r1" },
          { reason: "no id" },
        ],
      }),
    ) as Record<string, unknown>;
    expect(row.connections).toEqual([{ id: "bf_one", reason: "r1" }]);
  });

  it("coerces empty fetched_at to undefined", () => {
    const row = normalizeBacklitRow(rawCaptured({ fetched_at: "" })) as Record<string, unknown>;
    expect(row.fetched_at).toBeUndefined();
  });

  it("maps novelty_verdict 'extends_existing' to 'familiar'", () => {
    const row = normalizeBacklitRow(
      rawCaptured({ novelty_verdict: "extends_existing" }),
    ) as Record<string, unknown>;
    expect(row.novelty_verdict).toBe("familiar");
  });

  it("drops unrecognized novelty_verdict values", () => {
    const row = normalizeBacklitRow(
      rawCaptured({ novelty_verdict: "novel|extends_existing|duplicate" }),
    ) as Record<string, unknown>;
    expect(row.novelty_verdict).toBeUndefined();
  });

  it("drops empty novelty_verdict", () => {
    const row = normalizeBacklitRow(rawCaptured({ novelty_verdict: "" })) as Record<string, unknown>;
    expect(row.novelty_verdict).toBeUndefined();
  });

  it("preserves valid novelty_verdict values", () => {
    for (const v of ["novel", "familiar", "duplicate"] as const) {
      const row = normalizeBacklitRow(rawCaptured({ novelty_verdict: v })) as Record<string, unknown>;
      expect(row.novelty_verdict).toBe(v);
    }
  });
});
