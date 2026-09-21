import { describe, expect, it } from "vitest";
import {
  corpusRefreshNeighboursCommand,
  type CorpusRefreshNeighboursDeps,
  type CorpusRefreshNeighboursStore,
} from "../../../scripts/ops-lib/commands/corpus-refresh-neighbours";
import { UsageError, type CommandIo } from "../../../scripts/ops-lib/contract";
import type { RefreshNeighbour, RefreshRow } from "../../../scripts/corpus-lib/refresh-neighbours";
import { REFRESH_CANDIDATE_TOP_K } from "../../../src/modules/refresh-neighbours";
import {
  REFRESH_STATE_VERSION,
  REVERSE_SCORE_BOUND,
  REVERSE_TOP_K,
  type RefreshState,
} from "../../../scripts/corpus-lib/refresh-scope";

function io(): { io: CommandIo; lines: string[] } {
  const lines: string[] = [];
  return { io: { stdout: (t) => lines.push(t), stderr: (t) => lines.push(t) }, lines };
}

const AT = "2026-08-01T00:00:00.000Z";
const LATER = "2026-08-20T00:00:00.000Z";
/** Every pass addresses one tenant's rows; `global` has none and is refused. */
const TENANT = "usr_11111111-1111-4111-8111-111111111111";

const READY: RefreshRow = {
  id: "rd_r",
  url: "https://a.example/x",
  status: "ready",
  created_at: AT,
  updated_at: AT,
  key_prefix: "readings/rd_r",
  novelty_verdict: "novel",
  similarity: { count: 0, computed_at: AT },
};

const NEIGHBOUR: RefreshRow = {
  id: "rd_n",
  url: "https://b.example/y",
  status: "ready",
  created_at: LATER,
  updated_at: LATER,
  key_prefix: "readings/rd_n",
};

const VALID_MANIFEST = {
  id: "rd_r",
  url: "https://a.example/x",
  url_hash: "a".repeat(64),
  status: "ready",
  title: "A title",
  tldr: "A stored TL;DR.",
  tags: ["ai"],
  keywords: ["one", "two", "three"],
  people: ["Ada"],
  orgs: ["OpenAI"],
  summary_markdown: "body",
  novelty_verdict: "novel",
  connections: [] as { id: string; reason: string }[],
  content_type: "text/html",
  content_status: "captured",
  content_bytes: 10,
  content_sha256: "b".repeat(64),
  created_at: AT,
  updated_at: AT,
};

function makeDeps(opts: {
  items?: RefreshRow[];
  matches?: RefreshNeighbour[] | null;
  /** Per-id match override, so a reverse query can answer differently. */
  matchesFor?: (id: string, topK: number) => RefreshNeighbour[] | null | undefined;
  manifest?: unknown;
  /** Per-id manifest override, so one reading can be broken and another not. */
  manifestFor?: (id: string) => unknown | undefined;
  /** The store refusing to parse a reading's rows. */
  manifestThrow?: string;
  /** The same, for one reading while the others read normally. */
  manifestThrowFor?: (id: string) => string | undefined;
  queryThrow?: (id: string) => Error | undefined;
  writeThrow?: (id: string) => Error | undefined;
  /** A reading purged between the corpus read and its snapshot write. */
  writeMisses?: (id: string) => boolean;
  state?: unknown;
  stateThrow?: string;
  stateWriteThrow?: string;
}) {
  const { io: cio, lines } = io();
  const calls = {
    queries: [] as Array<{ id: string; topK: number }>,
    snapshots: [] as Array<{ id: string; similarity: Record<string, unknown> }>,
    stateReads: 0,
    stateWrites: [] as unknown[],
    reports: [] as Array<{ path: string; body: string }>,
    mkdirs: [] as string[],
  };
  const store: CorpusRefreshNeighboursStore = {
    listItems: async () => opts.items ?? [READY, NEIGHBOUR],
    readRefreshState: async () => {
      calls.stateReads++;
      if (opts.stateThrow) throw new Error(opts.stateThrow);
      return opts.state ?? null;
    },
    writeRefreshState: async (state) => {
      if (opts.stateWriteThrow) throw new Error(opts.stateWriteThrow);
      calls.stateWrites.push(state);
    },
    readManifest: async (id) => {
      if (opts.manifestThrow) throw new Error(opts.manifestThrow);
      const thrownFor = opts.manifestThrowFor?.(id);
      if (thrownFor) throw new Error(thrownFor);
      const override = opts.manifestFor?.(id);
      if (override !== undefined) return override as Record<string, unknown> | null;
      if (opts.manifest !== undefined) return opts.manifest as Record<string, unknown> | null;
      return { ...VALID_MANIFEST, id };
    },
    queryByVectorId: async (id, topK) => {
      calls.queries.push({ id, topK });
      const thrown = opts.queryThrow?.(id);
      if (thrown) throw thrown;
      const override = opts.matchesFor?.(id, topK);
      if (override !== undefined) return override;
      if (opts.matches === null) return null;
      return opts.matches ?? [
        { id: "rd_r", score: 1 },
        {
          id: "rd_n",
          score: 0.72,
          title: "Neighbour",
          tldr: "About N",
          tags: ["ml"],
          created_at: LATER,
        },
      ];
    },
    setSimilarity: async (id, similarity) => {
      const thrown = opts.writeThrow?.(id);
      if (thrown) throw thrown;
      if (opts.writeMisses?.(id)) return false;
      calls.snapshots.push({ id, similarity: similarity as unknown as Record<string, unknown> });
      return true;
    },
  };
  const deps: CorpusRefreshNeighboursDeps = {
    io: cio,
    withStore: (_target, work) => work(store),
    now: () => Date.parse("2026-08-22T12:00:00Z"),
    mkdir: async (dir) => {
      calls.mkdirs.push(dir);
    },
    writeFile: async (filePath, body) => {
      calls.reports.push({ path: filePath, body });
    },
  };
  return { deps, store, lines, calls };
}

/** A fake clock that advances a fixed step on every read. */
function fakeClock(stepMs: number, startMs = Date.parse("2026-08-22T12:00:00Z")) {
  let value = startMs - stepMs;
  return () => {
    value += stepMs;
    return value;
  };
}

describe("ops corpus refresh-neighbours", () => {
  it("reports five ready neighbours when a stale vector ranks ahead of them", async () => {
    const neighbours = Array.from({ length: 5 }, (_, i) => ({ ...NEIGHBOUR, id: `rd_n${i}` }));
    const { deps, calls } = makeDeps({
      items: [READY, ...neighbours],
      matchesFor: (id, topK) => [
        { id, score: 1 }, { id: "rd_purged", score: 0.99 },
        ...neighbours.map((n, i) => ({ id: n.id, score: 0.9 - i * 0.01 })),
      ].slice(0, topK),
    });
    expect(await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, "rd_r"], deps)).toBe(0);
    const report = JSON.parse(calls.reports[0]!.body);
    expect(report.readings[0].current_neighbours.map((n: { id: string }) => n.id)).toEqual(neighbours.map(n => n.id));
  });

  describe("full sweep cadence", () => {
    const marker = { version: REFRESH_STATE_VERSION, last_run_at: "2026-08-21T00:00:00.000Z", list_ids: ["rd_r", "rd_n"] };
    const warning = (lines: string[]) => lines.filter((line) => line.includes("Full sweep overdue:"));

    it.each(["2026-08-22T00:00:00.000Z", "2026-08-15T12:00:00.000Z"])("does not warn for a recent sweep or exactly seven days: %s", async (last_full_run_at) => {
      for (const flags of [[], ["--execute", "--sole-writer"]]) {
        const { deps, lines } = makeDeps({ state: { ...marker, last_full_run_at } });
        await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, ...flags], deps);
        expect(warning(lines)).toEqual([]);
      }
    });

    it.each([
      null,
      { ...marker, last_full_run_at: "damaged" },
      { ...marker, list_ids: "damaged", last_full_run_at: "2026-08-22T00:00:00.000Z" },
    ])("warns with unknown age for missing or damaged marker data: %j", async (state) => {
      for (const flags of [[], ["--execute", "--sole-writer"]]) {
        const { deps, lines } = makeDeps({ state });
        await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, ...flags], deps);
        expect(warning(lines)).toHaveLength(1);
        expect(warning(lines)[0]).toContain("age unknown");
      }
    });

    it("only clears the warning after a completed executing full sweep", async () => {
      let stored: unknown = { ...marker, last_full_run_at: "2026-08-01T00:00:00.000Z" };
      async function run(flags: string[], fail = false) {
        const h = makeDeps({ queryThrow: fail ? () => new Error("offline") : undefined });
        h.store.readRefreshState = async () => stored;
        h.store.writeRefreshState = async (state) => { stored = state; };
        const code = await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, ...flags], h.deps);
        return { ...h, code };
      }
      await run(["--full"]);
      expect(warning((await run([])).lines)).toHaveLength(1);
      expect((await run(["--full", "--execute", "--sole-writer"], true)).code).toBe(1);
      expect(warning((await run([])).lines)).toHaveLength(1);
      expect((await run(["--full", "--execute", "--sole-writer"])).code).toBe(0);
      expect(warning((await run([])).lines)).toEqual([]);
      expect(stored).toMatchObject({ last_full_run_at: "2026-08-22T12:00:00.000Z" });
    });

    // Scheduled jobs often capture only stderr, so the corrective command has
    // to carry the target this pass was actually pointed at: a pasted command
    // that omits --bucket would otherwise sweep a different environment.
    it("names the selected target in the corrective command, on stderr", async () => {
      const { deps } = makeDeps({ state: marker });
      const stderr: string[] = [];
      deps.io.stderr = (line) => stderr.push(line);
      await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--bucket", "reading-lite-staging"],
        deps,
      );
      const [line] = warning(stderr);
      expect(line).toContain("Full sweep overdue: last_full_run_at missing or unusable (age unknown; threshold 7 days)");
      expect(line).toContain(
        `npm run ops -- corpus refresh-neighbours --tenant "${TENANT}" --full --execute --sole-writer --out ./refresh-report-full.json`,
      );
      expect(line).toContain("--bucket reading-lite-staging");
    });

    it("names --local in the corrective command when the pass was local", async () => {
      const { deps, lines } = makeDeps({ state: marker });
      await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, "--local"], deps);
      expect(warning(lines)[0]).toMatch(/--local$/);
    });
  });

  it.each([{ flags: [] }, { flags: ["--execute", "--sole-writer"] }])("warns about an old full sweep with the same age with $flags", async ({ flags }) => {
    const state = { version: REFRESH_STATE_VERSION, last_run_at: "2026-08-21T00:00:00.000Z", list_ids: ["rd_r", "rd_n"], last_full_run_at: "2026-08-14T00:00:00.000Z" };
    const { deps, lines, calls } = makeDeps({ state });
    expect(await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, ...flags], deps)).toBe(0);
    expect(lines.join("\n")).toContain("Full sweep overdue: last_full_run_at 2026-08-14T00:00:00.000Z (age 8.5 days; threshold 7 days)");
    expect(calls.queries).toEqual([]);
    for (const written of calls.stateWrites) expect(written).toMatchObject({ last_full_run_at: state.last_full_run_at });
  });


  it("prints a Timing block naming every phase the pass used", async () => {
    const { deps, lines } = makeDeps({});
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", TENANT], {
      ...deps,
      now: fakeClock(10),
    });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Timing:");
    expect(text).toMatch(/list read\s+1 call\s+0\.010s/);
    // Two ready readings measured: one similarity query and one reading read each.
    expect(text).toMatch(/similarity query\s+2 calls\s+0\.020s/);
    expect(text).toMatch(/reading read\s+2 calls\s+0\.020s/);
    expect(text).toMatch(/total\s+0\.\d\d\ds/);
    // Plan mode writes nothing, so the write phase never ran.
    expect(text).not.toContain("reading write");
  });

  it("counts the reads of a failed run and still prints the block", async () => {
    // Every reading in the sweep fails to parse, which is the whole-scope
    // verdict (exit 1), not the per-reading one.
    const { deps, lines } = makeDeps({ manifestThrow: "row does not parse" });
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", TENANT, "--execute", "--sole-writer"],
      { ...deps, now: fakeClock(5) },
    );
    expect(code).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("Timing:");
    // The failed reads are counted: a stalled read is exactly the wall time an
    // operator needs to see.
    expect(text).toMatch(/reading read\s+2 calls/);
  });

  it("plan mode queries and writes the report but changes no row", async () => {
    const { deps, calls, lines } = makeDeps({});
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", TENANT], deps);
    expect(code).toBe(0);
    expect(calls.queries).toHaveLength(2);
    expect(calls.snapshots).toHaveLength(0);
    expect(calls.reports).toHaveLength(1);
    expect(calls.reports[0]!.path).toMatch(/refresh-report\.json$/);
    const report = JSON.parse(calls.reports[0]!.body);
    expect(report.version).toBe(1);
    expect(report.tenant).toBe(TENANT);
    expect(report.floor).toBe(0.55);
    expect(report.readings[0]).toMatchObject({
      id: "rd_r",
      reasons: ["new_neighbour", "verdict_inconsistent"],
      novelty_verdict: "novel",
      judged_at_source: "updated_at",
    });
    expect(report.readings[0].current_neighbours[0]).toEqual({
      id: "rd_n",
      score: 0.72,
      title: "Neighbour",
      tldr: "About N",
      tags: ["ml"],
      created_at: LATER,
    });
    const text = lines.join("\n");
    expect(text).toContain("Mode: PLAN");
    expect(text).toContain("new_neighbour,verdict_inconsistent");
    expect(text).toContain("PLAN — corpus unchanged");
  });

  it("reports an older uncited neighbour as a membership difference", async () => {
    const olderNeighbour = { ...NEIGHBOUR, created_at: "2026-07-01T00:00:00.000Z" };
    const { deps, calls, lines } = makeDeps({
      items: [READY, olderNeighbour],
      matches: [
        { id: "rd_r", score: 1 },
        {
          id: "rd_n",
          score: 0.72,
          title: "Older neighbour",
          created_at: olderNeighbour.created_at,
        },
      ],
    });

    const code = await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, "rd_r"], deps);

    expect(code).toBe(0);
    expect(JSON.parse(calls.reports[0]!.body).readings[0].reasons).toEqual([
      "uncited_neighbour",
      "verdict_inconsistent",
    ]);
    expect(lines.join("\n")).toContain("uncited_neighbour,verdict_inconsistent");
  });

  it("--execute writes only drifted snapshots, and writes nothing else", async () => {
    const { deps, calls } = makeDeps({});
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", TENANT, "rd_r", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    // One reading, one column: the snapshot is the whole write, so nothing
    // else about the reading can be touched by this pass by construction.
    expect(calls.snapshots).toEqual([
      {
        id: "rd_r",
        similarity: {
          count: 1,
          max: 0.72,
          mean: 0.72,
          computed_at: "2026-08-22T12:00:00.000Z",
        },
      },
    ]);
  });

  it("a second immediate execute writes nothing when the snapshot already matches", async () => {
    const scored: RefreshRow = {
      ...READY,
      similarity: { count: 1, max: 0.72, mean: 0.72, computed_at: AT },
    };
    const { deps, calls } = makeDeps({ items: [scored, NEIGHBOUR] });
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", TENANT, "rd_r", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls.snapshots).toHaveLength(0);
    expect(calls.reports).toHaveLength(1);
  });

  it("does not write a snapshot that only moved below the epsilon", async () => {
    const scored: RefreshRow = {
      ...READY,
      similarity: { count: 1, max: 0.72, mean: 0.72, computed_at: AT },
    };
    const { deps, calls } = makeDeps({
      items: [scored, NEIGHBOUR],
      matches: [
        { id: "rd_r", score: 1 },
        { id: "rd_n", score: 0.729, title: "Neighbour", created_at: LATER },
      ],
    });
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", TENANT, "rd_r", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls.snapshots).toHaveLength(0);
  });

  // The row was purged between the corpus read and the write. Nothing to
  // repair and nothing owed: the next pass sees the id missing and sweeps.
  it("reports a snapshot write that found no row, without failing the pass", async () => {
    const { deps, calls, lines } = makeDeps({ items: [READY], writeMisses: () => true });
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", TENANT, "rd_r", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls.snapshots).toHaveLength(0);
    expect(lines.join("\n")).toContain("rd_r was removed before its snapshot could be written");
  });

  it("counts a failed snapshot write as work the pass still owes", async () => {
    const { deps, calls, lines } = makeDeps({
      items: [READY],
      writeThrow: () => new Error("deadlock detected"),
    });
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", TENANT, "rd_r", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(1);
    expect(calls.stateWrites).toEqual([]);
    expect(lines.join("\n")).toContain("snapshot write failed for rd_r: deadlock detected");
  });

  it("refuses --execute without --sole-writer before reading anything", async () => {
    const { deps, calls, lines } = makeDeps({});
    await expect(
      corpusRefreshNeighboursCommand.run(["--tenant", TENANT, "--execute"], deps),
    ).rejects.toThrow(UsageError);
    expect(calls.queries).toHaveLength(0);
    expect(calls.snapshots).toHaveLength(0);
    expect(calls.reports).toHaveLength(0);
    expect(lines.join("\n")).toContain(
      "REFUSED: ops corpus refresh-neighbours --execute requires --sole-writer.",
    );
  });

  it("--sole-writer without --execute stays a plan and prints no banner", async () => {
    const { deps, calls, lines } = makeDeps({});
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", TENANT, "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls.snapshots).toHaveLength(0);
    const text = lines.join("\n");
    expect(text).toContain("Mode: PLAN");
    expect(text).not.toContain("SOLE-WRITER MODE");
  });

  it("--execute --sole-writer announces the sole-writer banner", async () => {
    const { deps, lines } = makeDeps({});
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", TENANT, "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("SOLE-WRITER MODE: ops corpus refresh-neighbours");
  });

  it("plan mode reports a whole unmeasurable scope as a configuration failure too", async () => {
    const { deps, lines } = makeDeps({ items: [READY], matches: null });
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", TENANT], deps);
    expect(code).toBe(1);
    const text = lines.join("\n");
    expect(text).toMatch(/swept the corpus and measured 0 of 1 ready reading\(s\)/);
    // A plan pass withholds no marker — it never advances one — and the operator
    // still has to be told nothing was written.
    expect(text).toContain("an --execute pass would not have advanced the run marker");
    expect(text).toContain("PLAN — corpus unchanged.");
  });


  // An aborted loop never asked the targets after the throw, so "measured none
  // of them" is not the corpus answering. It still exits 1 through the error.
  it("does not diagnose a configuration failure when the pass aborted", async () => {
    const { deps, store, lines } = makeDeps({ items: [READY, NEIGHBOUR] });
    // Not null and not a match list: the scoring below it throws, which the
    // per-target catches do not cover, so the whole loop unwinds with the
    // remaining targets never attempted.
    store.queryByVectorId = async () => ({}) as never;
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", TENANT], deps);
    expect(code).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("refresh pass aborted");
    expect(text).not.toContain("Configuration failure");
  });

  // One unmeasurable reading among measured ones is the reading's problem, not
  // the operator's: exit 3, not the configuration failure above.
  it("exits 3 in plan mode when some readings are unmeasurable and others are not", async () => {
    const { deps, lines } = makeDeps({
      matchesFor: (id) => (id === "rd_r" ? null : undefined),
    });
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", TENANT], deps);
    expect(code).toBe(3);
    const text = lines.join("\n");
    expect(text).not.toContain("Configuration failure");
    expect(text).toMatch(/need human attention/);
    // The footer is the only line saying nothing was written; a plan pass that
    // found broken readings needs it more than a quiet one does.
    expect(text).toContain("PLAN — corpus unchanged.");
  });

  it("honours --out for the report path", async () => {
    const { deps, calls } = makeDeps({ items: [READY] });
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", TENANT, "--out", "reports/neighbours.json"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls.reports[0]!.path).toMatch(/reports\/neighbours\.json$/);
  });

  it("rejects an unknown flag as usage", async () => {
    const { deps } = makeDeps({});
    await expect(
      corpusRefreshNeighboursCommand.run(["--tenant", TENANT, "--bogus"], deps),
    ).rejects.toThrow(UsageError);
  });

  it("skips a non-ready reading even when named", async () => {
    const failed: RefreshRow = { ...READY, id: "rd_f", status: "failed", key_prefix: "readings/rd_f" };
    const { deps, calls } = makeDeps({ items: [failed] });
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, "rd_f", "--execute", "--sole-writer"], deps);
    expect(code).toBe(0);
    expect(calls.queries).toHaveLength(0);
    expect(calls.snapshots).toHaveLength(0);
  });

  // The store parses what it reads, so a reading whose rows no longer satisfy
  // the schema throws rather than answering with a half-built manifest. It is
  // unmeasurable, not unfinished: diffing what did parse would invent flags.
  it("treats a reading whose rows do not parse as unmeasurable, not a report row", async () => {
    const { deps, calls, lines } = makeDeps({
      items: [READY, NEIGHBOUR],
      manifestThrow: "status: invalid enum value",
    });
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, "rd_r"], deps);
    // The operator named this reading, so measuring none of it says nothing
    // about the configuration: a broken reading needing repair, exit 3.
    expect(code).toBe(3);
    expect(calls.snapshots).toHaveLength(0);
    expect(JSON.parse(calls.reports[0]!.body).readings).toEqual([]);
    expect(lines.join("\n")).toMatch(/reading does not parse for rd_r/);
    expect(lines.join("\n")).toMatch(/these readings need repair/);
    expect(lines.join("\n")).not.toContain("Configuration failure");
  });

  // Purged between the corpus read and its own read. Nothing to measure and
  // nothing to repair, so it is neither a failure nor a retry.
  it("skips a reading purged mid-pass without failing the run", async () => {
    const { deps, calls, lines } = makeDeps({
      items: [READY, NEIGHBOUR],
      manifestFor: (id) => (id === "rd_r" ? null : undefined),
    });
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", TENANT], deps);
    expect(code).toBe(0);
    expect(calls.snapshots).toHaveLength(0);
    expect(lines.join("\n")).toContain("rd_r was removed while this pass ran");
  });

  it("isolates a similarity query failure and still writes the report for measured readings", async () => {
    const other: RefreshRow = { ...NEIGHBOUR, novelty_verdict: "familiar" };
    const { deps, calls, lines } = makeDeps({
      items: [READY, other],
      queryThrow: (id) => (id === "rd_n" ? new Error("connection terminated") : undefined),
    });
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", TENANT], deps);
    expect(code).toBe(1);
    expect(calls.queries.map((q) => q.id)).toEqual(["rd_r", "rd_n"]);
    expect(calls.reports).toHaveLength(1);
    const report = JSON.parse(calls.reports[0]!.body);
    expect(report.readings.map((r: { id: string }) => r.id)).toEqual(["rd_r"]);
    expect(lines.join("\n")).toMatch(/similarity query failed for rd_n/);
    expect(lines.join("\n")).toMatch(/not measured — run incomplete/);
  });

  describe("incremental scope", () => {
    const MARKER: RefreshState = {
      version: REFRESH_STATE_VERSION,
      last_run_at: "2026-08-21T00:00:00.000Z",
      list_ids: ["rd_n", "rd_r"],
    };

    /** Both rows unchanged since the marker, so nothing is in scope. */
    function quietCorpus() {
      return makeDeps({ state: MARKER });
    }

    it.each([{ flags: [] }, { flags: ["--since-last-run"] }])("scopes against the marker by default and under $flags, measuring nothing on a quiet corpus", async ({ flags }) => {
      const { deps, calls, lines } = quietCorpus();
      const code = await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, ...flags], deps);
      expect(code).toBe(0);
      expect(calls.stateReads).toBe(1);
      expect(calls.queries).toEqual([]);
      const text = lines.join("\n");
      expect(text).toContain("Scope: incremental (0 reading(s))");
      expect(text).toContain("To measure: 0");
    });

    it("measures everything under an explicit --full, whatever the marker says", async () => {
      const { deps, calls, lines } = quietCorpus();
      const code = await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, "--full"], deps);
      expect(code).toBe(0);
      // Read, but not scoped against: a full pass overwrites the marker, so it
      // needs the stored one to build the next from.
      expect(calls.stateReads).toBe(1);
      expect(calls.queries).toHaveLength(2);
      expect(lines.join("\n")).toContain("Scope: full — --full");
    });


    it("measures a changed reading and its reverse neighbourhood", async () => {
      const { deps, calls, lines } = makeDeps({
        state: MARKER,
        items: [{ ...READY, updated_at: "2026-08-21T12:00:00.000Z" }, NEIGHBOUR],
        matchesFor: (_id, topK) =>
          topK === REVERSE_TOP_K
            ? [
                { id: "rd_r", score: 1 },
                { id: "rd_n", score: REVERSE_SCORE_BOUND + 0.01 },
                // Below the bound: the evidence that the results ran out
                // before the bound did, so the reverse set is complete.
                { id: "rd_far", score: REVERSE_SCORE_BOUND - 0.2 },
              ]
            : undefined,
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run"],
        deps,
      );
      expect(code).toBe(0);
      const reverse = calls.queries.filter((q) => q.topK === REVERSE_TOP_K);
      expect(reverse).toEqual([{ id: "rd_r", topK: REVERSE_TOP_K }]);
      // The changed reading and the neighbour its vector reaches, both measured.
      const measured = calls.queries.filter((q) => q.topK !== REVERSE_TOP_K).map((q) => q.id);
      expect(measured.sort()).toEqual(["rd_n", "rd_r"]);
      expect(lines.join("\n")).toContain("Scope: incremental (2 reading(s))");
    });

    // A session the server tore down fails every query after it. Spending one
    // per changed reading before sweeping would cost more than the sweep.
    it("stops scoping after a run of failed reverse queries", async () => {
      const changed = Array.from({ length: 10 }, (_, i) => ({
        ...READY,
        id: `rd_${i}`,
        key_prefix: `readings/rd_${i}`,
        updated_at: "2026-08-21T12:00:00.000Z",
      }));
      // Enough quiet readings that the narrowed scope stays the cheaper pass,
      // so it is the failure budget that stops the queries, not the cost rule.
      const quiet = Array.from({ length: 20 }, (_, i) => ({
        ...READY,
        id: `rd_quiet_${i}`,
        key_prefix: `readings/rd_quiet_${i}`,
      }));
      const { deps, calls, lines } = makeDeps({
        state: { ...MARKER, list_ids: [...changed, ...quiet].map((row) => row.id) },
        items: [...changed, ...quiet],
        queryThrow: () => new Error("connection terminated"),
      });
      await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, "--since-last-run"], deps);
      expect(calls.queries.filter((q) => q.topK === REVERSE_TOP_K)).toHaveLength(3);
      // The reason counts what was attempted, not the whole changed set: the
      // seven ids after the stop were never asked, and reporting them as
      // failures would inflate the rate the reason exists to make trustworthy.
      expect(lines.join("\n")).toContain(
        "Scope: full — 3 reverse-neighbour queries failed in a row after 3 of 10 changed reading(s)",
      );
    });

    // A bulk ingest: every ready reading changed, so the reverse queries alone
    // plus measuring the changed readings cost more than sweeping. The pass
    // sweeps without making a single reverse query.
    it("sweeps without reverse queries when the changed set already outweighs the corpus", async () => {
      const changed = Array.from({ length: 10 }, (_, i) => ({
        ...READY,
        id: `rd_${i}`,
        key_prefix: `readings/rd_${i}`,
        updated_at: "2026-08-21T12:00:00.000Z",
      }));
      const { deps, calls, lines } = makeDeps({
        state: { ...MARKER, list_ids: changed.map((row) => row.id) },
        items: changed,
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.queries.filter((q) => q.topK === REVERSE_TOP_K)).toEqual([]);
      expect(calls.queries).toHaveLength(10);
      const reason =
        "incremental scope would cost at least 20 similarity queries " +
        "(10 reverse still to run, 10 reading(s) to measure) against 10 for a full sweep " +
        "— after 0 of 10 changed reading(s)";
      expect(lines.join("\n")).toContain(`Scope: full — ${reason}`);
      expect(JSON.parse(calls.reports[0]!.body).scope).toMatchObject({ kind: "full", reason });
    });

    // The first changed vector's reverse neighbourhood reaches the whole quiet
    // corpus, so the one reverse query still to run can only add cost: the
    // pass stops there instead of making it.
    it("stops making reverse queries once the scope grows past the sweep", async () => {
      const changed = ["rd_a", "rd_b"].map((id) => ({
        ...READY,
        id,
        key_prefix: `readings/${id}`,
        updated_at: "2026-08-21T12:00:00.000Z",
      }));
      const quiet = Array.from({ length: 4 }, (_, i) => ({
        ...READY,
        id: `rd_quiet_${i}`,
        key_prefix: `readings/rd_quiet_${i}`,
      }));
      const { deps, calls, lines } = makeDeps({
        state: { ...MARKER, list_ids: [...changed, ...quiet].map((row) => row.id) },
        items: [...changed, ...quiet],
        matchesFor: (id, topK) =>
          topK === REVERSE_TOP_K
            ? [
                { id, score: 1 },
                ...quiet.map((row) => ({ id: row.id, score: 0.8 })),
                { id: "rd_far", score: REVERSE_SCORE_BOUND - 0.2 },
              ]
            : undefined,
      });
      await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, "--since-last-run"], deps);
      expect(calls.queries.filter((q) => q.topK === REVERSE_TOP_K).map((q) => q.id)).toEqual([
        "rd_a",
      ]);
      expect(lines.join("\n")).toContain(
        "Scope: full — incremental scope would cost at least 7 similarity queries " +
        "(1 reverse still to run, 6 reading(s) to measure) against 6 for a full sweep " +
        "— after 1 of 2 changed reading(s)",
      );
    });

    it("sweeps when the reverse query for a changed reading fails", async () => {
      const { deps, calls, lines } = makeDeps({
        state: MARKER,
        items: [{ ...READY, updated_at: "2026-08-21T12:00:00.000Z" }, NEIGHBOUR],
        queryThrow: (id) => (id === "rd_r" ? new Error("boom") : undefined),
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run"],
        deps,
      );
      // rd_r's measurement query fails too, so the pass is incomplete — but the
      // scope escalated rather than quietly measuring less.
      expect(code).toBe(1);
      const text = lines.join("\n");
      expect(text).toContain("Scope: full — 1 unanswered reverse quer(ies), first rd_r");
      expect(calls.queries.filter((q) => q.topK !== REVERSE_TOP_K)).toHaveLength(2);
    });

    it("sweeps when the marker is absent, unreadable, or unusable", async () => {
      for (const opts of [
        {},
        { stateThrow: "transient" },
        { state: { version: 9 } },
      ] as const) {
        const { deps, lines } = makeDeps({ ...opts });
        const code = await corpusRefreshNeighboursCommand.run(
          ["--tenant", TENANT, "--since-last-run"],
          deps,
        );
        expect(code).toBe(0);
        expect(lines.join("\n")).toContain("Scope: full");
      }
    });

    it("sweeps when the corpus lost a reading, which no timestamp can name", async () => {
      const { deps, lines } = makeDeps({
        state: { ...MARKER, list_ids: ["rd_n", "rd_purged", "rd_r"] },
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run"],
        deps,
      );
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain(
        "Scope: full — 1 reading(s) removed since the last run, first rd_purged",
      );
    });

    // Row counts cannot see this: the corpus is LARGER than the marker's, and
    // two readings are still gone.
    it("sweeps on a purge whose ingests more than replaced the missing rows", async () => {
      const { deps, lines } = makeDeps({
        state: { ...MARKER, list_ids: ["rd_gone_a", "rd_gone_b"] },
        items: [READY, NEIGHBOUR, { ...NEIGHBOUR, id: "rd_n2", key_prefix: "readings/rd_n2" }],
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run"],
        deps,
      );
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain(
        "Scope: full — 2 reading(s) removed since the last run, first rd_gone_a",
      );
    });

    it("sweeps while the marker carries an invalidation", async () => {
      const { deps, lines } = makeDeps({
        state: { ...MARKER, invalidated_by: "corpus backfill-vectors (3 vector(s) restored)" },
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run"],
        deps,
      );
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain(
        "Scope: full — run marker invalidated by corpus backfill-vectors (3 vector(s) restored)",
      );
    });

    it("records the scope in the report header", async () => {
      const { deps, calls } = quietCorpus();
      await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, "--since-last-run"], deps);
      const report = JSON.parse(calls.reports[0]!.body);
      expect(report.scope).toEqual({
        kind: "incremental",
        reason: "0 reading(s) changed since 2026-08-21T00:00:00.000Z",
        since: "2026-08-21T00:00:00.000Z",
        readings_in_scope: 0,
      });
    });

    // A `full` report claims to cover the ready corpus; a hand-picked or capped
    // pass does not, and the report is the only place a later reader can learn
    // that it was narrowed.
    it("records --only and a --limit that truncated in the report scope", async () => {
      const { deps, calls } = makeDeps({ state: MARKER, items: [READY, NEIGHBOUR] });
      await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, "--full", "--limit", "1"], deps);
      expect(JSON.parse(calls.reports[0]!.body).scope).toEqual({
        kind: "full",
        reason: "--full",
        narrowed_by: "--limit 1",
      });
    });


    it("advances the marker only on a complete execute pass", async () => {
      const { deps, calls } = quietCorpus();
      await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, "--since-last-run"], deps);
      expect(calls.stateWrites).toEqual([]);

      const executed = quietCorpus();
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run", "--execute", "--sole-writer"],
        executed.deps,
      );
      expect(code).toBe(0);
      expect(executed.calls.stateWrites).toEqual([
        {
          version: REFRESH_STATE_VERSION,
          last_run_at: "2026-08-22T12:00:00.000Z",
          list_ids: ["rd_n", "rd_r"],
        },
      ]);
    });

    it("records a full sweep as the last full run", async () => {
      const { deps, calls } = makeDeps({ state: MARKER });
      await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--full", "--execute", "--sole-writer"],
        deps,
      );
      expect(calls.stateWrites[0]).toMatchObject({
        last_run_at: "2026-08-22T12:00:00.000Z",
        last_full_run_at: "2026-08-22T12:00:00.000Z",
      });
    });

    // --only names a subset, and --limit cuts one; advancing the marker would
    // claim the readings they skipped had been refreshed.
    it("leaves the marker alone when --only or --limit narrowed the pass", async () => {
      for (const flags of [["rd_r"], ["--limit", "1"]]) {
        const { deps, calls, lines } = makeDeps({ state: MARKER });
        const code = await corpusRefreshNeighboursCommand.run(
          ["--tenant", TENANT, "--full", "--execute", "--sole-writer", ...flags],
          deps,
        );
        expect(code).toBe(0);
        expect(calls.stateWrites).toEqual([]);
        expect(lines.join("\n")).toContain("Run marker unchanged");
      }
    });

    // A limit used as a runaway-cost valve and never reached has measured its
    // whole scope; pinning the marker on the flag alone would make every later
    // night sweep for no reason.
    it("advances the marker when --limit never cut the plan short", async () => {
      const { deps, calls } = makeDeps({ state: MARKER });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--full", "--execute", "--sole-writer", "--limit", "500"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.stateWrites).toHaveLength(1);
      // The report and the marker have to agree: a limit that never truncated
      // narrowed nothing, and the pass is complete by both accounts.
      expect(JSON.parse(calls.reports[0]!.body).scope).not.toHaveProperty("narrowed_by");
    });


    it("records a reading that does not parse as unmeasurable too", async () => {
      const { deps, calls } = makeDeps({
        state: MARKER,
        // rd_n measures normally, so the pass is a partial gap rather than the
        // whole-scope configuration failure below.
        manifestThrowFor: (id) => (id === "rd_r" ? "status: invalid enum value" : undefined),
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--full", "--execute", "--sole-writer"],
        deps,
      );
      expect(code).toBe(3);
      expect(calls.stateWrites[0]).toMatchObject({ unmeasurable_ids: ["rd_r"] });
    });


    // The carried-retry case the marker exists for. On a quiet corpus the whole
    // incremental scope IS the reading the last pass could not measure. Calling
    // that a configuration failure would freeze the marker on one broken
    // reading, grow the scope every night, and page for it forever — and the
    // marker would never record the id, so the pass could never learn better.
    it("does not call a one-reading incremental scope a configuration failure", async () => {
      const { deps, calls, lines } = makeDeps({
        state: { ...MARKER, unmeasurable_ids: ["rd_r"] },
        // rd_r still owns no vector, so the retry fails again.
        matches: null,
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run", "--execute", "--sole-writer"],
        deps,
      );
      const text = lines.join("\n");
      expect(text).toContain("Scope: incremental (1 reading(s))");
      expect(text).not.toContain("Configuration failure");
      expect(code).toBe(3);
      // The marker moved and carried the id on, so the scope does not grow.
      expect(calls.stateWrites[0]).toMatchObject({
        last_run_at: "2026-08-22T12:00:00.000Z",
        unmeasurable_ids: ["rd_r"],
      });
    });


    // A misconfiguration cannot hide in incremental passes: a changed ready
    // reading whose vector cannot be found escalates the scope to a sweep, and
    // the sweep is what reports it.
    it("escalates to a sweep and reports the failure when a changed reading has no vector", async () => {
      const { deps, calls, lines } = makeDeps({
        state: MARKER,
        items: [{ ...READY, updated_at: "2026-08-21T12:00:00.000Z" }, NEIGHBOUR],
        matches: null,
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run", "--execute", "--sole-writer"],
        deps,
      );
      const text = lines.join("\n");
      expect(text).toContain("Scope: full");
      expect(text).toContain("Configuration failure");
      expect(code).toBe(1);
      expect(calls.stateWrites).toEqual([]);
    });

    // --only leaves the marker alone, so the exit line must not say it moved.
    it("does not claim the marker advanced on an exit-3 pass that left it alone", async () => {
      const { deps, calls, lines } = makeDeps({
        state: MARKER,
        manifestThrow: "status: invalid enum value",
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "rd_r", "--execute", "--sole-writer"],
        deps,
      );
      expect(code).toBe(3);
      expect(calls.stateWrites).toEqual([]);
      const text = lines.join("\n");
      expect(text).toContain("Run marker unchanged");
      expect(text).toContain("Exit 3: the pass completed;");
      expect(text).not.toContain("marker advanced");
    });

    // An empty scope is a quiet night, not a failure: nothing to measure is
    // exactly what an incremental pass hopes to find.
    it("exits 0 on an empty scope rather than calling it a configuration failure", async () => {
      // Nothing has moved since the marker, so no reading is in scope at all.
      const { deps, calls, lines } = makeDeps({ state: MARKER, matches: null });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run", "--execute", "--sole-writer"],
        deps,
      );
      expect(code).toBe(0);
      expect(lines.join("\n")).not.toContain("Configuration failure");
      expect(calls.stateWrites).toHaveLength(1);
    });

    // The retried id enters the scope without entering `changed`: treating a
    // vectorless reading as changed would escalate the very pass that exists to
    // retry it.
    it("measures a carried unmeasurable reading on a later quiet night", async () => {
      const { deps, calls, lines } = makeDeps({
        state: { ...MARKER, unmeasurable_ids: ["rd_r"] },
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.queries.map((query) => query.id)).toEqual(["rd_r"]);
      const text = lines.join("\n");
      expect(text).toContain("Scope: incremental (1 reading(s))");
      expect(text).toContain("1 unmeasurable reading(s) carried forward");
    });


    // A full pass takes minutes and nothing locks the marker row between the
    // read and the write, so another writer can stamp it while the pass runs.
    // Writing the pass's own marker over that stamp would clear a sweep nobody
    // did — the exact failure the stamp exists to prevent.
    it("leaves the marker alone when an invalidation arrived mid-pass", async () => {
      let reads = 0;
      const { deps, store, calls, lines } = makeDeps({ state: MARKER });
      const base = store.readRefreshState;
      store.readRefreshState = async () => {
        reads++;
        const state = await base();
        return reads === 1
          ? state
          : { ...(state as Record<string, unknown>), invalidated_by: "corpus backfill-vectors" };
      };
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--full", "--execute", "--sole-writer"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.stateWrites).toEqual([]);
      expect(lines.join("\n")).toContain(
        "Run marker unchanged: invalidated by corpus backfill-vectors while this pass ran",
      );
    });

    // The stamp that made THIS pass a sweep is answered by it, so it must not
    // read as a concurrent one and pin the marker forever.
    it("advances past the invalidation that made this pass a sweep", async () => {
      const { deps, calls } = makeDeps({
        state: { ...MARKER, invalidated_by: "corpus backfill-vectors" },
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run", "--execute", "--sole-writer"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.stateWrites).toHaveLength(1);
      expect(calls.stateWrites[0]).not.toHaveProperty("invalidated_by");
    });

    it("leaves the marker alone when it cannot be re-read before the write", async () => {
      let reads = 0;
      const { deps, store, calls, lines } = makeDeps({ state: MARKER });
      const base = store.readRefreshState;
      store.readRefreshState = async () => {
        reads++;
        if (reads > 1) throw new Error("transient");
        return base();
      };
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--full", "--execute", "--sole-writer"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.stateWrites).toEqual([]);
      expect(lines.join("\n")).toContain("could not re-read the run marker before advancing it");
    });

    // The re-read guard must not refuse to replace the very marker this pass
    // already found unusable, or the corpus would sit on an old-format marker
    // for ever.
    it("replaces an older-format marker it swept against", async () => {
      const { deps, calls } = makeDeps({
        state: { version: 2, last_run_at: "2026-08-21T00:00:00.000Z", list_ids: ["rd_n", "rd_r"], list_etag: "abc" },
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--execute", "--sole-writer"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.stateWrites[0]).toMatchObject({
        version: REFRESH_STATE_VERSION,
        list_ids: ["rd_n", "rd_r"],
      });
    });

    // A marker that WAS usable and is now unreadable may be carrying a stamp
    // this pass cannot see, so it is not overwritten.
    it("stands down when a usable marker became unparseable mid-pass", async () => {
      let reads = 0;
      const { deps, store, calls, lines } = makeDeps({ state: MARKER });
      const base = store.readRefreshState;
      store.readRefreshState = async () => {
        reads++;
        return reads === 1 ? base() : { version: 99 };
      };
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--full", "--execute", "--sole-writer"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.stateWrites).toEqual([]);
      expect(lines.join("\n")).toContain("could not re-read the run marker before advancing it");
    });

    // An older marker and a damaged one need different things from an operator.
    it("names an older marker as predating the current format", async () => {
      const { deps, lines } = makeDeps({
        state: { version: 1, last_run_at: "2026-08-21T00:00:00.000Z", list_row_count: 2 },
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run"],
        deps,
      );
      expect(code).toBe(0);
      const text = lines.join("\n");
      expect(text).toContain("run marker is version 1, which predates the current format");
      expect(text).toContain("Scope: full — no usable run marker");
    });

    // A written marker is an optimisation, not corpus state: every snapshot the
    // pass owed the corpus is already committed when it is attempted.
    it("does not fail a completed pass whose marker write failed", async () => {
      const { deps, lines } = makeDeps({ state: MARKER, stateWriteThrow: "no write" });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--full", "--execute", "--sole-writer"],
        deps,
      );
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("run marker write failed: no write");
    });

    // Status is not a statement about vector ownership: a reprocess-in-flight
    // row can still have a live vector, and its neighbours are exactly who
    // needs re-measuring.
    it("queries the reverse neighbourhood of a changed reading whatever its status", async () => {
      const { deps, calls } = makeDeps({
        state: MARKER,
        items: [
          { ...READY, status: "pending", updated_at: "2026-08-21T12:00:00.000Z" },
          NEIGHBOUR,
        ],
        matchesFor: (_id, topK) =>
          topK === REVERSE_TOP_K
            ? [
                { id: "rd_n", score: REVERSE_SCORE_BOUND + 0.1 },
                { id: "rd_far", score: REVERSE_SCORE_BOUND - 0.2 },
              ]
            : undefined,
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.queries.filter((q) => q.topK === REVERSE_TOP_K)).toHaveLength(1);
      // The pending reading owns no snapshot to refresh, but the neighbour its
      // vector still reaches is measured.
      expect(calls.queries.filter((q) => q.topK !== REVERSE_TOP_K).map((q) => q.id)).toEqual([
        "rd_n",
      ]);
    });

    // The marker must never be newer than the corpus it describes, or a reading
    // activated between the two reads is invisible to every later pass.
    it("stamps the marker no later than the corpus it read", async () => {
      const { deps, store, calls } = quietCorpus();
      let listReadAt = 0;
      const clock = (() => {
        let value = Date.parse("2026-08-22T12:00:00Z");
        return () => (value += 1000);
      })();
      const base = store.listItems;
      store.listItems = async () => {
        listReadAt = clock();
        return base();
      };
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--execute", "--sole-writer"],
        { ...deps, now: clock },
      );
      expect(code).toBe(0);
      const written = calls.stateWrites[0] as { last_run_at: string };
      expect(Date.parse(written.last_run_at)).toBeLessThan(listReadAt);
    });

    // A scope is an economy, not a permission: an operator naming an id is
    // asserting intent, and gets that reading measured whatever the scope says.
    // Resolving a scope at all would be a reverse query per changed reading
    // spent on an answer that cannot change the outcome.
    it("measures an --only id the scope would have excluded, and resolves no scope", async () => {
      const { deps, calls, lines } = makeDeps({
        state: MARKER,
        items: [READY, { ...NEIGHBOUR, updated_at: "2026-08-21T12:00:00.000Z" }],
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run", "rd_r"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.queries).toEqual([{ id: "rd_r", topK: REFRESH_CANDIDATE_TOP_K }]);
      expect(lines.join("\n")).toContain("Scope: full — --only names 1 reading(s)");
    });

    // A reading the planner brings into scope is not merely flagged for tier 2:
    // it is measured like any other target, so its stored similarity snapshot is
    // brought current in the same pass.
    it("rewrites the snapshot of a reading pulled in by a reverse query", async () => {
      const { deps, calls } = makeDeps({
        state: MARKER,
        // Only rd_r changed. rd_n is the stranger its vector reaches, and its
        // row carries a stale snapshot.
        items: [
          { ...READY, updated_at: "2026-08-21T12:00:00.000Z" },
          { ...NEIGHBOUR, similarity: { count: 4, max: 0.9, computed_at: AT } },
        ],
        matchesFor: (_id, topK) =>
          topK === REVERSE_TOP_K
            ? [
                { id: "rd_r", score: 1 },
                { id: "rd_n", score: REVERSE_SCORE_BOUND + 0.2 },
                { id: "rd_far", score: REVERSE_SCORE_BOUND - 0.2 },
              ]
            : undefined,
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", TENANT, "--since-last-run", "--execute", "--sole-writer"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.snapshots.map((s) => s.id).sort()).toEqual(["rd_n", "rd_r"]);
    });

    // One place that pins the whole contract, so a later change to any single
    // failure mode has to say which side of the 1/3 line it lands on.
    //
    // Swept explicitly: the codes are scope-independent, but a quiet corpus
    // under the default scope has no target to fail on, which would make every
    // case here pass for the wrong reason.
    //
    // The distinction the contract turns on: a few unmeasurable readings among
    // measured ones — the marker advances past them, carrying their ids so
    // every later pass retries them (holding the marker on a vectorless
    // reading would pin the whole scope on an ever-older timestamp), and the
    // exit says "a reading needs a human". Nothing measurable in a non-empty
    // scope is what a wrong connection or tenant looks like — the marker
    // freezes and the exit says "the operator has infrastructure to fix". A
    // failed query or snapshot write leaves work this pass owed the corpus
    // undone, so the marker freezes there too and the next pass still sweeps.
    describe("exit-code contract", () => {
      const ADVANCED = {
        version: REFRESH_STATE_VERSION,
        last_run_at: "2026-08-22T12:00:00.000Z",
        last_full_run_at: "2026-08-22T12:00:00.000Z",
        list_ids: ["rd_n", "rd_r"],
      };
      const NONE_MEASURED = [
        "Configuration failure",
        "swept the corpus and measured 0 of 2 ready reading(s)",
        "no vector: 2",
        "the run marker did not advance",
      ];
      it.each<{
        name: string;
        opts: Parameters<typeof makeDeps>[0];
        code: number;
        marker: unknown[];
        text?: string[];
      }>([
        {
          name: "0 — every target measured and nothing outstanding",
          opts: { state: MARKER },
          code: 0,
          marker: [ADVANCED],
        },
        {
          name: "1 — a measurement failed; the operator re-runs",
          opts: { state: MARKER, queryThrow: (id) => (id === "rd_r" ? new Error("503") : undefined) },
          code: 1,
          marker: [],
        },
        {
          name: "1 — a snapshot write failed; the operator re-runs",
          opts: {
            state: MARKER,
            items: [{ ...READY, similarity: undefined }, NEIGHBOUR],
            writeThrow: (id) => (id === "rd_r" ? new Error("deadlock detected") : undefined),
          },
          code: 1,
          marker: [],
        },
        // Every target answers "no vector", as a pass pointed at the wrong
        // database or an empty tenant does — the same verdict whether the sweep
        // had no marker, a marker, or a carried retry set.
        {
          name: "1 — nothing in a non-empty scope could be measured, no marker",
          opts: { matches: null },
          code: 1,
          marker: [],
          text: NONE_MEASURED,
        },
        {
          name: "1 — nothing in a non-empty scope could be measured, marker present",
          opts: { state: MARKER, matches: null },
          code: 1,
          marker: [],
          text: NONE_MEASURED,
        },
        {
          name: "1 — nothing in a non-empty scope could be measured, retry set carried",
          opts: { state: { ...MARKER, unmeasurable_ids: ["rd_r"] }, matches: null },
          code: 1,
          marker: [],
          text: NONE_MEASURED,
        },
        // rd_r owns no vector; rd_n measures normally. The pass did its job,
        // this one reading needs a human, and re-running will not change that.
        {
          name: "3 — the pass completed and only specific readings need a human",
          opts: { state: MARKER, matchesFor: (id) => (id === "rd_r" ? null : undefined) },
          code: 3,
          marker: [{ ...ADVANCED, unmeasurable_ids: ["rd_r"] }],
          text: ["Carried on the run marker for retry: 1 unmeasurable reading(s)."],
        },
      ])("exits $name", async ({ opts, code, marker, text }) => {
        const { deps, calls, lines } = makeDeps(opts);
        expect(
          await corpusRefreshNeighboursCommand.run(
            ["--tenant", TENANT, "--full", "--execute", "--sole-writer"],
            deps,
          ),
        ).toBe(code);
        expect(calls.stateWrites).toEqual(marker);
        // Whatever the verdict, the report is still written.
        expect(calls.reports).toHaveLength(1);
        for (const line of text ?? []) expect(lines.join("\n")).toContain(line);
      });

      it("documents the exit codes in help", () => {
        expect(corpusRefreshNeighboursCommand.helpText).toContain("Exit codes:");
        expect(corpusRefreshNeighboursCommand.helpText).toMatch(/3 {2}The pass itself completed/);
      });
    });

    it("rejects --since-last-run together with --full", async () => {
      const { deps } = makeDeps({});
      await expect(
        corpusRefreshNeighboursCommand.run(["--tenant", TENANT, "--since-last-run", "--full"], deps),
      ).rejects.toThrow(/--since-last-run cannot be combined with --full/);
    });

    it("documents both scope flags in help, with --since-last-run as the default", () => {
      expect(corpusRefreshNeighboursCommand.helpText).toMatch(
        /--since-last-run {4}Measure only the readings in scope[^\n]*\n[^\n]*The default\./,
      );
    });
  });
});
