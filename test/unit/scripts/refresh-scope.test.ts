import { describe, expect, it } from "vitest";
import {
  REVERSE_SCORE_BOUND,
  REVERSE_TOP_K,
  buildRefreshState,
  changedSince,
  describeScope,
  incrementalScope,
  parseRefreshState,
  type RefreshState,
  type ReverseMatches,
} from "../../../scripts/corpus-lib/refresh-scope";
import type { RefreshRow } from "../../../scripts/corpus-lib/refresh-neighbours";

const LAST_RUN = "2026-08-20T00:00:00.000Z";
const BEFORE = "2026-08-10T00:00:00.000Z";
const AFTER = "2026-08-21T00:00:00.000Z";

function row(id: string, over: Partial<RefreshRow> = {}): RefreshRow {
  return {
    id,
    url: `https://example.com/${id}`,
    status: "ready",
    key_prefix: `readings/${id}`,
    created_at: BEFORE,
    updated_at: BEFORE,
    ...over,
  };
}

function marker(over: Partial<RefreshState> = {}): RefreshState {
  return { version: 1, last_run_at: LAST_RUN, list_row_count: 0, ...over };
}

function reverse(entries: Record<string, ReverseMatches>): Map<string, ReverseMatches> {
  return new Map(Object.entries(entries));
}

describe("parseRefreshState", () => {
  it("round-trips a state it built", () => {
    const built = buildRefreshState({
      previous: null,
      runAt: LAST_RUN,
      full: true,
      listRowCount: 553,
      listEtag: "abc123",
    });
    expect(built).toEqual({
      version: 1,
      last_run_at: LAST_RUN,
      last_full_run_at: LAST_RUN,
      list_row_count: 553,
      list_etag: "abc123",
    });
    expect(parseRefreshState(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  it("carries last_full_run_at across an incremental run and omits an absent etag", () => {
    const previous = marker({ last_full_run_at: BEFORE });
    const built = buildRefreshState({
      previous,
      runAt: AFTER,
      full: false,
      listRowCount: 4,
    });
    expect(built).toEqual({
      version: 1,
      last_run_at: AFTER,
      last_full_run_at: BEFORE,
      list_row_count: 4,
    });
  });

  it("rejects anything it cannot trust", () => {
    expect(parseRefreshState(null)).toBeNull();
    expect(parseRefreshState("{}")).toBeNull();
    expect(parseRefreshState([])).toBeNull();
    expect(parseRefreshState({ version: 2, last_run_at: LAST_RUN, list_row_count: 1 })).toBeNull();
    expect(parseRefreshState({ version: 1, last_run_at: "nonsense", list_row_count: 1 })).toBeNull();
    expect(parseRefreshState({ version: 1, last_run_at: LAST_RUN })).toBeNull();
    expect(parseRefreshState({ version: 1, last_run_at: LAST_RUN, list_row_count: -1 })).toBeNull();
    expect(parseRefreshState({ version: 1, last_run_at: LAST_RUN, list_row_count: 1.5 })).toBeNull();
  });

  it("drops an unusable last_full_run_at rather than the whole marker", () => {
    const parsed = parseRefreshState({
      version: 1,
      last_run_at: LAST_RUN,
      list_row_count: 2,
      last_full_run_at: "not a date",
      list_etag: "",
    });
    expect(parsed).toEqual({ version: 1, last_run_at: LAST_RUN, list_row_count: 2 });
  });
});

describe("incrementalScope", () => {
  it("escalates to full when there is no marker", () => {
    const scope = incrementalScope([row("rd_a")], null, reverse({}));
    expect(scope).toEqual({ kind: "full", reason: "no usable run marker" });
  });

  it("escalates to full when rows were removed since the marker", () => {
    const scope = incrementalScope([row("rd_a")], marker({ list_row_count: 3 }), reverse({}));
    expect(scope).toEqual({ kind: "full", reason: "2 list row(s) removed since the last run" });
  });

  it("takes a reading created since the marker into scope", () => {
    const list = [row("rd_old"), row("rd_new", { created_at: AFTER, updated_at: AFTER })];
    const scope = incrementalScope(
      list,
      marker({ list_row_count: 2 }),
      reverse({ rd_new: [] }),
    );
    expect(scope).toMatchObject({ kind: "incremental", ids: ["rd_new"], changed: ["rd_new"] });
  });

  it("takes a reading reprocessed since the marker into scope", () => {
    const list = [row("rd_old"), row("rd_redone", { updated_at: AFTER })];
    const scope = incrementalScope(
      list,
      marker({ list_row_count: 2 }),
      reverse({ rd_redone: [] }),
    );
    expect(scope).toMatchObject({ kind: "incremental", ids: ["rd_redone"] });
  });

  it("takes a row with no usable timestamps into scope", () => {
    const list = [row("rd_undated", { created_at: undefined, updated_at: undefined })];
    const scope = incrementalScope(
      list,
      marker({ list_row_count: 1 }),
      reverse({ rd_undated: null }),
    );
    expect(scope).toMatchObject({ kind: "incremental", ids: ["rd_undated"] });
  });

  it("takes a changed row of any status into scope, so its citers are found", () => {
    const list = [
      row("rd_gone", { status: "failed", updated_at: AFTER }),
      row("rd_citer", { connections: [{ id: "rd_gone", reason: "why" }] }),
    ];
    const scope = incrementalScope(
      list,
      marker({ list_row_count: 2 }),
      reverse({ rd_gone: null }),
    );
    expect(scope).toMatchObject({ kind: "incremental", ids: ["rd_citer", "rd_gone"] });
  });

  it("takes citers through connections, tensions and the judged neighbourhood", () => {
    const list = [
      row("rd_new", { created_at: AFTER, updated_at: AFTER }),
      row("rd_conn", { connections: [{ id: "rd_new", reason: "why" }] }),
      row("rd_tension", { tensions: [{ id: "rd_new" }] }),
      row("rd_judged", { connections_neighbourhood_ids: ["rd_new"] }),
      row("rd_unrelated"),
    ];
    const scope = incrementalScope(list, marker({ list_row_count: 5 }), reverse({ rd_new: [] }));
    expect(scope).toMatchObject({
      kind: "incremental",
      ids: ["rd_conn", "rd_judged", "rd_new", "rd_tension"],
    });
  });

  it("takes reverse matches at or above the bound and drops the rest", () => {
    const list = [
      row("rd_new", { created_at: AFTER, updated_at: AFTER }),
      row("rd_near"),
      row("rd_edge"),
      row("rd_far"),
    ];
    const scope = incrementalScope(
      list,
      marker({ list_row_count: 4 }),
      reverse({
        rd_new: [
          { id: "rd_new", score: 1 },
          { id: "rd_near", score: 0.8 },
          { id: "rd_edge", score: REVERSE_SCORE_BOUND },
          { id: "rd_far", score: REVERSE_SCORE_BOUND - 0.0001 },
        ],
      }),
    );
    expect(scope).toMatchObject({ kind: "incremental", ids: ["rd_edge", "rd_near", "rd_new"] });
  });

  it("drops a reverse match that is not in the list index", () => {
    const list = [row("rd_new", { created_at: AFTER, updated_at: AFTER })];
    const scope = incrementalScope(
      list,
      marker({ list_row_count: 1 }),
      reverse({ rd_new: [{ id: "rd_purged", score: 0.9 }] }),
    );
    expect(scope).toMatchObject({ kind: "incremental", ids: ["rd_new"] });
  });

  it("escalates to full when a reverse query saturated at topK above the bound", () => {
    const matches = Array.from({ length: REVERSE_TOP_K }, (_, i) => ({
      id: `rd_${i}`,
      score: 0.9 - i * 0.001,
    }));
    const scope = incrementalScope(
      [row("rd_new", { created_at: AFTER, updated_at: AFTER })],
      marker({ list_row_count: 1 }),
      reverse({ rd_new: matches }),
    );
    expect(scope.kind).toBe("full");
    expect((scope as { reason: string }).reason).toContain("saturated");
  });

  it("does not escalate when the topK-th match has fallen below the bound", () => {
    const matches = Array.from({ length: REVERSE_TOP_K }, (_, i) => ({
      id: `rd_${i}`,
      score: i === REVERSE_TOP_K - 1 ? REVERSE_SCORE_BOUND - 0.01 : 0.9,
    }));
    const scope = incrementalScope(
      [row("rd_new", { created_at: AFTER, updated_at: AFTER })],
      marker({ list_row_count: 1 }),
      reverse({ rd_new: matches }),
    );
    expect(scope.kind).toBe("incremental");
  });

  it("escalates to full when a changed reading has no reverse-neighbour result", () => {
    const scope = incrementalScope(
      [row("rd_new", { created_at: AFTER, updated_at: AFTER })],
      marker({ list_row_count: 1 }),
      reverse({}),
    );
    expect(scope).toEqual({
      kind: "full",
      reason: "no reverse-neighbour result for rd_new",
    });
  });

  it("scopes nothing when the list index is byte-identical to the marker's", () => {
    const list = [row("rd_a", { updated_at: AFTER }), row("rd_b")];
    const scope = incrementalScope(
      list,
      marker({ list_row_count: 2, list_etag: "same" }),
      reverse({}),
      "same",
    );
    expect(scope).toMatchObject({
      kind: "incremental",
      ids: [],
      reason: "index/list.json unchanged since the last run",
    });
  });

  it("ignores a differing etag and falls back to the timestamps", () => {
    const list = [row("rd_a", { updated_at: AFTER }), row("rd_b")];
    const scope = incrementalScope(
      list,
      marker({ list_row_count: 2, list_etag: "old" }),
      reverse({ rd_a: [] }),
      "new",
    );
    expect(scope).toMatchObject({ kind: "incremental", ids: ["rd_a"] });
  });
});

describe("changedSince", () => {
  it("hands the command the same changed ids the scope is derived from", () => {
    const list = [row("rd_a", { updated_at: AFTER }), row("rd_b")];
    const base = changedSince(list, marker({ list_row_count: 2 }));
    expect(base).toEqual({
      kind: "incremental",
      since: LAST_RUN,
      changed: ["rd_a"],
      listUnchanged: false,
    });
  });
});

describe("describeScope", () => {
  it("names the reason on both branches", () => {
    expect(describeScope({ kind: "full", reason: "no usable run marker" })).toBe(
      "Scope: full — no usable run marker",
    );
    expect(
      describeScope({
        kind: "incremental",
        reason: "1 reading(s) changed since " + LAST_RUN,
        since: LAST_RUN,
        ids: ["rd_a"],
        changed: ["rd_a"],
      }),
    ).toBe(`Scope: incremental (1 reading(s)) — 1 reading(s) changed since ${LAST_RUN}`);
  });
});
