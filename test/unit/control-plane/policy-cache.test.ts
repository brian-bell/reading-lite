import { describe, expect, it, vi } from "vitest";
import { PolicyCache, policyCacheTtlMs } from "../../../src/control-plane/policy-cache";

describe("policyCacheTtlMs", () => {
  it.each([
    [undefined, 0],
    ["", 0],
    ["abc", 0],
    ["-5", 0],
    ["1.5", 0],
    ["0", 0],
    ["5000", 5000],
  ])("parses %j as %d", (raw, expected) => {
    expect(policyCacheTtlMs({ GUARD_POLICY_CACHE_MS: raw })).toBe(expected);
  });
});

describe("PolicyCache", () => {
  it("serves a loaded value until the TTL passes, then loads again", async () => {
    const cache = new PolicyCache(1000);
    const load = vi.fn(async () => ({ limit: 3 }));
    expect(await cache.get("k", load, 0)).toEqual({ limit: 3 });
    expect(await cache.get("k", load, 999)).toEqual({ limit: 3 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(await cache.get("k", load, 1000)).toEqual({ limit: 3 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never caches a missing row", async () => {
    const cache = new PolicyCache(1000);
    const load = vi.fn(async () => null);
    expect(await cache.get("k", load, 0)).toBeNull();
    expect(await cache.get("k", load, 1)).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does nothing with a zero TTL", async () => {
    const cache = new PolicyCache(0);
    const load = vi.fn(async () => 1);
    await cache.get("k", load, 0);
    await cache.get("k", load, 0);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keys entries separately and forgets them all on clear", async () => {
    const cache = new PolicyCache(1000);
    expect(await cache.get("a", async () => "A", 0)).toBe("A");
    expect(await cache.get("b", async () => "B", 0)).toBe("B");
    expect(await cache.get("a", async () => "stale", 1)).toBe("A");
    cache.clear();
    expect(await cache.get("a", async () => "fresh", 2)).toBe("fresh");
  });

  it("lets a loader's throw through and caches nothing from it", async () => {
    const cache = new PolicyCache(1000);
    await expect(cache.get("k", async () => { throw new Error("down"); }, 0)).rejects.toThrow("down");
    expect(await cache.get("k", async () => "up", 1)).toBe("up");
  });
});
