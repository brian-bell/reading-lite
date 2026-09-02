import { describe, expect, it } from "vitest";
import { mapWithConcurrency, runKeyedPool } from "../../../scripts/lib/concurrency";

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

describe("runKeyedPool", () => {
  const collect = async <T, R>(
    items: readonly T[],
    limit: number,
    keysOf: (item: T, index: number) => readonly string[],
    fn: (item: T, index: number) => Promise<R>,
  ) => {
    const emitted: Array<{ result: R; index: number }> = [];
    await runKeyedPool(items, limit, keysOf, fn, (result, index) =>
      emitted.push({ result, index }),
    );
    return emitted;
  };

  it("emits results in input order however they complete", async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const emitted: string[] = [];
    const run = runKeyedPool(
      [0, 1, 2],
      3,
      () => [],
      (index) => gates[index]!.promise,
      (result: string) => emitted.push(result),
    );
    gates[2]!.resolve("c");
    gates[1]!.resolve("b");
    await Promise.resolve();
    // Nothing may be emitted while item 0 is outstanding, even though the two
    // behind it are done.
    expect(emitted).toEqual([]);
    gates[0]!.resolve("a");
    await run;
    expect(emitted).toEqual(["a", "b", "c"]);
  });

  it("emits a completed prefix without waiting for the whole pass", async () => {
    const gates = [deferred<string>(), deferred<string>()];
    const emitted: string[] = [];
    const run = runKeyedPool(
      [0, 1],
      2,
      () => [],
      (index) => gates[index]!.promise,
      (result: string) => emitted.push(result),
    );
    gates[0]!.resolve("a");
    // One microtask turn is enough: the first result does not wait on the
    // second, which is what keeps a long execute pass from going silent.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitted).toEqual(["a"]);
    gates[1]!.resolve("b");
    await run;
    expect(emitted).toEqual(["a", "b"]);
  });

  it("never runs more than the limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const emitted = await collect(
      Array.from({ length: 40 }, (_, i) => i),
      4,
      (item) => [`k${item}`],
      async (item) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return item;
      },
    );
    expect(peak).toBe(4);
    expect(emitted.map((entry) => entry.result)).toEqual(
      Array.from({ length: 40 }, (_, i) => i),
    );
    expect(emitted.map((entry) => entry.index)).toEqual(
      Array.from({ length: 40 }, (_, i) => i),
    );
  });

  it("never runs two items that name the same key at the same time", async () => {
    // Every item shares a key with its neighbour, so a plain pool of four
    // would overlap them; only the exclusion keeps them apart.
    const items = [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["d", "e"],
      ["e", "f"],
      ["a", "f"],
    ];
    const held = new Set<string>();
    const clashes: string[] = [];
    let peak = 0;
    let inFlight = 0;
    await collect(
      items,
      4,
      (item) => item,
      async (item) => {
        for (const key of item) {
          if (held.has(key)) clashes.push(key);
          held.add(key);
        }
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        for (const key of item) held.delete(key);
        return item.join("");
      },
    );
    expect(clashes).toEqual([]);
    // Still parallel: disjoint items ran together.
    expect(peak).toBeGreaterThan(1);
  });

  it("runs an item blocked on a key as soon as the holder releases it", async () => {
    const order: string[] = [];
    await collect(
      ["a", "a", "b"],
      2,
      (item) => [item],
      async (item, index) => {
        order.push(`start ${item}${index}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(`end ${item}${index}`);
        return item;
      },
    );
    // The second "a" waits for the first, while "b" overlaps both.
    expect(order.indexOf("start a1")).toBeGreaterThan(order.indexOf("end a0"));
    expect(order.indexOf("start b2")).toBeLessThan(order.indexOf("end a0"));
  });

  it("rejects with the first failure and stops starting new work", async () => {
    const started: number[] = [];
    const emitted: number[] = [];
    await expect(
      runKeyedPool(
        [0, 1, 2, 3, 4, 5],
        2,
        (item) => [`k${item}`],
        async (item: number) => {
          started.push(item);
          await Promise.resolve();
          if (item === 1) throw new Error("boom");
          return item;
        },
        (result: number) => emitted.push(result),
      ),
    ).rejects.toThrow("boom");
    expect(started.length).toBeLessThan(6);
  });

  it("does nothing for no items", async () => {
    await expect(collect([], 4, () => [], async () => 1)).resolves.toEqual([]);
  });

  it("still runs every item when the limit is not a usable number", async () => {
    const emitted = await collect(
      [1, 2, 3],
      Number.NaN,
      () => [],
      async (item) => item,
    );
    expect(emitted.map((entry) => entry.result)).toEqual([1, 2, 3]);
  });
});
