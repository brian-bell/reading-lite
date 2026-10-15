import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useNeedsYou, type NeedsYou } from "../src/needs-you-dismissals";
import {
  FIRST_VISIT_MS,
  agoLabel,
  needsYouLine,
  onDeskAfterWrite,
  parseVisit,
  sessionPlaceOf,
  stageLabel,
  visitAt,
} from "../src/desk";
import type { LibraryRow } from "../src/library";
import { failureOf, reprocessFailed } from "../src/reading-state";

// The desk's derivations (design spec, The visit and Desk views): the visit
// the "Ready since" section covers, what a Needs you row says, and where a
// reading sits in a session. The backend owns the grouping (GET /api/desk).

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 11, 12);

describe("the visit", () => {
  it.each([
    ["no cookie: the last seven days", undefined, NOW - FIRST_VISIT_MS, NOW - FIRST_VISIT_MS],
    ["an unreadable cookie counts as none", "soon", NOW - FIRST_VISIT_MS, NOW - FIRST_VISIT_MS],
    ["previous after latest is unreadable", `${NOW}.${NOW - 1}`, NOW - FIRST_VISIT_MS, NOW - FIRST_VISIT_MS],
    ["within two hours: the same visit", `${NOW - 3 * DAY}.${NOW - HOUR}`, NOW - 3 * DAY, NOW - 3 * DAY],
    ["after two hours: a new visit from the last render", `${NOW - 3 * DAY}.${NOW - 3 * HOUR}`, NOW - 3 * HOUR, NOW - 3 * HOUR],
    ["never more than fourteen days back", `${NOW - 40 * DAY}.${NOW - 30 * DAY}`, NOW - 30 * DAY, NOW - 14 * DAY],
  ])("%s", (_case, cookie, previous, since) => {
    expect(visitAt(cookie, NOW)).toEqual({ since, next: { previous, latest: NOW } });
  });

  it("holds still while the reader moves around, and rolls over after a gap", () => {
    const first = visitAt(undefined, NOW);
    const later = visitAt(`${first.next.previous}.${first.next.latest}`, NOW + HOUR);
    expect(later.since, "an hour on").toBe(first.since);
    const next = visitAt(`${later.next.previous}.${later.next.latest}`, NOW + 4 * HOUR);
    expect(next.since, "after a gap, since the last render").toBe(NOW + HOUR);
  });

  it("reads only two bounded integers", () => {
    expect(parseVisit(" 1.2 ")).toEqual({ previous: 1, latest: 2 });
    for (const value of ["1.2.3", "-1.2", "1e3.2", `${"9".repeat(16)}.1`, ""]) {
      expect(parseVisit(value), value).toBeUndefined();
    }
  });
});

const row = (fields: Partial<LibraryRow>): LibraryRow => ({ id: "rd_a", url: "https://example.com/a", status: "ready", ...fields });
const keyInvalid = { code: "provider_key_invalid", message: "replace the key" };
const unreachable = { code: "FetchError", message: "timed out", stage: "fetch_source" };
const attempt = (trigger: string, status: string, error?: typeof keyInvalid) => ({
  id: "at_1",
  trigger,
  status,
  started_at: "2026-10-11T10:00:00Z",
  ...(error ? { error } : {}),
});

describe("Needs you", () => {
  it.each([
    ["a failed reading, by its own error", row({ status: "failed", error: unreachable }), false, unreachable, "The page couldn't be fetched."],
    [
      "a failed reading with only its attempt's error",
      row({ status: "failed", last_attempt: attempt("submit", "failed", keyInvalid) }),
      false,
      keyInvalid,
      "Your OpenAI key needs replacing.",
    ],
    [
      "a ready reading whose reprocess failed",
      row({ last_attempt: attempt("reprocess", "failed", keyInvalid) }),
      true,
      keyInvalid,
      "Reprocess failed · Your OpenAI key needs replacing.",
    ],
    ["a failure with nothing to explain it", row({ status: "failed" }), false, undefined, "Processing failed."],
  ])("%s", (_case, reading, reprocess, failure, line) => {
    expect(reprocessFailed(reading)).toBe(reprocess);
    expect(failureOf(reading)).toEqual(failure);
    expect(needsYouLine(reading)).toBe(line);
  });

  it.each([
    ["a ready reading", row({})],
    ["a ready reading whose first save failed before a later success", row({ last_attempt: attempt("submit", "failed", keyInvalid) })],
    ["a failed reprocess being retried", row({ last_attempt: attempt("reprocess", "failed"), active_attempt: attempt("reprocess", "running") })],
  ])("has nothing to explain for %s", (_case, reading) => {
    expect(reprocessFailed(reading)).toBe(false);
    expect(failureOf(reading)).toBeUndefined();
  });
});

describe("Processing", () => {
  it.each([
    [undefined, "Processing"],
    ["queued", "Fetching"],
    ["write_extracted", "Fetching"],
    ["summarize", "Analyzing"],
    ["write_manifest", "Publishing"],
    ["a_stage_added_later", "Processing"],
  ])("names stage %s as %s", (stage, label) => {
    expect(stageLabel(stage)).toBe(label);
  });

  it.each([
    [NOW - 20_000, "just now"],
    [NOW - 12 * 60_000, "12 min ago"],
    [NOW - 3 * HOUR, "3 h ago"],
    [NOW - DAY, "yesterday"],
    [NOW - 3 * DAY, "3 days ago"],
    [NOW - 9 * DAY, "2 October 2026"],
    [NOW + 60_000, "just now"],
  ])("says %s as %s", (at, label) => {
    expect(agoLabel(new Date(at).toISOString(), NOW)).toBe(label);
  });

  it("says nothing for a missing or unreadable time", () => {
    expect(agoLabel(undefined, NOW)).toBeUndefined();
    expect(agoLabel("yesterday", NOW)).toBeUndefined();
  });
});

describe("the session", () => {
  const desk = [{ id: "rd_a", title: "A" }, { id: "rd_b", title: "B" }, { id: "rd_c" }];

  it.each([
    ["rd_a", { position: 1, count: 3, next: { id: "rd_b", title: "B" } }],
    ["rd_b", { position: 2, count: 3, next: { id: "rd_c" } }],
    ["rd_c", { position: 3, count: 3 }],
    ["rd_x", undefined],
  ])("places %s", (id, place) => {
    expect(sessionPlaceOf(id, desk)).toEqual(place);
  });

  it("names a write's answer from what the page knew and the reading written", () => {
    expect(onDeskAfterWrite(desk, ["rd_b", "rd_d", "rd_e"], { id: "rd_d", title: "D" })).toEqual([
      { id: "rd_b", title: "B" },
      { id: "rd_d", title: "D" },
      { id: "rd_e" },
    ]);
    expect(onDeskAfterWrite(undefined, ["rd_a"])).toEqual([{ id: "rd_a" }]);
  });
});

describe("dismissing a Needs you row", () => {
  afterEach(() => localStorage.clear());
  const T0 = Date.UTC(2026, 9, 15, 3);
  const failedReprocess = (attemptId: string) =>
    row({ id: "rd_45XAY3N8MM", last_attempt: { ...attempt("reprocess", "failed", keyInvalid), id: attemptId } });
  const failedReading = row({ id: "rd_failed", status: "failed", error: unreachable });
  const deskOf = (...rows: LibraryRow[]) => ({ needs_you: rows, needs_you_total: rows.length + 9 });
  const shown = ({ rows, total }: NeedsYou) => ({ ids: rows.map(({ row }) => row.id), total });
  const render = (desk: ReturnType<typeof deskOf>, now: number) =>
    renderHook((props) => useNeedsYou(props.desk, props.now), { initialProps: { desk, now } });

  it("offers Dismiss only on a failed reprocess, hides it, and counts what is left", () => {
    const { result } = render(deskOf(failedReprocess("at_1"), failedReading), T0);
    expect(result.current.rows.map(({ dismiss }) => dismiss !== undefined)).toEqual([true, false]);
    act(() => result.current.rows[0].dismiss!(T0));
    expect(shown(result.current)).toEqual({ ids: ["rd_failed"], total: 10 });
  });

  it("shows the reading again when a newer reprocess fails", () => {
    const { result, rerender } = render(deskOf(failedReprocess("at_1")), T0);
    act(() => result.current.rows[0].dismiss!(T0));
    rerender({ desk: deskOf(failedReprocess("at_2")), now: T0 + HOUR });
    expect(shown(result.current)).toEqual({ ids: ["rd_45XAY3N8MM"], total: 10 });
  });

  it.each([
    ["exactly seven days on, still dismissed", 7 * DAY, { ids: [], total: 9 }],
    ["past seven days, pruned", 7 * DAY + 1, { ids: ["rd_45XAY3N8MM"], total: 10 }],
  ])("%s", (_case, later, expected) => {
    const desk = deskOf(failedReprocess("at_1"));
    const { result, rerender } = render(desk, T0);
    act(() => result.current.rows[0].dismiss!(T0));
    rerender({ desk, now: T0 + later });
    expect(shown(result.current)).toEqual(expected);
  });

  it("keeps the first dismissal's time, and forgets a pruned one", () => {
    const desk = deskOf(failedReprocess("at_1"));
    const { result, rerender } = render(desk, T0);
    const { dismiss } = result.current.rows[0];
    act(() => dismiss!(T0));
    act(() => dismiss!(T0 + 5 * DAY));
    rerender({ desk, now: T0 + 7 * DAY + 1 });
    expect(shown(result.current), "a second click does not extend the seven days").toEqual({
      ids: ["rd_45XAY3N8MM"],
      total: 10,
    });
    act(() => result.current.rows[0].dismiss!(T0 + 7 * DAY + 1));
    expect(shown(result.current), "the pruned entry is gone, so this one starts fresh").toEqual({ ids: [], total: 9 });
  });

  it.each([
    ["unparseable", "{", { ids: ["rd_45XAY3N8MM", "rd_failed"], total: 11 }],
    ["not an object", "[]", { ids: ["rd_45XAY3N8MM", "rd_failed"], total: 11 }],
    [
      "a malformed entry beside a good one",
      JSON.stringify({ rd_other: { attempt_id: 1 }, rd_45XAY3N8MM: { attempt_id: "at_1", dismissed_at: T0 } }),
      { ids: ["rd_failed"], total: 10 },
    ],
  ])("reads %s storage without throwing", (_case, stored, expected) => {
    localStorage.setItem("reading-lite.needsYouDismissals", stored);
    expect(shown(render(deskOf(failedReprocess("at_1"), failedReading), T0).result.current)).toEqual(expected);
  });
});
