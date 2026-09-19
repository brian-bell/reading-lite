import { describe, expect, it } from "vitest";
import { compareUrlOwnership, manifestToRows } from "../../../scripts/pg-lib/manifest-rows";
import type { Manifest } from "../../../src/schemas/manifest";

const INPUT = { tenantId: "usr_550e8400-e29b-41d4-a716-446655440000", keyPrefix: "readings/2026/04/26T200000Z-rd_a", ownsUrl: true };

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_a",
    url: "https://example.com/a",
    url_hash: "a".repeat(64),
    status: "ready",
    connections: [],
    content_type: "application/pdf",
    content_status: "raw_only",
    content_bytes: 9,
    content_sha256: "0".repeat(64),
    created_at: "2026-04-26T20:00:00.000Z",
    updated_at: "2026-04-27T20:00:00.000Z",
    ...overrides,
  };
}

describe("manifestToRows", () => {
  it("publishes a ready manifest as a revision with relative content keys", () => {
    const rows = manifestToRows(manifest(), INPUT);
    expect(rows.reading.current_revision_id).toBe(rows.revision!.id);
    expect(rows.revision).toMatchObject({
      raw_key: `${INPUT.keyPrefix}/raw.pdf`,
      // raw_only: nothing was extracted.
      extracted_key: null,
      published_at: "2026-04-27T20:00:00.000Z",
      connections_present: true,
      tensions_present: false,
    });
    expect(rows.notes).toEqual([]);
  });

  it("leaves URL ownership to the caller", () => {
    expect(manifestToRows(manifest(), INPUT).ownsUrl).toBe(true);
    expect(manifestToRows(manifest(), { ...INPUT, ownsUrl: false }).ownsUrl).toBe(false);
  });

  it("keeps relationship order and the first of a duplicate target, and reports the rest", () => {
    const rows = manifestToRows(
      manifest({
        connections: [
          { id: "rd_x", reason: "first" },
          { id: "rd_y", reason: "second" },
          { id: "rd_x", reason: "again" },
        ],
        tensions: [{ id: "rd_x", kind: "contradicts", reason: "disagrees", computed_at: "2026-05-01T00:00:00.000Z" }],
      }),
      INPUT,
    );
    expect(rows.relationships.map((rel) => [rel.kind, rel.target_id, rel.position, rel.reason])).toEqual([
      ["connection", "rd_x", 0, "first"],
      ["connection", "rd_y", 1, "second"],
      // The same target under another kind is a different relationship.
      ["tension", "rd_x", 0, "disagrees"],
    ]);
    expect(rows.notes).toEqual(["duplicate connection target rd_x dropped: first occurrence kept"]);
  });

  it("gives a reading that is not ready no revision, relationships or vector, and says what it dropped", () => {
    const rows = manifestToRows(
      manifest({ status: "failed", summary_markdown: "stale", preserve_ready_manifest: { id: "rd_a" } }),
      { ...INPUT, embedding: [1, 2, 3] },
    );
    expect(rows.revision).toBeNull();
    expect(rows.reading.current_revision_id).toBeNull();
    expect(rows.relationships).toEqual([]);
    expect(rows.embedding).toBeNull();
    expect(rows.notes).toEqual([
      "preserve_ready_manifest dropped: revisions replace it",
      "summary_markdown dropped: failed reading has no revision",
      "connections dropped: failed reading has no revision",
      "embedding dropped: failed reading is not searchable",
    ]);
  });
});

describe("compareUrlOwnership", () => {
  it("ranks ready over pending over failed, then newest", () => {
    const item = (status: Manifest["status"], updated_at: string) => ({ status, created_at: updated_at, updated_at });
    const sorted = [
      item("failed", "2026-09-09T00:00:00.000Z"),
      item("ready", "2026-01-01T00:00:00.000Z"),
      item("pending", "2026-05-01T00:00:00.000Z"),
      item("ready", "2026-02-01T00:00:00.000Z"),
    ].sort(compareUrlOwnership);
    expect(sorted.map((row) => `${row.status}@${row.updated_at.slice(5, 7)}`)).toEqual([
      "ready@02", "ready@01", "pending@05", "failed@09",
    ]);
  });
});
