import { describe, expect, it } from "vitest";
import { buildKeyPrefix, r2KeyLayout } from "../../../src/modules/stores/layout";

describe("buildKeyPrefix", () => {
  it("compacts the ISO timestamp into the readings/ prefix", () => {
    expect(buildKeyPrefix("rd_abc", "2026-04-26T20:00:00.000Z")).toBe(
      "readings/2026/04/26T200000Z-rd_abc",
    );
  });

  it("accepts second-precision ISO without milliseconds", () => {
    expect(buildKeyPrefix("rd_abc", "2026-04-26T20:00:00Z")).toBe(
      "readings/2026/04/26T200000Z-rd_abc",
    );
  });

  it("rejects a non-UTC or malformed timestamp", () => {
    expect(() => buildKeyPrefix("rd_abc", "2026-04-26T20:00:00+02:00")).toThrow(
      /invalid ISO timestamp/,
    );
    expect(() => buildKeyPrefix("rd_abc", "yesterday")).toThrow(/invalid ISO timestamp/);
  });
});

describe("r2KeyLayout with the global (pre-tenant) root", () => {
  const layout = r2KeyLayout();
  const kp = "readings/2026/04/26T200000Z-rd_abc";

  it("builds every object key from the shared vocabulary", () => {
    expect(layout.refreshCursorKey()).toBe("index/refresh-cursor.json");
    expect(layout.readingObjectsPrefix(kp)).toBe(`${kp}/`);
    expect(layout.extractedKey(kp)).toBe(`${kp}/extracted.md`);
    expect(layout.rawKey(kp, "html")).toBe(`${kp}/raw.html`);
    expect(layout.revisionsPrefix(kp)).toBe(`${kp}/revisions/`);
    expect(layout.revisionRawKey(kp, "at_123", "html")).toBe(`${kp}/revisions/at_123/raw.html`);
    expect(layout.revisionExtractedKey(kp, "at_123")).toBe(`${kp}/revisions/at_123/extracted.md`);
  });
});

describe("r2KeyLayout with a tenant root", () => {
  const root = "u/t_founder/";
  const layout = r2KeyLayout(root);
  const kp = "readings/2026/04/26T200000Z-rd_abc";

  it("prefixes the root onto every object key", () => {
    expect(layout.keyRoot).toBe(root);
    expect(layout.refreshCursorKey()).toBe(`${root}index/refresh-cursor.json`);
    expect(layout.readingObjectsPrefix(kp)).toBe(`${root}${kp}/`);
    expect(layout.extractedKey(kp)).toBe(`${root}${kp}/extracted.md`);
    expect(layout.rawKey(kp, "pdf")).toBe(`${root}${kp}/raw.pdf`);
    expect(layout.revisionsPrefix(kp)).toBe(`${root}${kp}/revisions/`);
    expect(layout.revisionRawKey(kp, "at_123", "pdf")).toBe(`${root}${kp}/revisions/at_123/raw.pdf`);
    expect(layout.revisionExtractedKey(kp, "at_123")).toBe(`${root}${kp}/revisions/at_123/extracted.md`);
  });

  it("leaves the stored key_prefix relative — buildKeyPrefix never carries the root", () => {
    expect(buildKeyPrefix("rd_abc", "2026-04-26T20:00:00.000Z")).toBe(
      "readings/2026/04/26T200000Z-rd_abc",
    );
  });
});
