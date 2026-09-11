import { describe, expect, it } from "vitest";
import { runSeed, type ReadResult } from "../../../scripts/seed-local-fixtures";
import type { LocalSeedObject } from "../../fixtures/local-seed";

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
const STALE_FIXTURE_ROW = {
  id: "rd_FXATTENT01",
  key_prefix: "readings/2026/09/07T093000Z-rd_FXATTENT01",
  url: "https://fieldnotes.example/2026/a-quieter-internet",
  status: "ready",
  created_at: "2026-09-07T09:30:00.000Z",
  updated_at: "2026-09-07T09:31:00.000Z",
} as const;

interface DepsOptions {
  failingKeys?: Set<string>;
  flakyKeys?: Set<string>;
  /** What reads of index/list.json return, in call order. */
  listReads?: ReadResult[];
  /** When true, the dev-server guard reports a listener. */
  devServerUp?: boolean;
}

function makeDeps(opts: DepsOptions = {}) {
  const puts: LocalSeedObject[] = [];
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
      listening: async () => opts.devServerUp === true,
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
        // The pre-merge reads happen before any put (failures are
        // side-effect-free), so replay the first scripted result for every
        // pre-merge attempt, then the second for verification, and otherwise
        // verify against whatever the seeder last wrote.
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
    },
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

  it("merges fixture rows into an existing list index, preserving foreign rows and replacing fixture rows", async () => {
    const existing = JSON.stringify({
      version: 1,
      items: [FOREIGN_ROW, STALE_FIXTURE_ROW],
    });
    const { deps, puts, logs, restoreWarn } = makeDeps({
      listReads: [{ kind: "found", body: existing }],
    });
    try {
      const code = await runSeed(deps);
      expect(code).toBe(0);
      const list = lastWrittenList(puts);
      const ids = list.items.map((i) => i.id);
      expect(ids).toContain("rd_HANDSEED01");
      expect(ids.filter((id) => id === "rd_FXATTENT01")).toHaveLength(1);
      expect(logs.some((l) => l.includes("Preserved 1 pre-existing list rows"))).toBe(true);
    } finally {
      restoreWarn();
    }
  });

  it("seeds a fixture-only index when none exists", async () => {
    const { deps, puts, restoreWarn } = makeDeps({ listReads: [{ kind: "missing" }] });
    try {
      const code = await runSeed(deps);
      expect(code).toBe(0);
      const list = lastWrittenList(puts);
      expect(list.items.length).toBeGreaterThanOrEqual(18);
    } finally {
      restoreWarn();
    }
  });

  it("writes nothing when the dev server is running", async () => {
    const { deps, puts, errors, restoreWarn } = makeDeps({ devServerUp: true });
    try {
      const code = await runSeed(deps);
      expect(code).toBe(1);
      expect(puts).toHaveLength(0);
      expect(errors.some((e) => e.includes("Stop `npm run dev`"))).toBe(true);
    } finally {
      restoreWarn();
    }
  });

  it("writes nothing when the existing index cannot be read, even after retries", async () => {
    const { deps, puts, errors, restoreWarn } = makeDeps({
      listReads: [{ kind: "error", output: "simulated SQLite lock" }],
    });
    try {
      const code = await runSeed(deps);
      expect(code).toBe(1);
      expect(puts).toHaveLength(0);
      expect(errors.some((e) => e.includes("could not read index/list.json"))).toBe(true);
    } finally {
      restoreWarn();
    }
  });

  it("writes nothing when the existing index does not parse", async () => {
    const { deps, puts, errors, restoreWarn } = makeDeps({
      listReads: [{ kind: "found", body: "not json" }],
    });
    try {
      const code = await runSeed(deps);
      expect(code).toBe(1);
      expect(puts).toHaveLength(0);
      expect(errors.some((e) => e.includes("does not parse"))).toBe(true);
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
