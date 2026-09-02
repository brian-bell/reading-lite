import { describe, expect, it } from "vitest";
import {
  MARKER_CLOCK_SKEW_MS,
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
      // An isolated reading: the only match is itself. A short result is a
      // complete one, so this must not read as a truncated neighbourhood.
      reverse({ rd_new: [{ id: "rd_new", score: 1 }] }),
    );
    expect(scope).toMatchObject({ kind: "incremental", ids: ["rd_new"], changed: ["rd_new"] });
  });

  it("takes a reading reprocessed since the marker into scope", () => {
    const list = [row("rd_old"), row("rd_redone", { updated_at: AFTER })];
    const scope = incrementalScope(
      list,
      marker({ list_row_count: 2 }),
      reverse({ rd_redone: [{ id: "rd_redone", score: 1 }] }),
    );
    expect(scope).toMatchObject({ kind: "incremental", ids: ["rd_redone"] });
  });

  it("takes a row with no usable timestamps into scope", () => {
    const list = [
      row("rd_undated", { created_at: undefined, updated_at: undefined, status: "failed" }),
    ];
    const scope = incrementalScope(
      list,
      marker({ list_row_count: 1 }),
      reverse({ rd_undated: null }),
    );
    expect(scope).toMatchObject({ kind: "incremental", ids: ["rd_undated"] });
  });

  // A ready reading owes the corpus a vector. Without one there is nothing to
  // scope its former neighbours from, and no row count shrinks to say so.
  it("escalates to full when a changed READY reading has no vector to query", () => {
    const scope = incrementalScope(
      [row("rd_gone", { updated_at: AFTER }), row("rd_other")],
      marker({ list_row_count: 2 }),
      reverse({ rd_gone: null }),
    );
    expect(scope.kind).toBe("full");
    expect((scope as { reason: string }).reason).toContain("no vector");
  });

  // A non-ready one having none is ordinary; its citers are reached through
  // the vectors that remain.
  it("does not escalate when a changed NON-READY reading has no vector", () => {
    const scope = incrementalScope(
      [row("rd_failed", { status: "failed", updated_at: AFTER }), row("rd_other")],
      marker({ list_row_count: 2 }),
      reverse({ rd_failed: null }),
    );
    expect(scope).toMatchObject({ kind: "incremental", ids: ["rd_failed"] });
  });

  // A reading that becomes non-ready keeps its vector where it is, so the
  // citers that need a stale_connection flag still score above the bound and
  // the reverse query is what finds them.
  it("takes a changed row of any status into scope, and its reverse neighbours with it", () => {
    const list = [
      row("rd_gone", { status: "failed", updated_at: AFTER }),
      row("rd_citer"),
    ];
    const scope = incrementalScope(
      list,
      marker({ list_row_count: 2 }),
      // A trailing below-bound match is what says the results ran out before
      // the bound did; without one the reverse set is treated as truncated.
      reverse({
        rd_gone: [
          { id: "rd_citer", score: 0.8 },
          { id: "rd_far", score: REVERSE_SCORE_BOUND - 0.2 },
        ],
      }),
    );
    expect(scope).toMatchObject({ kind: "incremental", ids: ["rd_citer", "rd_gone"] });
  });

  // The documented gap, pinned so it cannot be lost by accident: citations are
  // not on the list row, so a citer the reverse query does not reach — its
  // cited reading's vector moved away — is not in scope. The weekly --full
  // sweep is what covers it.
  it("does not reach a citer the reverse query has lost", () => {
    const list = [
      row("rd_moved", { updated_at: AFTER }),
      row("rd_citer", { connections: [{ id: "rd_moved", reason: "why" }] }),
    ];
    const scope = incrementalScope(
      list,
      marker({ list_row_count: 2 }),
      reverse({ rd_moved: [{ id: "rd_citer", score: REVERSE_SCORE_BOUND - 0.01 }] }),
    );
    expect(scope).toMatchObject({ kind: "incremental", ids: ["rd_moved"] });
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
      reverse({
        rd_new: [
          { id: "rd_purged", score: 0.9 },
          { id: "rd_far", score: REVERSE_SCORE_BOUND - 0.2 },
        ],
      }),
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

  // A vector that exists always matches itself, so an empty result is an
  // output shape we do not recognise rather than an empty neighbourhood.
  it("escalates to full on an empty reverse result", () => {
    const scope = incrementalScope(
      [row("rd_new", { created_at: AFTER, updated_at: AFTER })],
      marker({ list_row_count: 1 }),
      reverse({ rd_new: [] }),
    );
    expect(scope.kind).toBe("full");
  });

  // Every match above the bound, but the page was not full: Vectorize returned
  // everything it had, so the set is complete and the scope stands.
  it("does not escalate on a short result whose matches are all above the bound", () => {
    const scope = incrementalScope(
      [row("rd_new", { created_at: AFTER, updated_at: AFTER }), row("rd_near")],
      marker({ list_row_count: 2 }),
      reverse({
        rd_new: [
          { id: "rd_new", score: 1 },
          { id: "rd_near", score: 0.9 },
        ],
      }),
    );
    expect(scope).toMatchObject({ kind: "incremental", ids: ["rd_near", "rd_new"] });
  });

  // The rule is the minimum score, not the last element: nothing in the query
  // path guarantees a descending order, so a below-bound match anywhere in the
  // page means the results ran out before the bound did.
  it("reads a below-bound match in the middle of a full page as complete", () => {
    const matches = Array.from({ length: REVERSE_TOP_K }, (_, i) => ({
      id: `rd_${i}`,
      score: i === 40 ? REVERSE_SCORE_BOUND - 0.01 : 0.9,
    }));
    const scope = incrementalScope(
      [row("rd_new", { created_at: AFTER, updated_at: AFTER })],
      marker({ list_row_count: 1 }),
      reverse({ rd_new: matches }),
    );
    expect(scope.kind).toBe("incremental");
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
      reason:
        "1 unanswered reverse quer(ies), first rd_new — of 1 changed reading(s)",
    });
  });

  // A transient failure must not hide that everything else saturated: the
  // saturation rate is the number that says whether the flag is worth running.
  it("reports every cause of an escalation, not the first one found", () => {
    const dense = Array.from({ length: REVERSE_TOP_K }, (_, i) => ({
      id: `rd_${i}`,
      score: 0.9 - i / 1000,
    }));
    const scope = incrementalScope(
      [row("rd_a", { updated_at: AFTER }), row("rd_b", { updated_at: AFTER })],
      marker({ list_row_count: 2 }),
      reverse({ rd_b: dense }),
    );
    const reason = (scope as { reason: string }).reason;
    expect(scope.kind).toBe("full");
    expect(reason).toContain("1 unanswered reverse quer(ies), first rd_a");
    expect(reason).toContain("1 saturated reverse neighbourhood(s)");
    expect(reason).toContain("of 2 changed reading(s)");
  });

  // The reason has to carry the rate, not just the trigger: an operator
  // deciding whether --since-last-run is worth running needs to tell one
  // unusual reading apart from a corpus that saturates every night.
  it("counts how many changed readings saturated, not just the first", () => {
    // A full page of matches, none of them below the bound: the query was cut
    // off at topK and the real reverse set is unknown.
    const dense = Array.from({ length: REVERSE_TOP_K }, (_, i) => ({
      id: `rd_${i}`,
      score: REVERSE_SCORE_BOUND + i / REVERSE_TOP_K,
    }));
    const scope = incrementalScope(
      [
        row("rd_a", { updated_at: AFTER }),
        row("rd_b", { updated_at: AFTER }),
        row("rd_c"),
      ],
      marker({ list_row_count: 3 }),
      reverse({ rd_a: dense, rd_b: dense }),
    );
    expect(scope).toEqual({
      kind: "full",
      reason:
        "2 saturated reverse neighbourhood(s) " +
        `(no match below ${REVERSE_SCORE_BOUND.toFixed(2)}), first rd_a ` +
        "— of 2 changed reading(s)",
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
      reverse({ rd_a: [{ id: "rd_a", score: 1 }] }),
      "new",
    );
    expect(scope).toMatchObject({ kind: "incremental", ids: ["rd_a"] });
  });
});

describe("changedSince", () => {
  // The marker is written by the operator's clock and compared against
  // timestamps written by the Worker's. Without the margin, a few minutes of
  // forward skew drops a reading from every future scope, permanently and
  // invisibly.
  it("reaches back a margin, so a forward-skewed operator clock loses nothing", () => {
    const justBefore = new Date(Date.parse(LAST_RUN) - 60_000).toISOString();
    const wellBefore = new Date(
      Date.parse(LAST_RUN) - MARKER_CLOCK_SKEW_MS - 60_000,
    ).toISOString();
    const base = changedSince(
      [
        row("rd_skewed", { updated_at: justBefore }),
        row("rd_settled", { updated_at: wellBefore }),
      ],
      marker({ list_row_count: 2 }),
    );
    expect(base).toMatchObject({ kind: "incremental", changed: ["rd_skewed"] });
  });


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
