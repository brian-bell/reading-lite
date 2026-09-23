import { describe, expect, it } from "vitest";
import { resolveDropTargets, type DropListItem } from "../../../scripts/corpus-lib/drop";

const item = (o: Partial<DropListItem>): DropListItem => ({
  id: "rd_a",
  url: "https://a.com/p",
  key_prefix: "readings/2026/x-rd_a",
  status: "failed",
  ...o,
});

describe("resolveDropTargets", () => {
  it("resolves an explicit id selector to its target", () => {
    const items = [item({ id: "rd_a" }), item({ id: "rd_b", url: "https://b.com" })];
    const r = resolveDropTargets(items, ["rd_a"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targets.map((t) => t.id)).toEqual(["rd_a"]);
  });

  it("resolves a url selector to every non-ready copy of that url", () => {
    const items = [
      item({ id: "rd_1", url: "https://dup.com", status: "failed" }),
      item({ id: "rd_2", url: "https://dup.com", status: "failed" }),
      item({ id: "rd_3", url: "https://other.com", status: "failed" }),
    ];
    const r = resolveDropTargets(items, ["https://dup.com"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targets.map((t) => t.id).sort()).toEqual(["rd_1", "rd_2"]);
  });

  it("errors on an unknown id", () => {
    const r = resolveDropTargets([item({ id: "rd_a" })], ["rd_missing"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/rd_missing/);
  });

  it("errors on an unknown url", () => {
    const r = resolveDropTargets([item({})], ["https://nope.com"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/nope\.com/);
  });

  it("refuses an explicitly-named ready id (would drop its URL claim)", () => {
    const r = resolveDropTargets([item({ id: "rd_a", status: "ready" })], ["rd_a"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/ready/);
  });

  it("drops a url's non-ready copies and keeps its ready copy", () => {
    const items = [
      item({ id: "rd_ready", url: "https://mix.com", status: "ready" }),
      item({ id: "rd_failed", url: "https://mix.com", status: "failed" }),
    ];
    const r = resolveDropTargets(items, ["https://mix.com"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.targets.map((t) => t.id)).toEqual(["rd_failed"]);
      expect(r.keptReady.map((i) => i.id)).toEqual(["rd_ready"]);
    }
  });

  it("refuses a url that only has ready copies", () => {
    const r = resolveDropTargets([item({ url: "https://r.com", status: "ready" })], ["https://r.com"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/only.*ready/i);
  });

  it("allows ready id deletion only when explicitly requested", () => {
    const r = resolveDropTargets(
      [item({ id: "rd_ready", status: "ready" })],
      ["rd_ready"],
      { allowReady: true },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targets).toMatchObject([{ id: "rd_ready", status: "ready" }]);
  });

  it("allows ready url deletion only when explicitly requested", () => {
    const r = resolveDropTargets(
      [item({ id: "rd_ready", url: "https://r.com", status: "ready" })],
      ["https://r.com"],
      { allowReady: true },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.targets.map((t) => t.id)).toEqual(["rd_ready"]);
      expect(r.keptReady).toEqual([]);
    }
  });

  it("dedupes when an id and its url are both given", () => {
    const items = [item({ id: "rd_a", url: "https://a.com/p" })];
    const r = resolveDropTargets(items, ["rd_a", "https://a.com/p"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targets.map((t) => t.id)).toEqual(["rd_a"]);
  });

  it("collects multiple errors at once", () => {
    const r = resolveDropTargets([item({ id: "rd_a" })], ["rd_x", "https://y.com"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(2);
  });
});

