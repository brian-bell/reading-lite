import { describe, expect, it } from "vitest";
import type { Reading } from "../src/reading";
import type { GraphReading, GraphRow, RelationshipGraph } from "../src/relationships";
import {
  relationshipCount,
  revisitPrompts,
  standingAlone,
  tensionPairs,
  threadFor,
  threadsOf,
} from "../src/threads";

// The frontend's derivations over the relationship graph (design spec,
// Derivations in the frontend), each case a small graph built here.

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();

function r(id: string, n: number, tags?: string[], status: GraphReading["status"] = "ready"): GraphReading {
  return { id, url: `https://example.com/${id}`, title: `Title ${id}`, status, created_at: day(n), ...(tags ? { tags } : {}) };
}
const conn = (source_id: string, target_id: string): GraphRow => ({ source_id, target_id, kind: "connection", reason: `${source_id}→${target_id}` });
const ten = (source_id: string, target_id: string, tension_kind: string, reason = "they disagree"): GraphRow => ({
  source_id,
  target_id,
  kind: "tension",
  tension_kind,
  reason,
});
const graph = (readings: GraphReading[], relationships: GraphRow[] = []): RelationshipGraph => ({ readings, relationships });

/** A chain over `readings`, so they form one component. */
const chain = (readings: GraphReading[]) => readings.slice(1).map((reading, i) => conn(reading.id, readings[i]!.id));

/** `n` readings tagged `tag`, ids `${tag}00`…, created from day `from`. */
const tagged = (tag: string, n: number, from: number, tags: string[] = [tag]) =>
  Array.from({ length: n }, (_, i) => r(`${tag}${String(i).padStart(2, "0")}`, from + i, tags));

const shape = (g: RelationshipGraph) =>
  threadsOf(g).map((thread) => ({ id: thread.id, name: thread.name, readings: thread.readings.map((x) => x.id), tensions: thread.tensions }));

describe("threadsOf", () => {
  const twelve = tagged("a", 12, 0);
  const big = [...tagged("x", 7, 0), ...tagged("y", 5, 10), r("z00", 20, ["z"]), r("none", 21), r("both", 22, ["y", "x"])];

  it.each([
    ["a reading with no relationship stands alone", graph([r("a", 0)]), []],
    [
      "a one-sided connection joins its two readings, oldest first, named by their shared tag",
      graph([r("b", 2, ["attention"]), r("a", 1, ["attention", "craft"])], [conn("b", "a")]),
      [{ id: "a", name: "Attention", readings: ["a", "b"], tensions: 0 }],
    ],
    [
      "a relationship to a reading that is not ready joins nothing",
      graph([r("a", 0), r("p", 1, undefined, "pending"), r("f", 2, undefined, "failed")], [conn("a", "p"), ten("f", "a", "contradicts")]),
      [],
    ],
    [
      "a tension joins its readings too, and counts once with both ends in the thread",
      graph([r("a", 0), r("b", 1)], [ten("a", "b", "supersedes"), ten("b", "a", "superseded_by")]),
      [{ id: "a", name: "Title a", readings: ["a", "b"], tensions: 1 }],
    ],
    [
      "an untagged thread is named by its oldest reading's title; equal times fall back to id",
      graph([r("m", 5), r("k", 5), r("q", 6)], [conn("m", "k"), conn("q", "m")]),
      [{ id: "k", name: "Title k", readings: ["k", "m", "q"], tensions: 0 }],
    ],
    [
      "a tag is named as a reader writes it, with its acronyms",
      graph(
        [r("a", 0, ["developer-tools"]), r("b", 1, ["developer-tools"]), r("c", 2, ["ai-safety"]), r("d", 3, ["ai-safety"])],
        [conn("b", "a"), conn("d", "c")],
      ),
      [
        { id: "c", name: "AI safety", readings: ["c", "d"], tensions: 0 },
        { id: "a", name: "Developer tools", readings: ["a", "b"], tensions: 0 },
      ],
    ],
    [
      "the shared tag most particular to the thread names it, not the library's broadest",
      graph([r("a", 0, ["ai", "evaluation"]), r("b", 1, ["ai", "evaluation"]), r("c", 2, ["ai"])], [conn("b", "a")]),
      [{ id: "a", name: "Evaluation", readings: ["a", "b"], tensions: 0 }],
    ],
    [
      "a tag most of the thread shares outranks a rarer one only some share",
      graph([r("a", 0, ["ai", "evaluation"]), r("b", 1, ["ai"]), r("c", 2, ["ai"])], [conn("b", "a")]),
      [{ id: "a", name: "AI", readings: ["a", "b"], tensions: 0 }],
    ],
    [
      "threads that would share a name add their next tag",
      graph(
        [r("a", 0, ["evaluation", "agents"]), r("b", 1, ["evaluation"]), r("c", 2, ["evaluation", "benchmarks"]), r("d", 3, ["evaluation"])],
        [conn("b", "a"), conn("d", "c")],
      ),
      [
        { id: "c", name: "Evaluation · Benchmarks", readings: ["c", "d"], tensions: 0 },
        { id: "a", name: "Evaluation · Agents", readings: ["a", "b"], tensions: 0 },
      ],
    ],
    [
      "the name's tag tie goes to the alphabetically first tag",
      graph([r("a", 0, ["zebra", "apple"]), r("b", 1, ["zebra", "apple"])], [conn("a", "b")]),
      [{ id: "a", name: "Apple", readings: ["a", "b"], tensions: 0 }],
    ],
    [
      "threads are listed by their newest reading, most recent first",
      graph([r("a", 0), r("b", 9), r("c", 3), r("d", 4)], [conn("a", "b"), conn("c", "d")]),
      [
        { id: "a", name: "Title a", readings: ["a", "b"], tensions: 0 },
        { id: "c", name: "Title c", readings: ["c", "d"], tensions: 0 },
      ],
    ],
    [
      "twelve readings stay one thread",
      graph(twelve, chain(twelve)),
      [{ id: "a00", name: "A", readings: twelve.map((x) => x.id), tensions: 0 }],
    ],
    [
      "above twelve, readings split by their component's most common tag; a group of one and the untagged join the largest",
      graph(big, chain(big)),
      [
        { id: "x00", name: "X", readings: ["x00", "x01", "x02", "x03", "x04", "x05", "x06", "z00", "none", "both"], tensions: 0 },
        { id: "y00", name: "Y", readings: ["y00", "y01", "y02", "y03", "y04"], tensions: 0 },
      ],
    ],
  ])("%s", (_name, g, expected) => {
    expect(shape(g)).toEqual(expected);
  });

  it("lists the ready readings in no thread as standing alone, newest first", () => {
    const g = graph([r("a", 0), r("b", 1), r("c", 2), r("d", 3), r("p", 4, undefined, "pending")], [conn("a", "b")]);
    expect(standingAlone(g, threadsOf(g)).map((x) => x.id)).toEqual(["d", "c"]);
  });
});

describe("threadFor", () => {
  const g = graph([r("a", 0), r("b", 1), r("c", 2), r("lone", 3)], [conn("b", "a"), conn("c", "b")]);
  it.each([
    ["the oldest reading's id", "a", "a"],
    ["any other member's id", "c", "a"],
    ["a reading standing alone", "lone", undefined],
    ["an unknown id", "rd_unknown", undefined],
  ])("resolves %s", (_name, id, expected) => {
    expect(threadFor(threadsOf(g), id)?.id).toBe(expected);
  });
});

describe("tensionPairs", () => {
  it.each([
    [
      "both sides collapse to the active-voice row",
      [ten("b", "a", "superseded_by"), ten("a", "b", "supersedes")],
      [["a", "supersedes", "b"]],
    ],
    ["a passive row alone is flipped", [ten("b", "a", "qualified_by")], [["a", "qualifies", "b"]]],
    ["a symmetric kind keeps the first side's row", [ten("a", "b", "contradicts"), ten("b", "a", "contradicts")], [["a", "contradicts", "b"]]],
    [
      "pairs are newest first by the later reading",
      [ten("a", "b", "contradicts"), ten("c", "d", "contradicts")],
      [
        ["c", "contradicts", "d"],
        ["a", "contradicts", "b"],
      ],
    ],
    ["connections are not tensions", [conn("a", "b")], []],
    ["a tension with a reading that is not ready is left out", [ten("a", "f", "contradicts")], []],
  ])("%s", (_name, rows, expected) => {
    const g = graph([r("a", 0), r("b", 1), r("c", 2), r("d", 3), r("f", 4, [], "failed")], rows);
    expect(tensionPairs(g).map((pair) => [pair.a.id, pair.kind, pair.b.id])).toEqual(expected);
  });

  it("labels the active kind and keeps the reason", () => {
    const [pair] = tensionPairs(graph([r("a", 0), r("b", 1)], [ten("b", "a", "superseded_by", "newer data")]));
    expect(pair).toMatchObject({ label: "Supersedes", reason: "newer data" });
  });
});

describe("revisitPrompts", () => {
  const savedAt = day(100);
  function reading(targets: Record<string, { status: Reading["status"]; created_at?: string }>): Reading {
    return {
      id: "rd_this",
      url: "https://example.com/this",
      status: "ready",
      created_at: savedAt,
      connections: Object.keys(targets).map((id) => ({ id, reason: `why ${id}` })),
      tensions: [{ id: "rd_tension", kind: "contradicts", reason: "a tension" }],
      relationship_targets: {
        ...Object.fromEntries(
          Object.entries(targets).map(([id, t]) => [id, { url: `https://example.com/${id}`, title: id, ...t }]),
        ),
        rd_tension: { url: "https://example.com/t", status: "ready", created_at: day(0) },
      },
    } as Reading;
  }

  it.each([
    ["saved 61 days before", { status: "ready" as const, created_at: day(39) }, ["rd_target"]],
    ["saved exactly 60 days before", { status: "ready" as const, created_at: day(40) }, []],
    ["saved after", { status: "ready" as const, created_at: day(120) }, []],
    ["not ready", { status: "failed" as const, created_at: day(0) }, []],
    ["with no saved time", { status: "ready" as const }, []],
  ])("a connection target %s", (_name, target, expected) => {
    expect(revisitPrompts(reading({ rd_target: target })).map((prompt) => prompt.id)).toEqual(expected);
  });
});

describe("relationshipCount", () => {
  it.each([
    [{ connection_count: 2, tension_count: 1 }, "2 connections · 1 tension"],
    [{ connection_count: 1, tension_count: 0 }, "1 connection"],
    [{ connection_count: 0, tension_count: 3 }, "3 tensions"],
    [{ connection_count: 0, tension_count: 0 }, undefined],
    [{}, undefined],
  ])("%o reads %s", (row, expected) => {
    expect(relationshipCount(row)).toBe(expected);
  });
});
