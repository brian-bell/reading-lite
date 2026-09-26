import { describe, expect, it } from "vitest";
import { classifyLegacyObjects, type LegacyReading } from "../../../scripts/corpus-lib/legacy-objects";

// Keys are tenant-relative, as the command strips `u/{tenantId}/` first.
const LIVE = "readings/2026/04/26T200000Z-rd_0000000001";
const OTHER = "readings/2026/04/27T200000Z-rd_0000000002";
const ORPHAN = "readings/2026/05/02T120000Z-rd_0000000003";

const readings: LegacyReading[] = [
  {
    id: "rd_0000000001",
    keyPrefix: LIVE,
    // Published on a revision after import: its legacy content is superseded.
    referenced: new Set([`${LIVE}/revisions/at_new/raw.html`, `${LIVE}/revisions/at_new/extracted.md`]),
  },
  {
    id: "rd_0000000002",
    keyPrefix: OTHER,
    // Imported and never reprocessed: the row still serves the legacy spelling.
    referenced: new Set([`${OTHER}/raw.html`, `${OTHER}/extracted.md`]),
  },
];

describe("classifyLegacyObjects", () => {
  it.each([
    [`${LIVE}/manifest.json`, "manifest"],
    [`${LIVE}/attempts/at_old.json`, "attempt_log"],
    [`${LIVE}/attempts/at_old/checkpoint.json`, "attempt_log"],
    [`${LIVE}/processing/at_rd_0000000009.json`, "checkpoint"],
    [`${LIVE}/raw.html`, "superseded_content"],
    [`${LIVE}/raw.pdf`, "superseded_content"],
    [`${LIVE}/extracted.md`, "superseded_content"],
    [`${ORPHAN}/manifest.json`, "orphan_prefix"],
    [`${ORPHAN}/raw.html`, "orphan_prefix"],
    [`${ORPHAN}/revisions/at_x/raw.html`, "orphan_prefix"],
    ["index/list.json", "list_index"],
    ["index/refresh-state.json", "refresh_state"],
    ["index/by-url/abc123", "url_pointer"],
    ["index/by-id/rd_0000000001", "id_pointer"],
    ["index/deleted/rd_0000000009", "tombstone"],
  ])("removes %s as %s", (key, reason) => {
    const plan = classifyLegacyObjects([key], readings);
    expect(plan.keep).toEqual([]);
    expect(plan.remove).toEqual([expect.objectContaining({ key, reason })]);
  });

  it.each([
    [`${LIVE}/revisions/at_new/raw.html`, "referenced"],
    [`${OTHER}/raw.html`, "referenced"],
    [`${OTHER}/extracted.md`, "referenced"],
    // A revision prefix the row no longer names is the runtime's to collect.
    [`${LIVE}/revisions/at_lost/raw.html`, "revision"],
    ["index/refresh-cursor.json", "live_index"],
    [`${LIVE}/notes.txt`, "unrecognized"],
    [`${LIVE}/raw.html/nested`, "unrecognized"],
    ["index/other.json", "unrecognized"],
    ["exports/exp_1/part-0001.zip", "unrecognized"],
    ["readings/2026/04/26T200000Z-not-an-id/manifest.json", "unrecognized"],
  ])("keeps %s as %s", (key, reason) => {
    const plan = classifyLegacyObjects([key], readings);
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([{ key, reason }]);
  });

  // An id with a row under a different key_prefix is corrupt, not an orphan:
  // deleting its objects would be deleting on a guess.
  it("keeps a prefix whose reading id has a row under another key_prefix", () => {
    const moved = "readings/2026/06/01T000000Z-rd_0000000001";
    const plan = classifyLegacyObjects([`${moved}/raw.html`], readings);
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([{ key: `${moved}/raw.html`, reason: "prefix_id_mismatch" }]);
  });

  it("names the reading and prefix each per-reading removal belongs to", () => {
    const plan = classifyLegacyObjects([`${LIVE}/raw.html`, `${ORPHAN}/manifest.json`], readings);
    expect(plan.remove).toEqual([
      { key: `${LIVE}/raw.html`, reason: "superseded_content", readingId: "rd_0000000001", prefix: LIVE },
      { key: `${ORPHAN}/manifest.json`, reason: "orphan_prefix", readingId: "rd_0000000003", prefix: ORPHAN },
    ]);
  });
});
