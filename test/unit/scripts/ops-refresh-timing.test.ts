import { describe, expect, it } from "vitest";
import {
  PHASE_MANIFEST_READ,
  PHASE_PLANNING_READS,
  createRefreshTimer,
  printTiming,
  timedNeighboursStore,
  timedRefreshStorage,
} from "../../../scripts/ops-lib/refresh-timing";
import {
  REFRESH_STATE_VERSION,
  REVERSE_TOP_K,
} from "../../../scripts/corpus-lib/refresh-scope";

/** A fake clock that advances a fixed step on every read. */
function fakeClock(stepMs: number, startMs = 1_000) {
  let value = startMs - stepMs;
  return () => {
    value += stepMs;
    return value;
  };
}

describe("refresh timing block", () => {
  it("counts calls and wall time per phase and reports a total", async () => {
    // 10ms per clock read: the timer reads twice per measured call, so each
    // call costs 10ms and the total spans every read taken so far.
    const timer = createRefreshTimer(fakeClock(10));

    await timer.measure("list read", async () => "items");
    await timer.measure("planning reads", async () => 1);
    await timer.measure("planning reads", async () => 2);

    expect(timer.format().split("\n")).toEqual([
      "Timing:",
      "  list read        1 call  0.010s",
      "  planning reads  2 calls  0.020s",
      "  total                    0.070s",
    ]);
  });

  it("floors a backward clock step at zero rather than reporting a negative time", async () => {
    const timer = createRefreshTimer(fakeClock(-1_000, 10_000));
    const { ms } = await timer.measured("provider", async () => 0);
    expect(ms).toBe(0);
    expect(timer.format()).toContain("0.000s");
    expect(timer.format()).not.toContain("-");
  });

  it("hands back the duration of a single call for per-call reporting", async () => {
    const timer = createRefreshTimer(fakeClock(250));
    const { value, ms } = await timer.measured("provider", async () => "judged");
    expect(value).toBe("judged");
    expect(ms).toBe(250);
  });

  it("counts a failed call, whose wall time is exactly what a timeout burns", async () => {
    const timer = createRefreshTimer(fakeClock(30_000));
    await expect(
      timer.measure("manifest read", async () => {
        throw new Error("timed out");
      }),
    ).rejects.toThrow("timed out");
    expect(timer.format()).toMatch(/manifest read\s+1 call\s+30.000s/);
  });

  it("prints nothing when the run failed before it timed anything", async () => {
    const lines: string[] = [];
    const timer = createRefreshTimer(fakeClock(10));
    printTiming(timer, (line) => lines.push(line));
    expect(lines).toEqual([]);

    await timer.measure("list read", async () => 0);
    printTiming(timer, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Timing:");
  });

  it("omits phases that never ran and keeps first-use order", async () => {
    const timer = createRefreshTimer(fakeClock(5));
    await timer.measure("provider", async () => 0);
    await timer.measure("list read", async () => 0);
    const lines = timer.format().split("\n");
    expect(lines[1]).toContain("provider");
    expect(lines[2]).toContain("list read");
    expect(timer.format()).not.toContain("manifest write");
  });
});

describe("timed storage wrappers", () => {
  it("attributes tier-1 store calls to their phases and passes arguments through", async () => {
    const timer = createRefreshTimer(fakeClock(1));
    const calls: string[] = [];
    const store = timedNeighboursStore(
      {
        listItems: async () => {
          calls.push("listItems");
          return [];
        },
        readRefreshState: async () => {
          calls.push("readRefreshState");
          return null;
        },
        writeRefreshState: async (state) => {
          calls.push(`writeRefreshState:${state.last_run_at}`);
        },
        readManifest: async (id) => {
          calls.push(`readManifest:${id}`);
          return { id };
        },
        queryByVectorId: async (id, topK) => {
          calls.push(`query:${id}:${topK}`);
          return [];
        },
        setSimilarity: async (id) => {
          calls.push(`setSimilarity:${id}`);
          return true;
        },
      },
      timer,
    );

    await store.listItems();
    await store.readRefreshState();
    // The scoping topK is what makes a query a reverse one; any other is a
    // measurement.
    await store.queryByVectorId("rd_a", REVERSE_TOP_K);
    await store.queryByVectorId("rd_a", 6);
    expect(await store.readManifest("rd_a")).toEqual({ id: "rd_a" });
    await store.setSimilarity("rd_a", { count: 0, computed_at: "2026-08-22T12:00:00.000Z" });
    await store.writeRefreshState(
      { version: REFRESH_STATE_VERSION, last_run_at: "2026-08-22T12:00:00.000Z", list_ids: ["rd_a"] },
      "2026-08-22T12:00:00.000Z",
    );

    expect(calls).toEqual([
      "listItems",
      "readRefreshState",
      `query:rd_a:${REVERSE_TOP_K}`,
      "query:rd_a:6",
      "readManifest:rd_a",
      "setSimilarity:rd_a",
      "writeRefreshState:2026-08-22T12:00:00.000Z",
    ]);
    const block = timer.format();
    expect(block).toContain("list read");
    expect(block).toContain("run marker");
    expect(block).toContain("reverse query");
    expect(block).toContain("similarity query");
    expect(block).toContain("reading read");
    expect(block).toContain("reading write");
  });

  it("splits tier-2/3 reading reads between planning and execute", async () => {
    const timer = createRefreshTimer(fakeClock(1));
    let phase = PHASE_PLANNING_READS;
    const storage = timedRefreshStorage(
      {
        listItems: async () => [],
        readManifest: async (id) => ({ manifest: { id }, version: "v" }),
        replaceRelationships: async () => ({ replaced: true, skippedTargets: [] }),
      },
      timer,
      () => phase,
    );

    await storage.listItems();
    await storage.readManifest("rd_a");
    await storage.readManifest("rd_b");
    phase = PHASE_MANIFEST_READ;
    await storage.readManifest("rd_a");
    await storage.replaceRelationships([]);

    const block = timer.format();
    expect(block).toMatch(/planning reads\s+2 calls/);
    expect(block).toMatch(/reading read\s+1 call\s/);
    expect(block).toMatch(/reading write\s+1 call\s/);
  });
});
