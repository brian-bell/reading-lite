import { describe, expect, it } from "vitest";
import { SIMILARITY_FLOOR } from "../../../src/modules/stores/similarity-store";
import { diffNeighbourhood } from "../../../scripts/corpus-lib/refresh-neighbours";
import {
  buildRelationshipJudgementInput,
  isJudgedForReport,
  liveReportNeighbours,
  mergeRelationshipJudgement,
  parseRefreshConnectionsReport,
} from "../../../scripts/corpus-lib/refresh-connections";

const AT = "2026-08-31T12:00:00.000Z";
const LATER = "2026-08-31T12:01:00.000Z";

const manifest = (overrides: Record<string, unknown> = {}) => ({
  id: "rd_a",
  url: "https://example.com/a",
  url_hash: "a".repeat(64),
  status: "ready",
  title: "A",
  tldr: "Summary A",
  tags: ["x"],
  keywords: ["one", "two", "three"],
  people: [],
  orgs: [],
  novelty_verdict: "familiar",
  connections: [
    { id: "rd_b", reason: "old exact reason" },
    { id: "rd_old", reason: "not reaffirmed" },
  ],
  summary_markdown: "Stored summary A.",
  content_type: "text/html",
  content_status: "captured",
  content_bytes: 10,
  content_sha256: "b".repeat(64),
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-02-01T00:00:00.000Z",
  usage: {
    anthropic_input_tokens: 1,
    anthropic_output_tokens: 2,
    openai_embedding_tokens: 3,
  },
  future_field: { keep: [1, 2, 3] },
  ...overrides,
});

const report = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  generated_at: AT,
  tenant: "global",
  floor: SIMILARITY_FLOOR,
  readings: [
    {
      id: "rd_a",
      key_prefix: "readings/2026/a-rd_a",
      url: "https://example.com/a",
      reasons: ["new_neighbour"],
      novelty_verdict: "familiar",
      connections: [{ id: "rd_b", reason: "old exact reason" }],
      current_neighbours: [
        { id: "rd_b", score: 0.9, title: "B", tldr: "Summary B" },
        { id: "rd_missing", score: 0.8, title: "Gone" },
      ],
    },
  ],
  ...overrides,
});

describe("refresh-connections report", () => {
  it("parses the slice-1 contract for the selected tenant", () => {
    expect(parseRefreshConnectionsReport(report(), "global").readings).toHaveLength(1);
  });

  it("rejects tenant, floor, and duplicate-target mismatches", () => {
    expect(() => parseRefreshConnectionsReport(report(), "usr_other")).toThrow(/tenant/);
    expect(() =>
      parseRefreshConnectionsReport(report({ floor: SIMILARITY_FLOOR + 0.1 }), "global"),
    ).toThrow(/floor/);
    const duplicate = report();
    duplicate.readings.push({ ...duplicate.readings[0]! });
    expect(() => parseRefreshConnectionsReport(duplicate, "global")).toThrow(/duplicate/);
  });
});

describe("relationship planning", () => {
  it("drops self, missing, non-ready, and duplicate report neighbours", () => {
    const parsed = parseRefreshConnectionsReport(report(), "global");
    const reading = {
      ...parsed.readings[0]!,
      current_neighbours: [
        { id: "rd_a", score: 1 },
        { id: "rd_b", score: 0.9 },
        { id: "rd_b", score: 0.8 },
        { id: "rd_missing", score: 0.7 },
      ],
    };
    expect(liveReportNeighbours(reading, new Set(["rd_a", "rd_b"]))).toEqual([
      { id: "rd_b", score: 0.9 },
    ]);
  });

  it("builds the target from stored summary fields and report neighbours", () => {
    const reading = parseRefreshConnectionsReport(report(), "global").readings[0]!;
    const neighbours = liveReportNeighbours(reading, new Set(["rd_a", "rd_b"]));
    expect(buildRelationshipJudgementInput(manifest(), reading, neighbours)).toEqual({
      reading: {
        id: "rd_a",
        url: "https://example.com/a",
        title: "A",
        tldr: "Summary A",
        tags: ["x"],
        summary_markdown: "Stored summary A.",
      },
      similarReadings: [
        { id: "rd_b", score: 0.9, title: "B", tldr: "Summary B" },
      ],
    });
  });

  it("uses connections_computed_at as a resume marker", () => {
    expect(isJudgedForReport({ connections_computed_at: LATER }, AT)).toBe(true);
    expect(isJudgedForReport({ connections_computed_at: AT }, AT)).toBe(true);
    expect(isJudgedForReport({ connections_computed_at: "2026-08-30T00:00:00Z" }, AT)).toBe(false);
  });
});

describe("mergeRelationshipJudgement", () => {
  it("drops hallucinated, missing, duplicate, and self ids", () => {
    const out = mergeRelationshipJudgement(
      manifest(),
      {
        novelty_verdict: "familiar",
        connections: [
          { id: "rd_a", reason: "self" },
          { id: "rd_hallucinated", reason: "unknown" },
          { id: "rd_missing", reason: "deleted" },
          { id: "rd_c", reason: "new" },
          { id: "rd_c", reason: "duplicate" },
        ],
      },
      new Set(["rd_b", "rd_c"]),
      LATER,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.manifest.connections).toEqual([{ id: "rd_c", reason: "new" }]);
    }
  });

  it("preserves the exact prior object when reaffirmed and drops omitted old relationships", () => {
    const prior = manifest();
    const exact = prior.connections[0];
    const out = mergeRelationshipJudgement(
      prior,
      {
        novelty_verdict: "duplicate",
        connections: [{ id: "rd_b", reason: "new generated wording" }],
      },
      new Set(["rd_b"]),
      LATER,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((out.manifest.connections as unknown[])[0]).toBe(exact);
      expect(out.manifest.connections).toEqual([{ id: "rd_b", reason: "old exact reason" }]);
      expect(out.manifest.novelty_verdict).toBe("duplicate");
      expect(out.manifest.connections_computed_at).toBe(LATER);
    }
  });

  it("preserves every unrelated known and unknown value", () => {
    const before: Record<string, unknown> = manifest();
    const out = mergeRelationshipJudgement(
      before,
      { novelty_verdict: "novel", connections: [] },
      new Set(),
      LATER,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const {
      connections: _beforeConnections,
      novelty_verdict: _beforeVerdict,
      connections_computed_at: _beforeAt,
      ...beforeRest
    } = before;
    const {
      connections: _afterConnections,
      novelty_verdict: _afterVerdict,
      connections_computed_at: _afterAt,
      ...afterRest
    } = out.manifest;
    expect(afterRest).toEqual(beforeRest);
    expect(out.manifest.updated_at).toBe(before.updated_at);
    expect(out.manifest.future_field).toBe(before.future_field);
  });

  it("makes the next neighbour diff clean until a newer neighbour appears", () => {
    const out = mergeRelationshipJudgement(
      manifest(),
      {
        novelty_verdict: "familiar",
        connections: [{ id: "rd_b", reason: "reaffirm" }],
      },
      new Set(["rd_b"]),
      LATER,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(
      diffNeighbourhood(
        out.manifest as never,
        [{ id: "rd_b", score: 0.9, created_at: "2026-01-02T00:00:00.000Z" }],
        [
          { id: "rd_a", status: "ready", created_at: "2026-01-01T00:00:00.000Z" },
          { id: "rd_b", status: "ready", created_at: "2026-01-02T00:00:00.000Z" },
        ],
        LATER,
      ),
    ).toEqual([]);
  });
});
