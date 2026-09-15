import { describe, expect, it } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import {
  connectionsComputedOn,
  hasRelationships,
  relationshipCards,
  targetStatusBadge,
  tensionKindLabel,
} from "../src/reading-relationships";
import { ReadingSchema, type Reading } from "../src/reading";

// Relationship cards from real manifest shapes (design spec, Relationship
// targets; acceptance matrix, Removed target and Non-ready target).

const reading = (id: string): Reading => ReadingSchema.parse(pack.readings[id as keyof typeof pack.readings]);

describe("relationshipCards", () => {
  it("resolves titles and status from relationship_targets", () => {
    const { connections, tensions } = relationshipCards(reading("rd_FXATTENT01"));
    expect(connections[0]).toMatchObject({
      id: "rd_FXGARDEN01",
      kind: "connection",
      target: { title: "Libraries are gardens, not warehouses", status: "ready" },
    });
    expect(connections[0]!.label).toBeUndefined();
    expect(tensions).toEqual([
      expect.objectContaining({
        id: "rd_FXFRICTN01",
        kind: "tension",
        label: "Contradicts",
        target: expect.objectContaining({ title: "The case for a little friction" }),
      }),
    ]);
  });

  it("marks a target missing from the map as removed, keeping its reason", () => {
    const { connections } = relationshipCards(reading("rd_FXATTENT01"));
    const removed = connections.find((card) => card.id === pack.removed_target_id);
    expect(removed?.target).toBeUndefined();
    expect(removed?.reason).toMatch(/has since been removed/);
  });

  // A pending target has no title yet: the URL stands in, as it does for the
  // reading's own heading.
  it("falls back to the target URL when it has no title", () => {
    const { connections } = relationshipCards(reading("rd_FXGARDEN01"));
    const pending = connections.find((card) => card.id === "rd_FXPENDNG01");
    expect(pending?.target).toEqual({
      title: "https://fieldnotes.example/making-room-for-slow-work",
      url: "https://fieldnotes.example/making-room-for-slow-work",
      status: "pending",
    });
    expect(connections.find((card) => card.id === "rd_FXERR00002")?.target?.status).toBe("failed");
  });

  it("treats a response without a target map as all targets removed, not a failure", () => {
    const old = { ...reading("rd_FXATTENT01"), relationship_targets: undefined };
    const { connections } = relationshipCards(old);
    expect(connections.length).toBeGreaterThan(0);
    expect(connections.every((card) => card.target === undefined)).toBe(true);
  });

  it("has no cards for a reading with null tensions and no connections", () => {
    const bare: Reading = { id: "rd_1", url: "https://example.com/a", status: "ready" };
    expect(relationshipCards(bare)).toEqual({ connections: [], tensions: [] });
  });
});

describe("tensionKindLabel", () => {
  it("reads from this reading's point of view", () => {
    expect(tensionKindLabel("contradicts")).toBe("Contradicts");
    expect(tensionKindLabel("supersedes")).toBe("Supersedes");
    expect(tensionKindLabel("superseded_by")).toBe("Superseded by");
    expect(tensionKindLabel("qualifies")).toBe("Qualifies");
    expect(tensionKindLabel("qualified_by")).toBe("Qualified by");
  });

  it("still calls an unknown kind a tension", () => {
    expect(tensionKindLabel("echoes")).toBe("Tension");
  });
});

describe("hasRelationships", () => {
  it("is true for a ready reading with a connection or a tension", () => {
    expect(hasRelationships(reading("rd_FXATTENT01"))).toBe(true);
    expect(hasRelationships(reading("rd_FXGARDEN01"))).toBe(true);
  });

  // Sparse archive: the novelty panel says the library had nothing close; an
  // empty Connections heading would say it twice, less clearly.
  it("is false for a sparse archive and for readings not yet ready", () => {
    expect(hasRelationships(reading("rd_FXSPARSE01"))).toBe(false);
    expect(hasRelationships(reading("rd_FXPENDNG01"))).toBe(false);
    expect(hasRelationships(reading("rd_FXERR00001"))).toBe(false);
  });
});

describe("the muted lines and badges", () => {
  it("dates the connections from connections_computed_at", () => {
    expect(connectionsComputedOn(reading("rd_FXATTENT01"))).toBe("Computed 8 September 2026");
    expect(connectionsComputedOn(reading("rd_FXPAST0001"))).toBeUndefined();
  });

  it("badges only non-ready targets, in words", () => {
    expect(targetStatusBadge("pending")).toBe("Processing");
    expect(targetStatusBadge("failed")).toBe("Failed");
    expect(targetStatusBadge("ready")).toBeUndefined();
  });
});
