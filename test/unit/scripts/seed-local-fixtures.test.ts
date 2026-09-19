import { describe, expect, it } from "vitest";
import { runSeed, type ReadResult } from "../../../scripts/seed-local-fixtures";
import type { LocalSeedObject, LocalSeedPlan } from "../../fixtures/local-seed";

const NOW = "2026-09-11T10:00:00.000Z";
const LIST_KEY = "index/list.json";

const FOREIGN_ROW = {
  id: "rd_HANDSEED01",
  key_prefix: "readings/2026/08/01T000000Z-rd_HANDSEED01",
  url: "https://hand-seeded.example/reading",
  status: "ready",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:01:00.000Z",
} as const;

interface DepsOptions {
  failingKeys?: Set<string>;
  flakyKeys?: Set<string>;
  /** What reads of index/list.json return, in call order. */
  listReads?: ReadResult[];
  postgresError?: string;
}

function makeDeps(opts: DepsOptions = {}) {
  const puts: LocalSeedObject[] = [];
  const postgresPlans: LocalSeedPlan[] = [];
  const attemptsByKey = new Map<string, number>();
  const logs: string[] = [];
  const errors: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = (message: string) => {
    errors.push(message);
  };
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
      read: async (key: string): Promise<ReadResult> => {
        if (key !== LIST_KEY) return { kind: "missing" };
        const script = opts.listReads ?? [];
        // Replay the first scripted result for any read before a put (what a
        // pre-existing index would return), then the second for verification,
        // and otherwise verify against whatever the seeder last wrote.
        if (puts.length === 0) {
          return script[0] ?? ({ kind: "missing" } as ReadResult);
        }
        if (script[1] !== undefined) return script[1];
        const written = [...puts].reverse().find((o) => o.key === LIST_KEY);
        return written === undefined
          ? ({ kind: "missing" } as ReadResult)
          : ({ kind: "found", body: written.body } as ReadResult);
      },
      log: (line: string) => {
        logs.push(line);
      },
      nowIso: () => NOW,
      sleep: async () => {},
      seedPostgres: async (plan: LocalSeedPlan) => {
        postgresPlans.push(plan);
        if (opts.postgresError) throw new Error(opts.postgresError);
        return { tenantId: "usr_local", readings: plan.fixtures.length, embeddings: 0 };
      },
    },
    postgresPlans,
    puts,
    attemptsByKey,
    logs,
    errors,
    restoreWarn() {
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
}

function lastWrittenList(puts: LocalSeedObject[]): { version: number; items: Array<{ id: string }> } {
  const list = [...puts].reverse().find((o) => o.key === LIST_KEY);
  expect(list).toBeDefined();
  return JSON.parse(list!.body);
}

describe("seed-local-fixtures runSeed", () => {
  it("puts every plan object, verifies the list index, and reports success", async () => {
    const { deps, puts, logs, restoreWarn } = makeDeps();
    try {
      const code = await runSeed(deps);
      expect(code).toBe(0);
      expect(puts.length).toBeGreaterThanOrEqual(90);
      expect(logs.some((l) => l.includes("Verified index/list.json"))).toBe(true);
      expect(logs.some((l) => l.includes("Pending reading id"))).toBe(true);
    } finally {
      restoreWarn();
    }
  });

  it("seeds PostgreSQL with the same plan after R2 verifies, and fails the run when that fails", async () => {
    const seeded = makeDeps();
    const failing = makeDeps({ postgresError: "connection refused" });
    try {
      expect(await runSeed(seeded.deps)).toBe(0);
      expect(seeded.postgresPlans).toHaveLength(1);
      expect(seeded.postgresPlans[0]!.objects).toEqual(seeded.puts);
      expect(seeded.logs.some((l) => l.startsWith("Seeded PostgreSQL:"))).toBe(true);

      expect(await runSeed(failing.deps)).toBe(1);
      expect(failing.errors.join("\n")).toContain("PostgreSQL seed failed: connection refused");
    } finally {
      seeded.restoreWarn();
      failing.restoreWarn();
    }
  });

  it("retries a flaky put within the attempt budget and still succeeds", async () => {
    const { deps, attemptsByKey, restoreWarn } = makeDeps({
      flakyKeys: new Set(["readings/2026/09/07T093000Z-rd_FXATTENT01/manifest.json"]),
    });
    try {
      const code = await runSeed(deps);
      expect(code).toBe(0);
      expect(attemptsByKey.get("readings/2026/09/07T093000Z-rd_FXATTENT01/manifest.json")).toBe(3);
    } finally {
      restoreWarn();
    }
  });

  it("overwrites any existing list index with the pack's rows, written last", async () => {
    const existing = JSON.stringify({ version: 1, items: [FOREIGN_ROW] });
    const { deps, puts, restoreWarn } = makeDeps({
      listReads: [{ kind: "found", body: existing }],
    });
    try {
      const code = await runSeed(deps);
      expect(code).toBe(0);
      const list = lastWrittenList(puts);
      const ids = list.items.map((i) => i.id);
      expect(ids).not.toContain("rd_HANDSEED01");
      expect(ids).toHaveLength(19);
      expect(puts.at(-1)?.key).toBe(LIST_KEY);
    } finally {
      restoreWarn();
    }
  });

  it("returns failure when a put never succeeds", async () => {
    const { deps, restoreWarn } = makeDeps({ failingKeys: new Set([LIST_KEY]) });
    try {
      const code = await runSeed(deps);
      expect(code).toBe(1);
    } finally {
      restoreWarn();
    }
  });

  it("returns failure when the verification read fails", async () => {
    const { deps, restoreWarn } = makeDeps({
      listReads: [{ kind: "missing" }, { kind: "error", output: "simulated read failure" }],
    });
    try {
      const code = await runSeed(deps);
      expect(code).toBe(1);
    } finally {
      restoreWarn();
    }
  });
});
