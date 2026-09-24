import { describe, expect, it } from "vitest";
import { manifestToIndexItem } from "../../../src/modules/stores/list-items";
import type { Manifest } from "../../../src/schemas/manifest";

function emptyManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_TEST",
    url: "https://example.com/a",
    url_hash: "a".repeat(64),
    status: "pending",
    content_type: "application/octet-stream",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: "2026-04-26T20:00:00.000Z",
    updated_at: "2026-04-26T20:00:00.000Z",
    ...overrides,
  };
}

describe("manifestToIndexItem", () => {
  it("copies keywords when present and omits the field when absent", () => {
    const withKeywords = manifestToIndexItem(
      emptyManifest({ id: "rd_kw", keywords: ["soft skills", "sales"] }),
      "readings/2026/04/26T200000Z-rd_kw",
    );
    expect(withKeywords.keywords).toEqual(["soft skills", "sales"]);

    const without = manifestToIndexItem(emptyManifest({ id: "rd_plain" }), "readings/2026/04/26T200000Z-rd_plain");
    expect(without.keywords).toBeUndefined();
  });
});
