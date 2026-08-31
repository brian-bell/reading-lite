import { describe, expect, it } from "vitest";
import { SIMILARITY_FLOOR } from "../../../src/modules/stores/similarity-store";
import {
  SNAPSHOT_CHANGE_EPSILON,
  buildRefreshReport,
  buildReportReading,
  diffNeighbourhood,
  flooredNeighbours,
  planRefresh,
  resolveJudgedAt,
  resolveNeighbourCreatedAt,
  snapshotChanged,
  type RefreshRow,
} from "../../../scripts/corpus-lib/refresh-neighbours";

const AT = "2026-08-01T00:00:00.000Z";
const LATER = "2026-08-20T00:00:00.000Z";
const EARLIER = "2026-07-01T00:00:00.000Z";

const row = (o: Partial<RefreshRow> = {}): RefreshRow => ({
  id: "rd_a",
  url: "https://a.example/x",
  status: "ready",
  key_prefix: "readings/rd_a",
  created_at: AT,
  updated_at: AT,
  ...o,
});

const list = (
  rows: Array<{ id: string; status?: string; created_at?: string }> = [{ id: "rd_a", created_at: AT }],
) => rows.map((r) => ({ id: r.id, status: r.status ?? "ready", created_at: r.created_at ?? AT }));

describe("planRefresh", () => {
  it("selects ready readings, including those that already carry a snapshot", () => {
    const plan = planRefresh([
      row({ id: "rd_1" }),
      row({ id: "rd_2", similarity: { count: 1, max: 0.7, mean: 0.7, computed_at: AT } }),
    ]);
    expect(plan.targets.map((t) => t.id)).toEqual(["rd_1", "rd_2"]);
    expect(plan.skippedNotReady).toBe(0);
  });

  it("skips non-ready readings, which own no vector", () => {
    const plan = planRefresh([row({ id: "rd_ok" }), row({ id: "rd_bad", status: "failed" })]);
    expect(plan.targets.map((t) => t.id)).toEqual(["rd_ok"]);
    expect(plan.skippedNotReady).toBe(1);
  });

  it("can be limited to named ids", () => {
    const plan = planRefresh([row({ id: "rd_1" }), row({ id: "rd_2" })], { only: ["rd_2"] });
    expect(plan.targets.map((t) => t.id)).toEqual(["rd_2"]);
  });

  it("caps how many ready readings are targeted", () => {
    const plan = planRefresh(
      [row({ id: "rd_1" }), row({ id: "rd_2" }), row({ id: "rd_3" })],
      { limit: 2 },
    );
    expect(plan.targets.map((t) => t.id)).toEqual(["rd_1", "rd_2"]);
  });

  it("applies --only before --limit", () => {
    const plan = planRefresh(
      [row({ id: "rd_1" }), row({ id: "rd_2" }), row({ id: "rd_3" })],
      { only: ["rd_2", "rd_3"], limit: 1 },
    );
    expect(plan.targets.map((t) => t.id)).toEqual(["rd_2"]);
  });
});

describe("resolveJudgedAt", () => {
  it("prefers connections_computed_at over last_attempt and updated_at", () => {
    expect(
      resolveJudgedAt(
        row({
          connections_computed_at: LATER,
          last_attempt: { status: "succeeded", finished_at: AT },
          updated_at: EARLIER,
        }),
      ),
    ).toEqual({ judged_at: LATER, judged_at_source: "connections_computed_at" });
  });

  it("falls back to a successful last_attempt finished_at", () => {
    expect(
      resolveJudgedAt(
        row({
          last_attempt: { status: "succeeded", finished_at: AT },
          updated_at: EARLIER,
        }),
      ),
    ).toEqual({ judged_at: AT, judged_at_source: "last_attempt" });
  });

  it("skips a failed last_attempt and uses updated_at", () => {
    expect(
      resolveJudgedAt(
        row({
          last_attempt: { status: "failed", finished_at: LATER },
          updated_at: AT,
        }),
      ),
    ).toEqual({ judged_at: AT, judged_at_source: "updated_at" });
  });

  it("falls back to updated_at when there is no successful attempt", () => {
    expect(resolveJudgedAt(row({ updated_at: AT }))).toEqual({
      judged_at: AT,
      judged_at_source: "updated_at",
    });
  });

  it("returns empty when no judgement timestamp is resolvable", () => {
    expect(resolveJudgedAt(row({ updated_at: undefined, created_at: AT }))).toEqual({});
  });
});

describe("snapshotChanged", () => {
  const snap = {
    count: 2,
    max: 0.7,
    mean: 0.6,
    computed_at: AT,
  };

  it("treats a missing stored snapshot as changed", () => {
    expect(snapshotChanged(undefined, snap)).toBe(true);
  });

  it("flags a count change", () => {
    expect(snapshotChanged(snap, { ...snap, count: 1 })).toBe(true);
  });

  it("flags |Δmax| at the epsilon", () => {
    expect(snapshotChanged(snap, { ...snap, max: snap.max! + SNAPSHOT_CHANGE_EPSILON })).toBe(true);
  });

  it("ignores a max move below the epsilon", () => {
    expect(snapshotChanged(snap, { ...snap, max: snap.max! + SNAPSHOT_CHANGE_EPSILON / 2 })).toBe(false);
  });

  it("flags |Δmean| at the epsilon", () => {
    expect(snapshotChanged(snap, { ...snap, mean: snap.mean! + SNAPSHOT_CHANGE_EPSILON })).toBe(true);
  });

  it("ignores a mean move below the epsilon", () => {
    expect(snapshotChanged(snap, { ...snap, mean: snap.mean! + SNAPSHOT_CHANGE_EPSILON / 2 })).toBe(false);
  });

  it("does not treat computed_at drift as a change", () => {
    expect(snapshotChanged(snap, { ...snap, computed_at: LATER })).toBe(false);
  });

  it("does not flag two empty neighbourhoods", () => {
    expect(
      snapshotChanged({ count: 0, computed_at: AT }, { count: 0, computed_at: LATER }),
    ).toBe(false);
  });

  it("flags a neighbourhood that gained a score", () => {
    expect(
      snapshotChanged({ count: 0, computed_at: AT }, { count: 1, max: 0.7, mean: 0.7, computed_at: LATER }),
    ).toBe(true);
  });
});

describe("diffNeighbourhood", () => {
  const readyList = list([
    { id: "rd_a", created_at: AT },
    { id: "rd_b", created_at: LATER },
    { id: "rd_c", created_at: EARLIER },
  ]);

  it("flags stale_connection when a stored connection cites a missing id", () => {
    const flags = diffNeighbourhood(
      row({
        connections: [{ id: "rd_gone", reason: "was related" }],
        novelty_verdict: "familiar",
      }),
      [{ id: "rd_a", score: 1 }, { id: "rd_b", score: 0.7 }],
      readyList,
      AT,
    );
    expect(flags).toContain("stale_connection");
  });

  it("flags stale_connection when a tension cites a non-ready id (forward-compatible)", () => {
    const flags = diffNeighbourhood(
      row({
        tensions: [{ id: "rd_dropped" }],
        novelty_verdict: "familiar",
        connections: [{ id: "rd_b", reason: "related" }],
      }),
      [{ id: "rd_a", score: 1 }, { id: "rd_b", score: 0.7 }],
      [...readyList, { id: "rd_dropped", status: "failed", created_at: AT }],
      AT,
    );
    expect(flags).toEqual(["stale_connection"]);
  });

  it("does not flag stale_connection when every citation is still ready", () => {
    const flags = diffNeighbourhood(
      row({
        connections: [{ id: "rd_b", reason: "related" }],
        novelty_verdict: "familiar",
      }),
      [{ id: "rd_a", score: 1 }, { id: "rd_b", score: 0.7 }],
      readyList,
      LATER,
    );
    expect(flags).not.toContain("stale_connection");
  });

  it("flags connection_below_floor when a still-ready cited reading leaves the floored neighbourhood", () => {
    const flags = diffNeighbourhood(
      row({
        connections: [{ id: "rd_b", reason: "was related" }],
      }),
      [
        { id: "rd_a", score: 1 },
        { id: "rd_b", score: SIMILARITY_FLOOR - 0.01 },
      ],
      readyList,
      LATER,
    );

    expect(flags).toEqual(["connection_below_floor"]);
  });

  it("flags new_neighbour when an uncited floored neighbour postdates judged_at", () => {
    const flags = diffNeighbourhood(
      row({
        connections: [],
        novelty_verdict: "familiar",
      }),
      [{ id: "rd_a", score: 1 }, { id: "rd_b", score: 0.7, created_at: LATER }],
      readyList,
      AT,
    );
    expect(flags).toContain("new_neighbour");
  });

  it("does not flag new_neighbour for an uncited neighbour that predates judgement", () => {
    const flags = diffNeighbourhood(
      row({
        connections: [],
        novelty_verdict: "familiar",
      }),
      [{ id: "rd_a", score: 1 }, { id: "rd_c", score: 0.7, created_at: EARLIER }],
      readyList,
      AT,
    );
    expect(flags).not.toContain("new_neighbour");
  });

  it("flags uncited_neighbour when an older reading later enters the floored neighbourhood", () => {
    const flags = diffNeighbourhood(
      row({ connections: [], novelty_verdict: "familiar" }),
      [
        { id: "rd_a", score: 1 },
        { id: "rd_c", score: SIMILARITY_FLOOR + 0.01, created_at: EARLIER },
      ],
      readyList,
      AT,
    );

    expect(flags).toEqual(["uncited_neighbour"]);
  });

  it("does not flag a later refresh after connections match the current floored ready-neighbourhood", () => {
    const flags = diffNeighbourhood(
      row({
        connections: [{ id: "rd_c", reason: "now judged" }],
        novelty_verdict: "familiar",
        connections_computed_at: LATER,
      }),
      [
        { id: "rd_a", score: 1 },
        { id: "rd_c", score: SIMILARITY_FLOOR + 0.01, created_at: EARLIER },
      ],
      readyList,
      LATER,
    );

    expect(flags).toEqual([]);
  });

  it("excludes non-ready vector matches from the current floored neighbourhood", () => {
    const flags = diffNeighbourhood(
      row({ connections: [], novelty_verdict: "novel" }),
      [{ id: "rd_a", score: 1 }, { id: "rd_failed", score: 0.9, created_at: LATER }],
      [...readyList, { id: "rd_failed", status: "failed", created_at: LATER }],
      AT,
    );

    expect(flags).toEqual([]);
  });

  it("does not flag new_neighbour when the new neighbour is already cited", () => {
    const flags = diffNeighbourhood(
      row({
        connections: [{ id: "rd_b", reason: "already judged" }],
        novelty_verdict: "familiar",
      }),
      [{ id: "rd_a", score: 1 }, { id: "rd_b", score: 0.7, created_at: LATER }],
      readyList,
      AT,
    );
    expect(flags).not.toContain("new_neighbour");
  });

  it("treats a neighbour with no resolvable created_at as new", () => {
    const flags = diffNeighbourhood(
      row({
        connections: [],
        novelty_verdict: "familiar",
      }),
      [{ id: "rd_a", score: 1 }, { id: "rd_unknown", score: 0.8 }],
      [...readyList, { id: "rd_unknown", status: "ready" }],
      AT,
    );
    expect(flags).toContain("new_neighbour");
  });

  it("falls back to the list-row created_at when vector metadata omits it", () => {
    expect(
      resolveNeighbourCreatedAt({ id: "rd_b", score: 0.7 }, new Map([["rd_b", LATER]])),
    ).toBe(LATER);
    const flags = diffNeighbourhood(
      row({ connections: [], novelty_verdict: "familiar" }),
      [{ id: "rd_a", score: 1 }, { id: "rd_b", score: 0.7 }],
      readyList,
      AT,
    );
    expect(flags).toContain("new_neighbour");
  });

  it("flags new_neighbour conservatively when judged_at is missing", () => {
    const flags = diffNeighbourhood(
      row({ connections: [], novelty_verdict: "familiar", updated_at: undefined }),
      [{ id: "rd_a", score: 1 }, { id: "rd_c", score: 0.7, created_at: EARLIER }],
      readyList,
      undefined,
    );
    expect(flags).toContain("new_neighbour");
  });

  it("does not flag a below-floor neighbour as new", () => {
    const flags = diffNeighbourhood(
      row({ connections: [], novelty_verdict: "novel" }),
      [{ id: "rd_a", score: 1 }, { id: "rd_b", score: SIMILARITY_FLOOR - 0.1, created_at: LATER }],
      readyList,
      AT,
    );
    expect(flags).not.toContain("new_neighbour");
  });

  it("flags verdict_inconsistent when novel has a floored neighbour", () => {
    const flags = diffNeighbourhood(
      row({
        connections: [{ id: "rd_b", reason: "related" }],
        novelty_verdict: "novel",
      }),
      [{ id: "rd_a", score: 1 }, { id: "rd_b", score: 0.7, created_at: EARLIER }],
      readyList,
      LATER,
    );
    expect(flags).toEqual(["verdict_inconsistent"]);
  });

  it("flags verdict_inconsistent when familiar has an empty floored neighbourhood", () => {
    const flags = diffNeighbourhood(
      row({ novelty_verdict: "familiar" }),
      [{ id: "rd_a", score: 1 }, { id: "rd_b", score: SIMILARITY_FLOOR - 0.2, created_at: EARLIER }],
      readyList,
      LATER,
    );
    expect(flags).toEqual(["verdict_inconsistent"]);
  });

  it("flags verdict_inconsistent when duplicate has an empty floored neighbourhood", () => {
    const flags = diffNeighbourhood(
      row({ novelty_verdict: "duplicate" }),
      [{ id: "rd_a", score: 1 }],
      readyList,
      AT,
    );
    expect(flags).toEqual(["verdict_inconsistent"]);
  });

  it("does not flag a missing novelty_verdict as inconsistent", () => {
    const flags = diffNeighbourhood(
      row({ novelty_verdict: undefined }),
      [{ id: "rd_a", score: 1 }, { id: "rd_b", score: 0.7, created_at: EARLIER }],
      readyList,
      LATER,
    );
    expect(flags).not.toContain("verdict_inconsistent");
  });

  it("can report every flag reason on one reading", () => {
    const flags = diffNeighbourhood(
      row({
        connections: [{ id: "rd_gone", reason: "dropped" }],
        novelty_verdict: "novel",
      }),
      [{ id: "rd_a", score: 1 }, { id: "rd_b", score: 0.8, created_at: LATER }],
      readyList,
      AT,
    );
    expect(flags).toEqual(["stale_connection", "new_neighbour", "verdict_inconsistent"]);
  });
});

describe("flooredNeighbours", () => {
  it("drops self and neighbours below the floor", () => {
    const out = flooredNeighbours("rd_a", [
      { id: "rd_a", score: 0.99 },
      { id: "rd_b", score: 0.7 },
      { id: "rd_far", score: 0.1 },
    ]);
    expect(out.map((n) => n.id)).toEqual(["rd_b"]);
  });
});

describe("buildRefreshReport", () => {
  it("stamps the tier-two contract envelope", () => {
    const reading = row({
      novelty_verdict: "familiar",
      connections: [{ id: "rd_b", reason: "related" }],
    });
    const judged = resolveJudgedAt(reading);
    const reportReading = buildReportReading(
      reading,
      [{ id: "rd_a", score: 1 }, { id: "rd_b", score: 0.72, title: "B", tldr: "about b", created_at: LATER }],
      list([{ id: "rd_a" }, { id: "rd_b", created_at: LATER }]),
      ["new_neighbour"],
      judged,
    );
    const report = buildRefreshReport({
      generatedAt: LATER,
      tenant: "global",
      readings: [reportReading],
    });
    expect(report).toEqual({
      version: 1,
      generated_at: LATER,
      tenant: "global",
      floor: SIMILARITY_FLOOR,
      readings: [
        {
          id: "rd_a",
          key_prefix: "readings/rd_a",
          url: "https://a.example/x",
          reasons: ["new_neighbour"],
          novelty_verdict: "familiar",
          connections: [{ id: "rd_b", reason: "related" }],
          judged_at: AT,
          judged_at_source: "updated_at",
          current_neighbours: [
            { id: "rd_b", score: 0.72, title: "B", tldr: "about b", created_at: LATER },
          ],
        },
      ],
    });
  });
});
