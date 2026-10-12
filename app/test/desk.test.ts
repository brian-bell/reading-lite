import { describe, expect, it } from "vitest";
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
