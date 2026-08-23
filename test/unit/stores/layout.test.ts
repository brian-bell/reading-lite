import { describe, expect, it } from "vitest";
import {
  ATTEMPTS_PREFIX,
  BY_ID_PREFIX,
  BY_URL_PREFIX,
  EXTRACTED_FILE,
  LIST_INDEX_KEY,
  MANIFEST_FILE,
  RAW_PREFIX,
  READINGS_PREFIX,
  buildKeyPrefix,
  r2KeyLayout,
} from "../../../src/modules/stores/layout";

// The exact spellings are a contract with objects already stored in R2 — a
// "cleanup" rename here would strand the live corpus. Pin them.
describe("layout vocabulary", () => {
  it("spells the stored corpus layout", () => {
    expect(LIST_INDEX_KEY).toBe("index/list.json");
    expect(MANIFEST_FILE).toBe("manifest.json");
    expect(READINGS_PREFIX).toBe("readings/");
    expect(EXTRACTED_FILE).toBe("extracted.md");
    expect(RAW_PREFIX).toBe("raw.");
    expect(ATTEMPTS_PREFIX).toBe("attempts/");
    expect(BY_URL_PREFIX).toBe("index/by-url/");
    expect(BY_ID_PREFIX).toBe("index/by-id/");
  });
});

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
    expect(layout.listIndexKey()).toBe("index/list.json");
    expect(layout.readingsPrefix()).toBe("readings/");
    expect(layout.readingObjectsPrefix(kp)).toBe(`${kp}/`);
    expect(layout.manifestKey(kp)).toBe(`${kp}/manifest.json`);
    expect(layout.extractedKey(kp)).toBe(`${kp}/extracted.md`);
    expect(layout.rawKey(kp, "html")).toBe(`${kp}/raw.html`);
    expect(layout.attemptsPrefix(kp)).toBe(`${kp}/attempts/`);
    expect(layout.attemptKey(kp, "at_123")).toBe(`${kp}/attempts/at_123.json`);
    expect(layout.byUrlKey("deadbeef")).toBe("index/by-url/deadbeef");
    expect(layout.byIdKey("rd_abc")).toBe("index/by-id/rd_abc");
  });

  it("keeps attempt keys inside the attempts prefix", () => {
    expect(layout.attemptKey(kp, "at_123").startsWith(layout.attemptsPrefix(kp))).toBe(true);
  });

  it("relativeKey is the identity when there is no root", () => {
    expect(layout.relativeKey(layout.manifestKey(kp))).toBe(`${kp}/manifest.json`);
  });
});

describe("r2KeyLayout with a tenant root", () => {
  const root = "u/t_founder/";
  const layout = r2KeyLayout(root);
  const kp = "readings/2026/04/26T200000Z-rd_abc";

  it("prefixes the root onto every object key", () => {
    expect(layout.keyRoot).toBe(root);
    expect(layout.listIndexKey()).toBe(`${root}index/list.json`);
    expect(layout.readingsPrefix()).toBe(`${root}readings/`);
    expect(layout.readingObjectsPrefix(kp)).toBe(`${root}${kp}/`);
    expect(layout.manifestKey(kp)).toBe(`${root}${kp}/manifest.json`);
    expect(layout.extractedKey(kp)).toBe(`${root}${kp}/extracted.md`);
    expect(layout.rawKey(kp, "pdf")).toBe(`${root}${kp}/raw.pdf`);
    expect(layout.attemptsPrefix(kp)).toBe(`${root}${kp}/attempts/`);
    expect(layout.attemptKey(kp, "at_123")).toBe(`${root}${kp}/attempts/at_123.json`);
    expect(layout.byUrlKey("deadbeef")).toBe(`${root}index/by-url/deadbeef`);
    expect(layout.byIdKey("rd_abc")).toBe(`${root}index/by-id/rd_abc`);
  });

  it("leaves the stored key_prefix relative — buildKeyPrefix never carries the root", () => {
    expect(buildKeyPrefix("rd_abc", "2026-04-26T20:00:00.000Z").startsWith("readings/")).toBe(
      true,
    );
  });

  it("relativeKey strips the root and passes through already-relative keys", () => {
    expect(layout.relativeKey(layout.manifestKey(kp))).toBe(`${kp}/manifest.json`);
    expect(layout.relativeKey(`${kp}/manifest.json`)).toBe(`${kp}/manifest.json`);
  });
});
