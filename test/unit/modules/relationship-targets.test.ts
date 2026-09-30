import { describe, expect, it } from "vitest";
import {
  projectRelationshipTargets,
  relationshipTargetIds,
} from "../../../src/modules/relationship-targets";
import type { ListIndexItem } from "../../../src/schemas/api";

const NOW = "2026-09-11T12:00:00.000Z";
const TTL = 300;

function row(id: string, over: Partial<ListIndexItem> = {}): ListIndexItem {
  return {
    id,
    key_prefix: `readings/${id}`,
    url: `https://example.com/${id}`,
    title: `Title ${id}`,
    status: "ready",
    created_at: "2026-09-11T11:59:00.000Z",
    updated_at: "2026-09-11T11:59:00.000Z",
    ...over,
  };
}

describe("relationshipTargetIds", () => {
  it("unions connection and tension target ids without duplicates", () => {
    expect(
      relationshipTargetIds({
        connections: [
          { id: "rd_A", reason: "a" },
          { id: "rd_B", reason: "b" },
        ],
        tensions: [
          { id: "rd_B", kind: "contradicts", reason: "b", computed_at: NOW },
          { id: "rd_C", kind: "qualifies", reason: "c", computed_at: NOW },
        ],
      }),
    ).toEqual(["rd_A", "rd_B", "rd_C"]);
  });

  it("is empty when the manifest has no relationships", () => {
    expect(relationshipTargetIds({})).toEqual([]);
  });
});

describe("projectRelationshipTargets", () => {
  it("maps each indexed target to its url, title, and status", () => {
    const targets = projectRelationshipTargets(
      ["rd_A", "rd_B"],
      [row("rd_A"), row("rd_B", { status: "failed" })],
      TTL,
      NOW,
    );
    expect(targets).toEqual({
      rd_A: { url: "https://example.com/rd_A", title: "Title rd_A", status: "ready" },
      rd_B: { url: "https://example.com/rd_B", title: "Title rd_B", status: "failed" },
    });
  });

  it("omits the title when the list row has none", () => {
    const targets = projectRelationshipTargets(
      ["rd_A"],
      [row("rd_A", { title: undefined, status: "pending" })],
      TTL,
      NOW,
    );
    expect(targets).toEqual({ rd_A: { url: "https://example.com/rd_A", status: "pending" } });
    expect(Object.keys(targets.rd_A)).not.toContain("title");
  });

  it("omits ids with no list row instead of inventing a status", () => {
    expect(projectRelationshipTargets(["rd_GONE"], [row("rd_A")], TTL, NOW)).toEqual({});
  });

  it("reports a stale pending target as failed, matching the list view", () => {
    const targets = projectRelationshipTargets(
      ["rd_OLD"],
      [row("rd_OLD", { status: "pending", updated_at: "2026-09-11T11:00:00.000Z" })],
      TTL,
      NOW,
    );
    expect(targets.rd_OLD?.status).toBe("failed");
  });

  it("ignores list rows that are not relationship targets", () => {
    expect(
      Object.keys(projectRelationshipTargets(["rd_A"], [row("rd_A"), row("rd_Z")], TTL, NOW)),
    ).toEqual(["rd_A"]);
  });
});
