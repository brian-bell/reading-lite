import { describe, expect, it } from "vitest";
import {
  byUrlPointerKey,
  deletionTargetFromCurrentItem,
  hasReadySibling,
  ownedByUrlPointerKey,
  urlHash,
} from "../../../scripts/corpus-lib/delete-plan";

describe("corpus delete plan", () => {
  it("hashes URLs with the same SHA-256 key used by by-url pointers", () => {
    expect(urlHash("https://example.com/a")).toBe(
      "2dce0a4c50441bfccfa9caf4b58c3cba6e06c420505dd829f0436de1aa44baac",
    );
    expect(byUrlPointerKey("https://example.com/a")).toBe(
      "index/by-url/2dce0a4c50441bfccfa9caf4b58c3cba6e06c420505dd829f0436de1aa44baac",
    );
  });

  it("deletes the by-url pointer only when the pointer is owned by the target reading", () => {
    const owned = ownedByUrlPointerKey({
      url: "https://example.com/a",
      pointerRaw: JSON.stringify({
        id: "rd_failed",
        key_prefix: "readings/2026/01/01T000000Z-rd_failed",
      }),
      id: "rd_failed",
      keyPrefix: "readings/2026/01/01T000000Z-rd_failed",
    });
    expect(owned).toBe(
      "index/by-url/2dce0a4c50441bfccfa9caf4b58c3cba6e06c420505dd829f0436de1aa44baac",
    );

    const survivorOwned = ownedByUrlPointerKey({
      url: "https://example.com/a",
      pointerRaw: JSON.stringify({
        id: "rd_ready",
        key_prefix: "readings/2026/01/01T000000Z-rd_ready",
      }),
      id: "rd_failed",
      keyPrefix: "readings/2026/01/01T000000Z-rd_failed",
    });
    expect(survivorOwned).toBeNull();
  });

  it("ignores absent or unparseable by-url pointers", () => {
    expect(
      ownedByUrlPointerKey({
        url: "https://example.com/a",
        pointerRaw: null,
        id: "rd_failed",
        keyPrefix: "readings/2026/01/01T000000Z-rd_failed",
      }),
    ).toBeNull();
    expect(
      ownedByUrlPointerKey({
        url: "https://example.com/a",
        pointerRaw: "{",
        id: "rd_failed",
        keyPrefix: "readings/2026/01/01T000000Z-rd_failed",
      }),
    ).toBeNull();
  });

  it("resolves deletion targets from current list state and refuses ready rows", () => {
    expect(
      deletionTargetFromCurrentItem("rd_failed", {
        id: "rd_failed",
        status: "failed",
        key_prefix: "readings/2026/01/01T000000Z-rd_failed",
        url: "https://example.com/a",
      }),
    ).toEqual({
      id: "rd_failed",
      prefix: "readings/2026/01/01T000000Z-rd_failed",
      url: "https://example.com/a",
    });

    expect(() =>
      deletionTargetFromCurrentItem("rd_ready", {
        id: "rd_ready",
        status: "ready",
        key_prefix: "readings/2026/01/01T000000Z-rd_ready",
        url: "https://example.com/a",
      }),
    ).toThrow(/ready/);
    expect(() => deletionTargetFromCurrentItem("rd_missing", undefined)).toThrow(/not found/);
  });

  it("requires a current ready sibling before treating an audit row as orphan-dup", () => {
    expect(
      hasReadySibling(
        [
          { id: "rd_failed", url: "https://example.com/a", status: "failed" },
          { id: "rd_ready", url: "https://example.com/a", status: "ready" },
        ],
        { id: "rd_failed", url: "https://example.com/a" },
      ),
    ).toBe(true);

    expect(
      hasReadySibling(
        [
          { id: "rd_failed", url: "https://example.com/a", status: "failed" },
          { id: "rd_other", url: "https://example.com/b", status: "ready" },
        ],
        { id: "rd_failed", url: "https://example.com/a" },
      ),
    ).toBe(false);
  });
});
