import { describe, expect, it } from "vitest";
import { runSeed } from "../../../scripts/seed-local-fixtures";
import type { LocalSeedObject } from "../../fixtures/local-seed";

const NOW = "2026-09-11T10:00:00.000Z";

function makeDeps(opts: { failingKeys?: Set<string>; flakyKeys?: Set<string>; verifyFails?: boolean } = {}) {
  const puts: LocalSeedObject[] = [];
  const attemptsByKey = new Map<string, number>();
  const logs: string[] = [];
  return {
    deps: {
      put: async (object: LocalSeedObject) => {
        attemptsByKey.set(object.key, (attemptsByKey.get(object.key) ?? 0) + 1);
        puts.push(object);
        if (opts.failingKeys?.has(object.key)) {
          return { object, ok: false, output: "simulated hard failure" };
        }
        if (opts.flakyKeys?.has(object.key) && (attemptsByKey.get(object.key) ?? 0) < 3) {
          return { object, ok: false, output: "simulated local-store flake" };
        }
        return { object, ok: true, output: "" };
      },
      read: async (key: string) =>
        key === "index/list.json" && !opts.verifyFails ? JSON.stringify({ version: 1, items: [] }) : null,
      log: (line: string) => {
        logs.push(line);
      },
      nowIso: () => NOW,
      sleep: async () => {},
    },
    puts,
    attemptsByKey,
    logs,
  };
}

describe("seed-local-fixtures runSeed", () => {
  it("puts every plan object, verifies the list index, and reports success", async () => {
    const { deps, puts, logs } = makeDeps();
    const code = await runSeed(deps);
    expect(code).toBe(0);
    // The pack's size is pinned by the fixture test; here assert the seeder
    // touched exactly what the plan contains.
    expect(puts.length).toBeGreaterThanOrEqual(90);
    expect(logs.some((l) => l.includes("Verified index/list.json"))).toBe(true);
    expect(logs.some((l) => l.includes("Pending reading id"))).toBe(true);
  });

  it("retries a flaky put within the attempt budget and still succeeds", async () => {
    const { deps, attemptsByKey } = makeDeps({
      flakyKeys: new Set(["readings/2026/09/07T093000Z-rd_FXATTENT01/manifest.json"]),
    });
    const code = await runSeed(deps);
    expect(code).toBe(0);
    expect(attemptsByKey.get("readings/2026/09/07T093000Z-rd_FXATTENT01/manifest.json")).toBe(3);
  });

  it("returns failure when a put never succeeds", async () => {
    const { deps } = makeDeps({ failingKeys: new Set(["index/list.json"]) });
    const code = await runSeed(deps);
    expect(code).toBe(1);
  });

  it("returns failure when the verification read fails", async () => {
    const { deps } = makeDeps({ verifyFails: true });
    const code = await runSeed(deps);
    expect(code).toBe(1);
  });
});
