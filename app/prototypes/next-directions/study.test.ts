import { describe, expect, it } from "vitest";
import { readings } from "./samples";
import {
  annotateStale,
  catalogIndex,
  deskOf,
  failureOf,
  digestPreview,
  emptyRoute,
  filterReadings,
  meaningSearch,
  parseFacet,
  parseRoute,
  reprocessFailed,
  revisitPrompts,
  routeHash,
  tensionPairs,
  threadsOf,
} from "./study";

describe("hash routes", () => {
  it("round-trips every field", () => {
    const route = { ...emptyRoute("catalog", "people"), q: "endings", mode: "meaning", facet: "people:Mara Ellis", trail: ["a", "b"] };
    expect(parseRoute(routeHash(route))).toEqual(route);
  });

  it("opens the desk for an empty or unknown hash", () => {
    expect(parseRoute("").view).toBe("desk");
    expect(parseRoute("#/nowhere").view).toBe("desk");
  });

  it("keeps an id only on the views that take one", () => {
    expect(routeHash(emptyRoute("reading", "a-quieter-internet"))).toBe("#/reading/a-quieter-internet");
    expect(routeHash(emptyRoute("library", "ignored"))).toBe("#/library");
  });

  it("still opens the three-direction study's links, with tensions folded into threads", () => {
    expect(parseRoute("#/threads/reading/x")).toMatchObject({ view: "reading", id: "x" });
    expect(parseRoute("#/desk/desk").view).toBe("desk");
    expect(parseRoute("#/catalog/people")).toMatchObject({ view: "catalog", id: "people" });
    expect(parseRoute("#/threads/tensions").view).toBe("threads");
    expect(parseRoute("#/tensions").view).toBe("threads");
    expect(parseRoute("#/find?q=x")).toMatchObject({ view: "catalog", id: "", q: "x" });
    expect(parseRoute("#/catalog/find").view).toBe("catalog");
    expect(parseRoute("#/inbox").view).toBe("desk");
    expect(parseRoute("#/threads/inbox").view).toBe("desk");
  });
});

describe("library filters", () => {
  it("matches text in titles, leads, and tags, and a tag exactly", () => {
    expect(filterReadings(readings, { q: "gardens", tag: "" }).map((r) => r.id)).toEqual(["libraries-are-gardens"]);
    expect(filterReadings(readings, { q: "", tag: "notes" }).map((r) => r.id).sort()).toEqual(["on-marginalia", "slow-reading-week", "what-a-commonplace-book-is-for"]);
    expect(filterReadings(readings, { q: "gardens", tag: "design" })).toEqual([]);
  });
});

describe("threads", () => {
  const threads = threadsOf(readings);

  it("groups ready readings by their connections and tensions, oldest first, and leaves unrelated ones out", () => {
    expect(threads.map((t) => [t.name, t.readings.length, t.tensions])).toEqual([
      ["Attention", 7, 1],
      ["Knowledge", 3, 1],
    ]);
    const attention = threads[0];
    expect(attention.readings[0].id).toBe("reading-on-paper-again");
    expect(attention.readings.at(-1)?.id).toBe("the-tab-that-never-closes");
    expect(threads.flatMap((t) => t.readings.map((r) => r.id))).not.toContain("against-the-endless-queue");
    expect(threads.flatMap((t) => t.readings.map((r) => r.id))).not.toContain("why-we-skim");
  });

  it("lists each tension pair once, read from the active side", () => {
    const pairs = tensionPairs(readings);
    expect(pairs.map((p) => [p.a.id, p.kind, p.b.id])).toEqual([
      ["a-quieter-internet", "contradicts", "the-case-for-a-little-friction"],
      ["the-second-brain-is-a-filing-cabinet", "qualifies", "what-a-commonplace-book-is-for"],
    ]);
  });

  it("prompts a revisit only for a connection saved well before the reading", () => {
    const commonplace = readings.find((r) => r.id === "what-a-commonplace-book-is-for")!;
    expect(revisitPrompts(readings, commonplace).map((p) => p.target.id)).toEqual(["on-marginalia"]);
    const quieter = readings.find((r) => r.id === "a-quieter-internet")!;
    expect(revisitPrompts(readings, quieter)).toEqual([]);
  });
});

describe("catalog", () => {
  it("indexes ready readings by people, with counts, alphabetically", () => {
    const people = catalogIndex(readings, "people");
    expect(people.map((e) => [e.term, e.count])).toEqual([
      ["Alex Rivera", 2],
      ["Ines Halvorsen", 2],
      ["Julian Park", 2],
      ["Leah Chen", 1],
      ["Mara Ellis", 2],
      ["Tomas Reyes", 1],
    ]);
  });

  it("reads a facet and refuses an unknown kind", () => {
    expect(parseFacet("hosts:fieldnotes.example")).toEqual({ kind: "hosts", term: "fieldnotes.example" });
    expect(parseFacet("colour:red")).toBeUndefined();
    expect(parseFacet("people:")).toBeUndefined();
  });

  it("ranks meaning hits by how much of the question they share, with the matched terms as the why", () => {
    const hits = meaningSearch(readings, "why do I keep saving things I never read");
    expect(hits[0].reading.id).toBe("the-tab-that-never-closes");
    expect(hits[0].why).toContain("saving");
    expect(hits.every((h) => h.reading.status === "ready")).toBe(true);
    expect(meaningSearch(readings, "the of and")).toEqual([]);
  });
});

describe("read-time state", () => {
  const stalled = readings.find((r) => r.id === "the-cost-of-convenience")!;
  const fresh = readings.find((r) => r.id === "why-we-skim")!;

  it("surfaces a pending reading past the window as failed with stale_pending, and leaves a fresh one alone", () => {
    expect(annotateStale(stalled)).toMatchObject({ status: "failed", error: { code: "stale_pending", stage: "fetch_source" } });
    expect(annotateStale(fresh)).toBe(fresh);
    expect(annotateStale(stalled, "2026-10-01T09:30:00Z")).toBe(stalled);
  });

  it("measures staleness from the running attempt, so a retry starts the window again", () => {
    expect(annotateStale({ ...stalled, attemptStartedAt: "2026-10-01T09:58:00Z" }).status).toBe("pending");
  });

  it("knows a ready reading whose reprocess failed, and which failure to explain", () => {
    const conversation = readings.find((r) => r.id === "reading-as-conversation")!;
    expect(reprocessFailed(conversation)).toBe(true);
    expect(conversation.status).toBe("ready");
    expect(failureOf(conversation)?.code).toBe("BadStatusError");
    expect(reprocessFailed(fresh)).toBe(false);
    expect(failureOf(readings.find((r) => r.id === "a-quieter-internet")!)).toBeUndefined();
  });
});

describe("desk", () => {
  it("sorts the library into what needs you, what is processing, what is new, and what is on the desk", () => {
    const desk = deskOf(readings.map((r) => annotateStale(r)), ["a-quieter-internet"], "2026-09-27T20:00:00Z");
    expect(desk.needsYou.map((r) => r.id)).toEqual(["reading-as-conversation", "the-cost-of-convenience", "interface-budgets"]);
    expect(desk.processing.map((r) => r.id)).toEqual(["why-we-skim"]);
    expect(desk.readySince.map((r) => r.id)).toEqual(["the-tab-that-never-closes"]);
    expect(desk.onDesk.map((r) => r.id)).toEqual(["a-quieter-internet"]);
  });

  it("previews the next digest from this week so far, with the tensions those readings are in", () => {
    const digest = digestPreview(readings, 2);
    expect(digest.period).toBe("28 September 2026 to 4 October 2026");
    expect(digest.sendsOn).toBe("5 October 2026");
    expect(digest.readings.map((r) => r.id)).toEqual(["the-tab-that-never-closes", "a-quieter-internet"]);
    expect(digest.tensions).toHaveLength(1);
    expect(digest.inboxCount).toBe(2);
  });
});
