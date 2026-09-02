import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../../scripts/lib/concurrency";

/** A promise a test resolves by hand, so completion order is a test input. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("mapWithConcurrency", () => {
  it("returns results in input order however they complete", async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const run = mapWithConcurrency([0, 1, 2], 3, (index) => gates[index]!.promise);
    gates[2]!.resolve("c");
    gates[0]!.resolve("a");
    gates[1]!.resolve("b");
    await expect(run).resolves.toEqual(["a", "b", "c"]);
  });

  it("never runs more than the limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency(
      Array.from({ length: 40 }, (_, i) => i),
      8,
      async (item) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return item * 2;
      },
    );
    expect(peak).toBe(8);
    expect(results).toEqual(Array.from({ length: 40 }, (_, i) => i * 2));
  });

  it("passes the index alongside the item", async () => {
    await expect(
      mapWithConcurrency(["a", "b"], 2, async (item, index) => `${index}:${item}`),
    ).resolves.toEqual(["0:a", "1:b"]);
  });

  it("runs sequentially when the limit is one", async () => {
    const order: number[] = [];
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 1, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      order.push(item);
      inFlight--;
    });
    expect(peak).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });

  it("rejects with the first failure and stops starting new work", async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (item) => {
        started.push(item);
        await Promise.resolve();
        if (item === 1) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");
    // Work already in flight when the failure lands still finishes, so the
    // contract is that the pass stops pulling, not that it stops instantly.
    expect(started.length).toBeLessThan(6);
    expect(started.slice(0, 2)).toEqual([0, 1]);
  });

  it("still runs every item when the limit is not a usable number", async () => {
    const seen: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3], Number.NaN, async (item) => {
        seen.push(item);
        return item;
      }),
    ).resolves.toEqual([1, 2, 3]);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("returns an empty array for no items", async () => {
    await expect(mapWithConcurrency([], 8, async () => 1)).resolves.toEqual([]);
  });
});
