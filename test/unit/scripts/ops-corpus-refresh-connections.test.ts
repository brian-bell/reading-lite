import { describe, expect, it, vi } from "vitest";
import { BILLING_TENANT, EMBED_URL, FAIL_CLOSED_CASES, spendHarness } from "../../helpers/operator-spend";
import { SIMILARITY_FLOOR } from "../../../src/modules/stores/similarity";
import { RateLimitedError } from "../../../src/modules/http-retry";
import type {
  RelationshipJudgementInput,
  RelationshipJudgementResult,
} from "../../../src/modules/relationship-judgement";
import {
  corpusRefreshConnectionsCommand,
  parseProductionWorkerVars,
  type CorpusRefreshConnectionsDeps,
  type RefreshConnectionsStorage,
  type StoreTarget,
} from "../../../scripts/ops-lib/commands/corpus-refresh-connections";

const AT = "2026-08-31T12:00:00.000Z";
const JUDGED_AT = "2026-08-31T12:01:00.000Z";
/** Every pass addresses one tenant's rows; `global` has none and is refused. */
const TENANT = "usr_11111111-1111-4111-8111-111111111111";

function listRow(id: string) {
  return {
    id,
    key_prefix: `readings/2026/${id}`,
    url: `https://example.com/${id}`,
    status: "ready" as const,
    title: id,
    tldr: `Summary ${id}`,
    tags: ["x"],
    novelty_verdict: "novel" as const,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function manifest(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    url: `https://example.com/${id}`,
    url_hash: "a".repeat(64),
    status: "ready",
    title: id,
    tldr: `Summary ${id}`,
    tags: ["x"],
    keywords: ["one", "two", "three"],
    people: [],
    orgs: [],
    novelty_verdict: "novel",
    connections: [],
    summary_markdown: `Stored summary ${id}.`,
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function report(ids = ["rd_a", "rd_c"]) {
  return {
    version: 1,
    generated_at: AT,
    tenant: TENANT,
    floor: SIMILARITY_FLOOR,
    readings: ids.map((id) => ({
      id,
      key_prefix: `readings/2026/${id}`,
      url: `https://example.com/${id}`,
      reasons: ["new_neighbour"],
      novelty_verdict: "novel",
      connections: [],
      current_neighbours: [
        {
          id: "rd_b",
          score: 0.9,
          title: "rd_b",
          tldr: "Summary rd_b",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
    })),
  };
}

function harness(opts: { authority?: Parameters<typeof spendHarness>[0] } = {}) {
  const items = [listRow("rd_a"), listRow("rd_b"), listRow("rd_c")];
  const manifests = new Map<string, Record<string, unknown>>([
    ["rd_a", manifest("rd_a")],
    ["rd_b", manifest("rd_b")],
    ["rd_c", manifest("rd_c")],
  ]);
  const writes: Array<{ id: string; manifest: Record<string, unknown> }> = [];
  const targets: StoreTarget[] = [];
  // Persistence and version guards are owned by ops-corpus-refresh-pg.test.ts.
  const storage: RefreshConnectionsStorage = {
    listItems: async () => items,
    readManifest: async (id) => {
      const found = manifests.get(id);
      return found === undefined ? null : { manifest: found, version: "planned-version" };
    },
    replaceRelationships: async (entries) => {
      for (const entry of entries) {
        const next = entry.next as unknown as Record<string, unknown>;
        writes.push({ id: entry.id, manifest: next });
        manifests.set(entry.id, next);
      }
      return { replaced: true, skippedTargets: [] };
    },
  };
  let active: RefreshConnectionsStorage = storage;
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const judge = vi.fn<
    (input: RelationshipJudgementInput) => Promise<RelationshipJudgementResult>
  >(async () => ({
    judgement: {
      novelty_verdict: "familiar" as const,
      connections: [{ id: "rd_b", reason: "related" }],
    },
    usage: {
      provider: "openai" as const,
      model: "gpt-5.6-terra",
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 0,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
    },
  }));
  const spend = spendHarness(opts.authority);
  const readReport = vi.fn(async () => JSON.stringify(report()));
  const deps: CorpusRefreshConnectionsDeps = {
    io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    readReport,
    withStore: (target, work) => {
      targets.push(target);
      return work(active);
    },
    loadProvider: async () => ({
      provider: "openai",
      model: "gpt-5.6-terra",
      effort: "high",
      estimate: () => ({ inputTokens: 500, outputTokens: 256, costUsd: 0.005 }),
      judge,
    }),
    now: () => Date.parse(JUDGED_AT),
    openSpend: spend.openSpend,
    fetch: spend.fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  return {
    spend,
    deps,
    out,
    err,
    sleeps,
    judge,
    readReport,
    storage,
    /** Hands the command a different store, for the scaled fixtures below. */
    useStorage: (next: RefreshConnectionsStorage) => {
      active = next;
    },
    targets,
    writes,
    manifests,
    items: () => items,
  };
}

/** A fake clock that advances a fixed step on every read. */
function fakeClock(stepMs: number, startMs = Date.parse(JUDGED_AT)) {
  let value = startMs - stepMs;
  return () => {
    value += stepMs;
    return value;
  };
}

describe("ops corpus refresh-connections", () => {
  // The pre-tenant layout has no rows to judge, and the refusal has to come
  // before the spend session: a paid session admitted for work that cannot
  // happen is the failure worth preventing.
  it("refuses --tenant global before opening a spend session", async () => {
    const h = harness();
    await expect(
      corpusRefreshConnectionsCommand.run(
        ["--tenant", "global", "--billing-tenant", BILLING_TENANT, "--execute", "--sole-writer"],
        h.deps,
      ),
    ).rejects.toThrow(/--tenant global addresses the pre-tenant R2 layout/);
    expect(h.spend.calls).toEqual([]);
  });
  it("prints a Timing block for a plan pass with no provider phase", async () => {
    const h = harness();
    expect(
      await corpusRefreshConnectionsCommand.run(["--tenant", TENANT, "--billing-tenant", BILLING_TENANT], {
        ...h.deps,
        now: fakeClock(10),
      }),
    ).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("Timing:");
    expect(text).toMatch(/list read\s+1 call\s+0\.010s/);
    // Three reads, overlapped: the phase total is the sum of the call
    // durations, which under concurrency is longer than the wall time they
    // actually took.
    expect(text).toMatch(/planning reads\s+3 calls\s+0\.050s/);
    expect(text).not.toMatch(/^ {2}provider\s+\d+ call/m);
    expect(text).not.toContain("reading write");
  });

  it("still prints the Timing block when the pass throws on a stale report", async () => {
    const h = harness();
    h.readReport.mockResolvedValue(JSON.stringify(report(["rd_a"])));
    h.manifests.get("rd_a")!.updated_at = JUDGED_AT;
    await expect(
      corpusRefreshConnectionsCommand.run(
        ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT, "--execute", "--sole-writer"],
        { ...h.deps, now: fakeClock(10) },
      ),
    ).rejects.toThrow(/target rd_a changed/);
    // The reads it already paid for are the reason this pass is worth timing.
    expect(h.out.join("\n")).toMatch(/planning reads\s+\d+ calls/);
  });

  it("times the planning reads and each judgement, with no execute-pass read", async () => {
    const h = harness();
    expect(
      await corpusRefreshConnectionsCommand.run(
        // Pinned to one at a time: this test is about which phase each call is
        // attributed to, and overlapping the actions would interleave the fake
        // clock's steps across them.
        ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT, "--execute", "--sole-writer", "--concurrency", "1"],
        { ...h.deps, now: fakeClock(10) },
      ),
    ).toBe(0);
    const text = h.out.join("\n");
    // Three readings read while planning, and none afterwards: each write is
    // guarded on the version its planning read returned.
    expect(text).toMatch(/planning reads\s+3 calls\s+0\.050s/);
    expect(text).not.toContain("reading read");
    expect(text).toMatch(/provider\s+2 calls\s+0\.020s/);
    // One write per judgement, and nothing after them: the verdict went with
    // the relationships, so there is no closing flush to time.
    expect(text).toMatch(/reading write\s+2 calls/);
    expect(text).toContain("rd_a  usage input=100 output=20 reasoning=0 ms=10");
  });

  it("reads provider settings from the production Worker section", () => {
    expect(
      parseProductionWorkerVars(`
[vars]
OPENAI_SUMMARIZATION_REASONING_EFFORT = "low"

[env.production.vars]
SUMMARIZER_PROVIDER = "openai"
OPENAI_SUMMARIZATION_MODEL = "gpt-5.6-terra"
OPENAI_SUMMARIZATION_REASONING_EFFORT = "high"

[[env.production.queues.producers]]
binding = "READING_JOBS"
`),
    ).toEqual({
      SUMMARIZER_PROVIDER: "openai",
      OPENAI_SUMMARIZATION_MODEL: "gpt-5.6-terra",
      OPENAI_SUMMARIZATION_REASONING_EFFORT: "high",
    });
  });

  // A nightly log that does not say what tier 1 measured cannot be read as
  // covering the corpus: an incremental report and a full one list flagged
  // readings identically.
  describe("scope header", () => {
    it("prints an incremental scope, its reason, and how it was narrowed", async () => {
      const h = harness();
      h.readReport.mockResolvedValue(
        JSON.stringify({
          ...report(["rd_a"]),
          scope: {
            kind: "incremental",
            reason: "4 reading(s) changed since 2026-08-21T00:00:00.000Z",
            since: "2026-08-21T00:00:00.000Z",
            readings_in_scope: 9,
            narrowed_by: "--limit 3",
          },
        }),
      );
      expect(await corpusRefreshConnectionsCommand.run(["--tenant", TENANT, "--billing-tenant", BILLING_TENANT], h.deps)).toBe(0);
      expect(h.out.join("\n")).toContain(
        "Scope: incremental (9 reading(s)) — 4 reading(s) changed since " +
          "2026-08-21T00:00:00.000Z; narrowed by --limit 3",
      );
    });

    it("prints a full scope with the reason the pass could not be narrowed", async () => {
      const h = harness();
      h.readReport.mockResolvedValue(
        JSON.stringify({ ...report(["rd_a"]), scope: { kind: "full", reason: "--full" } }),
      );
      expect(await corpusRefreshConnectionsCommand.run(["--tenant", TENANT, "--billing-tenant", BILLING_TENANT], h.deps)).toBe(0);
      expect(h.out.join("\n")).toContain("Scope: full — --full");
    });

    // Pre-header refresh-neighbours already accepted positional IDs and --limit,
    // so a missing header is not a full pass. Print unstated, not full.
    it("says the scope is unstated when the report carries no header", async () => {
      const h = harness();
      expect(await corpusRefreshConnectionsCommand.run(["--tenant", TENANT, "--billing-tenant", BILLING_TENANT], h.deps)).toBe(0);
      const printed = h.out.find((line) => line.startsWith("Scope:"));
      expect(printed).toBe("Scope: unstated — the report carries no scope header");
      expect(printed).not.toMatch(/full/i);
    });

    it("documents that a missing report scope is unstated, not full", () => {
      expect(corpusRefreshConnectionsCommand.helpText).toContain("Scope: unstated, not full");
    });
  });

  it("prints every planned judgement and estimated cost without provider or storage writes", async () => {
    const h = harness();
    expect(
      await corpusRefreshConnectionsCommand.run(["--tenant", TENANT, "--billing-tenant", BILLING_TENANT], h.deps),
    ).toBe(0);
    expect(h.out.join("\n")).toContain("rd_a  judge");
    expect(h.out.join("\n")).toContain("rd_c  judge");
    expect(h.out.join("\n")).toContain("prior=novel[(none)]");
    expect(h.out.join("\n")).toContain("candidates=rd_b@0.900");
    expect(h.out.join("\n")).toContain("Estimated synchronous cost: $0.010000");
    expect(h.out.join("\n")).toContain("no provider call or storage write");
    expect(h.out.join("\n")).not.toContain("usage input=");
    expect(h.out.join("\n")).not.toContain("Usage:");
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
      });

  it("refuses execute without sole-writer before reading the report or storage", async () => {
    const h = harness();
    await expect(
      corpusRefreshConnectionsCommand.run(
        ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT, "--execute"],
        h.deps,
      ),
    ).rejects.toThrow(/--sole-writer/);
    expect(h.readReport).not.toHaveBeenCalled();
    expect(h.targets).toEqual([]);
  });


  it("prints the provider usage per judgement and a run total", async () => {
    const h = harness();
    expect(
      await corpusRefreshConnectionsCommand.run(
        ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT, "--execute", "--sole-writer"],
        h.deps,
      ),
    ).toBe(0);
    expect(h.judge).toHaveBeenCalledTimes(2);
    expect(h.out.join("\n")).toContain("rd_a  usage input=100 output=20 reasoning=0");
    expect(h.out.join("\n")).toContain("rd_c  usage input=100 output=20 reasoning=0");
    expect(h.out.join("\n")).toContain("Usage: 2 judgements; input=200 output=40 reasoning=0");
  });



  it("reads every reading once, with no per-action re-read on execute", async () => {
    const h = harness();
    const reads: string[] = [];
    const readManifest = h.storage.readManifest;
    h.storage.readManifest = async (id) => {
      reads.push(id);
      return readManifest(id);
    };
    expect(
      await corpusRefreshConnectionsCommand.run(
        ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT, "--execute", "--sole-writer"],
        h.deps,
      ),
    ).toBe(0);
    expect(h.judge).toHaveBeenCalledTimes(2);
    // rd_a and rd_c are the targets, rd_b their shared candidate: three
    // readings, three reads. Planning already holds the version each write is
    // guarded on, so the execute pass adds no read of its own.
    expect([...reads].sort()).toEqual([
      "rd_a",
      "rd_b",
      "rd_c",
    ]);
  });


  it("continues after a planning read failure and still writes the readings it judged", async () => {
    const h = harness();
    const readManifest = h.storage.readManifest;
    h.storage.readManifest = async (id) => {
      if (id === "rd_c") throw new Error("temporary read failure");
      return readManifest(id);
    };
    expect(
      await corpusRefreshConnectionsCommand.run(
        ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT, "--execute", "--sole-writer"],
        h.deps,
      ),
    ).toBe(1);
    expect(h.judge).toHaveBeenCalledOnce();
    expect(h.writes).toHaveLength(1);
    expect(h.err.join("\n")).toContain("rd_c: temporary read failure");
    expect(h.out.join("\n")).toContain("Judged: 1; failures: 0");
  });

  it("drops a provider connection when the neighbour manifest is missing", async () => {
    const h = harness();
    h.manifests.delete("rd_b");
    expect(
      await corpusRefreshConnectionsCommand.run(
        ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT, "--execute", "--sole-writer", "--limit", "1"],
        h.deps,
      ),
    ).toBe(0);
    expect(h.writes[0]!.manifest.connections).toEqual([]);
  });

  it("rejects a report when a target was reprocessed after it was generated", async () => {
    const h = harness();
    h.readReport.mockResolvedValue(JSON.stringify(report(["rd_a"])));
    h.manifests.get("rd_a")!.updated_at = JUDGED_AT;
    await expect(
      corpusRefreshConnectionsCommand.run(
        ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT, "--execute", "--sole-writer"],
        h.deps,
      ),
    ).rejects.toThrow(/target rd_a changed.*regenerate/);
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("rejects a report when a candidate neighbour was reprocessed after it was generated", async () => {
    const h = harness();
    h.readReport.mockResolvedValue(JSON.stringify(report(["rd_a"])));
    h.manifests.get("rd_b")!.updated_at = JUDGED_AT;
    await expect(
      corpusRefreshConnectionsCommand.run(
        ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT, "--execute", "--sole-writer"],
        h.deps,
      ),
    ).rejects.toThrow(/neighbour rd_b changed.*regenerate/);
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("reports an invalid target manifest as an incomplete plan", async () => {
    const h = harness();
    h.readReport.mockResolvedValue(JSON.stringify(report(["rd_a"])));
    delete h.manifests.get("rd_a")!.content_type;
    expect(
      await corpusRefreshConnectionsCommand.run(["--tenant", TENANT, "--billing-tenant", BILLING_TENANT], h.deps),
    ).toBe(1);
    expect(h.err.join("\n")).toMatch(/rd_a.*invalid or mismatched/);
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("reports a target without usable stored summary text as incomplete", async () => {
    const h = harness();
    h.readReport.mockResolvedValue(JSON.stringify(report(["rd_a"])));
    h.manifests.get("rd_a")!.summary_markdown = "  ";
    expect(
      await corpusRefreshConnectionsCommand.run(["--tenant", TENANT, "--billing-tenant", BILLING_TENANT], h.deps),
    ).toBe(1);
    expect(h.err.join("\n")).toMatch(/rd_a.*no stored summary text/);
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("continues planning but fails the run when a candidate manifest cannot be read", async () => {
    const h = harness();
    h.readReport.mockResolvedValue(JSON.stringify(report(["rd_a", "rd_c"])));
    const readManifest = h.storage.readManifest;
    h.storage.readManifest = async (id) => {
      if (id === "rd_b") throw new Error("row does not parse");
      return readManifest(id);
    };
    expect(
      await corpusRefreshConnectionsCommand.run(["--tenant", TENANT, "--billing-tenant", BILLING_TENANT], h.deps),
    ).toBe(1);
    expect(h.err.join("\n")).toContain("candidate rd_b: row does not parse");
    expect(h.err.join("\n")).toContain("invalid candidate manifest(s): rd_b");
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  // The verdict used to live on a second document, so a failed flush left a
  // row disagreeing with the manifest beside it and a later pass had to heal
  // it. Both are one row now: the verdict lands inside the same transaction as
  // the relationships, and there is no state where only one of them is there.
  it("writes the verdict and the relationships as one write", async () => {
    const h = harness();
    h.readReport.mockResolvedValue(JSON.stringify(report(["rd_a"])));
    expect(
      await corpusRefreshConnectionsCommand.run(
        ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT, "--execute", "--sole-writer"],
        h.deps,
      ),
    ).toBe(0);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.manifest).toMatchObject({
      novelty_verdict: "familiar",
      connections: [{ id: "rd_b", reason: "related" }],
    });
  });



});

/**
 * A store that reports how many reads were in flight at once, and in what
 * order they finished, so the planning reader's cap and its in-order
 * collection can be asserted separately.
 */
function trackingStorage(
  items: ReturnType<typeof listRow>[],
  manifests: Map<string, Record<string, unknown>>,
) {
  let inFlight = 0;
  let peak = 0;
  const completed: string[] = [];
  const storage: RefreshConnectionsStorage = {
    listItems: async () => items,
    readManifest: async (id) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Later ids finish first, so an in-order result can only come from
      // collecting by input position rather than by completion.
      await new Promise((resolve) => setTimeout(resolve, id.endsWith("9") ? 0 : 2));
      inFlight--;
      completed.push(id);
      const found = manifests.get(id);
      return found === undefined ? null : { manifest: found, version: `v-${id}` };
    },
    replaceRelationships: async () => ({ replaced: true, skippedTargets: [] }),
  };
  return { storage, peak: () => peak, completed };
}

describe("ops corpus refresh-connections planning read concurrency", () => {
  const COUNT = 20;
  const ids = Array.from({ length: COUNT }, (_, i) => `rd_${String(i).padStart(2, "0")}`);
  const neighbourOf = (id: string) => `nb_${id.slice(3)}`;

  function scaled() {
    const items = [...ids, ...ids.map(neighbourOf)].map(listRow);
    const manifests = new Map(items.map((row) => [row.id, manifest(row.id)]));
    const tracked = trackingStorage(items, manifests);
    const h = harness();
    const scaledReport = {
      ...report(),
      readings: ids.map((id) => ({
        id,
        key_prefix: `readings/2026/${id}`,
        url: `https://example.com/${id}`,
        reasons: ["new_neighbour"],
        novelty_verdict: "novel",
        connections: [],
        current_neighbours: [
          {
            id: neighbourOf(id),
            score: 0.9,
            title: neighbourOf(id),
            tldr: `Summary ${neighbourOf(id)}`,
            created_at: "2026-01-02T00:00:00.000Z",
          },
        ],
      })),
    };
    h.readReport.mockResolvedValue(JSON.stringify(scaledReport));
    h.useStorage(tracked.storage);
    return { h, tracked };
  }

  it("overlaps planning reads up to the cap and keeps plan output in report order", async () => {
    const { h, tracked } = scaled();

    expect(await corpusRefreshConnectionsCommand.run(["--tenant", TENANT, "--billing-tenant", BILLING_TENANT], h.deps)).toBe(0);

    expect(tracked.peak()).toBe(8);
    // Proof the fixture actually completes out of order, so the assertion below
    // is about collection order rather than a coincidentally serial run.
    expect(tracked.completed).not.toEqual([...tracked.completed].sort());
    const planned = h.out
      .filter((line) => line.includes("  judge reasons="))
      .map((line) => line.trim().split(/\s+/)[0]);
    expect(planned).toEqual(ids);
  });

  it("reads every reading once across both planning waves", async () => {
    const { h, tracked } = scaled();

    expect(await corpusRefreshConnectionsCommand.run(["--tenant", TENANT, "--billing-tenant", BILLING_TENANT], h.deps)).toBe(0);

    expect(tracked.completed).toHaveLength(COUNT * 2);
    expect(new Set(tracked.completed).size).toBe(COUNT * 2);
  });
});

describe("ops corpus refresh-connections execute concurrency", () => {
  const COUNT = 12;
  const ids = Array.from({ length: COUNT }, (_, i) => `rd_${String(i).padStart(2, "0")}`);
  const neighbourOf = (id: string) => `nb_${id.slice(3)}`;

  /** A report of COUNT flagged readings, each with one distinct neighbour. */
  function scaledReport() {
    return {
      ...report(),
      readings: ids.map((id) => ({
        id,
        key_prefix: `readings/2026/${id}`,
        url: `https://example.com/${id}`,
        reasons: ["new_neighbour"],
        novelty_verdict: "novel",
        connections: [],
        current_neighbours: [
          {
            id: neighbourOf(id),
            score: 0.9,
            title: neighbourOf(id),
            tldr: `Summary ${neighbourOf(id)}`,
            created_at: "2026-01-02T00:00:00.000Z",
          },
        ],
      })),
    };
  }

  function scaled(opts: { casLossFor?: string } = {}) {
    const items = [...ids, ...ids.map(neighbourOf)].map(listRow);
    const manifests = new Map<string, Record<string, unknown>>(
      items.map((row) => [row.id, manifest(row.id)]),
    );
    const writes: Array<{ id: string }> = [];
    const storage: RefreshConnectionsStorage = {
      listItems: async () => items,
      readManifest: async (id) => {
        const found = manifests.get(id);
        return found === undefined ? null : { manifest: found, version: `v-${id}` };
      },
      replaceRelationships: async (entries) => {
        for (const entry of entries) writes.push({ id: entry.id });
        if (opts.casLossFor !== undefined && entries.some((entry) => entry.id === opts.casLossFor)) {
          return { replaced: false, skippedTargets: [] };
        }
        for (const entry of entries) {
          manifests.set(entry.id, entry.next as unknown as Record<string, unknown>);
        }
        return { replaced: true, skippedTargets: [] };
      },
    };

    let inFlight = 0;
    let peak = 0;
    const judgeOrder: string[] = [];
    const h = harness();
    h.readReport.mockResolvedValue(JSON.stringify(scaledReport()));
    h.useStorage(storage);
    // The provider is the whole point of the flag: give it latency, and resolve
    // later readings first so an in-order result cannot be luck.
    h.judge.mockImplementation(async (input) => {
      const id = input.reading.id;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, id.endsWith("0") ? 4 : 1));
      inFlight--;
      judgeOrder.push(id);
      return {
        judgement: { novelty_verdict: "familiar" as const, connections: [] },
        usage: {
          provider: "openai" as const,
          model: "gpt-5.6-terra",
          input_tokens: 100,
          output_tokens: 20,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
        },
      };
    });
    return { h, manifests, writes, judgeOrder, peak: () => peak };
  }

  const execute = (h: ReturnType<typeof harness>, ...extra: string[]) =>
    corpusRefreshConnectionsCommand.run(
      ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT, "--execute", "--sole-writer", ...extra],
      h.deps,
    );

  /** Runs with a clock that a backoff actually moves, as a real one would. */
  const executeOnAClock = (h: ReturnType<typeof harness>, ...extra: string[]) => {
    let clock = Date.parse(JUDGED_AT);
    return corpusRefreshConnectionsCommand.run(
      ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT, "--execute", "--sole-writer", ...extra],
      {
        ...h.deps,
        now: () => clock,
        sleep: async (ms: number) => {
          h.sleeps.push(ms);
          clock += ms;
        },
      },
    );
  };

  it("judges four at a time by default and prints results in plan order", async () => {
    const s = scaled();

    expect(await execute(s.h)).toBe(0);

    expect(s.peak()).toBe(4);
    expect(s.h.out.join("\n")).toContain("Mode: EXECUTE (concurrency 4)");
    // Proof the fixture completes out of order, so the assertion below is
    // about collection order rather than a coincidentally serial run.
    expect(s.judgeOrder).not.toEqual([...s.judgeOrder].sort());
    const printed = s.h.out
      .filter((line) => line.includes("usage input="))
      .map((line) => line.trim().split(/\s+/)[0]);
    expect(printed).toEqual(ids);
    expect(s.h.out.join("\n")).toContain(`Judged: ${COUNT}; failures: 0`);
  });

  it("honours a lower cap", async () => {
    const s = scaled();
    expect(await execute(s.h, "--concurrency", "2")).toBe(0);
    expect(s.peak()).toBe(2);
  });

  it("rejects a --concurrency that is not a positive integer", async () => {
    const s = scaled();
    await expect(execute(s.h, "--concurrency", "0")).rejects.toThrow(
      /--concurrency "0" is not a positive integer/,
    );
    expect(s.h.judge).not.toHaveBeenCalled();
  });

  it("writes nothing for a reading that loses its CAS, and counts the loss once", async () => {
    const lost = ids[5]!;
    const s = scaled({ casLossFor: lost });

    expect(await execute(s.h)).toBe(1);

    // Exactly one write attempt for the loser, and its manifest is untouched:
    // no partial write, and no second worker retrying it.
    const attempts = s.writes.filter((write) => write.id === lost);
    expect(attempts).toHaveLength(1);
    expect(s.manifests.get(lost)!.connections).toEqual([]);
    expect(
      s.h.err.filter((line) => line.includes("changed since it was planned")),
    ).toEqual([
      `  ! ${lost}: the reading changed since it was planned; no overwrite performed`,
    ]);
    expect(s.h.out.join("\n")).toContain(`Judged: ${COUNT - 1}; failures: 1`);
    // The verdict is a column of the same row, so a lost write leaves it as it
    // was while the winners carry theirs.
    expect(s.manifests.get(lost)!.novelty_verdict).toBe("novel");
    expect(s.manifests.get(ids[4]!)!.novelty_verdict).toBe("familiar");
    // Its call was still billed, which is what the usage total is for.
    expect(s.h.out.join("\n")).toContain(`Usage: ${COUNT} judgements;`);
  });

  it("backs the whole pass off once on a 429 rather than each worker independently", async () => {
    const s = scaled();
    const inner = s.h.judge.getMockImplementation()!;
    let first = true;
    s.h.judge.mockImplementation(async (input) => {
      if (first) {
        first = false;
        throw new RateLimitedError(429, 2_500, "https://api.openai.com/v1/responses");
      }
      return inner(input);
    });

    expect(await execute(s.h)).toBe(0);

    // One window for the run, not one per worker.
    const pauses = s.h.err.filter((line) => line.includes("pausing new judgements"));
    expect(pauses).toEqual(["  ! provider rate limited; pausing new judgements for 2.500s"]);
    // Every worker that dispatched after the limit waited on that same window.
    expect(s.h.sleeps.length).toBeGreaterThan(1);
    expect(new Set(s.h.sleeps)).toEqual(new Set([2_500]));
    // And the action that hit the limit got its one retry once the window
    // cleared, so a transient limit costs the pass a pause, not a reading.
    expect(s.h.judge).toHaveBeenCalledTimes(COUNT + 1);
    expect(s.h.out.join("\n")).toContain(
      `Judged: ${COUNT}; failures: 0`,
    );
  });

  it("fails an action whose retry is rate limited too, without a third attempt", async () => {
    const s = scaled();
    const inner = s.h.judge.getMockImplementation()!;
    const doomed = ids[3]!;
    s.h.judge.mockImplementation(async (input) => {
      if (input.reading.id === doomed) {
        throw new RateLimitedError(429, 1_000, "https://api.openai.com/v1/responses");
      }
      return inner(input);
    });

    expect(await executeOnAClock(s.h)).toBe(1);

    expect(
      s.h.judge.mock.calls.filter(([input]) => input.reading.id === doomed),
    ).toHaveLength(2);
    expect(s.h.err).toContain(
      `  ! ${doomed}: rate limited by https://api.openai.com/v1/responses ` +
        "(status 429, retry after 1000ms)",
    );
    expect(s.h.out.join("\n")).toContain(
      `Judged: ${COUNT - 1}; failures: 1`,
    );
  });

  it("stops dispatching once the pass has spent its whole backoff budget", async () => {
    const s = scaled();
    s.h.judge.mockImplementation(async () => {
      throw new RateLimitedError(429, 60_000, "https://api.openai.com/v1/responses");
    });

    // One at a time and a two-minute budget, so the ceiling is reached early
    // enough that most of the plan is still undispatched behind it.
    expect(await executeOnAClock(s.h, "--concurrency", "1", "--max-backoff", "120s")).toBe(1);

    expect(
      s.h.err.filter((line) => line.includes("pausing new judgements")),
    ).toHaveLength(2);
    expect(s.h.err.filter((line) => line.includes("rate-limit ceiling"))).toEqual([
      "  ! the next backoff would pass this pass's 120.000s rate-limit ceiling " +
        "(120.000s of it already spent); not dispatching any more judgements",
    ]);
    // The budget is a bound on wall time, not a target it overshoots.
    expect(s.h.sleeps.reduce((total, ms) => total + ms, 0)).toBe(120_000);
    // Two actions reached the provider; the rest never called it at all.
    expect(s.h.judge).toHaveBeenCalledTimes(3);
    expect(s.h.err).toContain(
      `  ! skip ${ids[COUNT - 1]}: backoff ceiling reached before this action ran`,
    );
    expect(s.h.out.join("\n")).toContain(
      `Judged: 0; failures: 2; skipped at the backoff ceiling: ${COUNT - 2}`,
    );
    // Nothing was written, and the pass says so with a non-zero exit.
    expect(s.writes).toEqual([]);
  });

  // The ceiling stops paid work, and a stopped action must leave its reading
  // exactly as it found it: writing anything for a reading nothing judged
  // would re-plan it forever.
  it("leaves a reading it skipped at the ceiling untouched", async () => {
    const s = scaled();
    const inner = s.h.judge.getMockImplementation()!;
    // The first reading is judged, everything after it walks into the wall, so
    // the pass writes one reading and then reaches the ceiling with most of
    // the plan undispatched.
    s.h.judge.mockImplementation(async (input) => {
      if (input.reading.id === ids[0]) return inner(input);
      throw new RateLimitedError(429, 60_000, "https://api.openai.com/v1/responses");
    });

    expect(await executeOnAClock(s.h, "--concurrency", "1", "--max-backoff", "120s")).toBe(1);

    expect(s.manifests.get(ids[0]!)!.novelty_verdict).toBe("familiar");
    expect(s.manifests.get(ids[COUNT - 1]!)!.novelty_verdict).toBe("novel");
    expect(s.writes.map((write) => write.id)).toEqual([ids[0]]);
  });

  it("keeps a --max-backoff that is not a duration out of the pass", async () => {
    const s = scaled();
    await expect(execute(s.h, "--max-backoff", "soon")).rejects.toThrow(
      /--max-backoff "soon" is not a duration/,
    );
    expect(s.h.judge).not.toHaveBeenCalled();
  });

  it("keeps pausing while judgements are still getting through between limits", async () => {
    const s = scaled();
    const inner = s.h.judge.getMockImplementation()!;
    let calls = 0;
    // Every other call is rate limited, so every action's retry succeeds and
    // the pass keeps its budget well clear of the ceiling.
    s.h.judge.mockImplementation(async (input) => {
      if (calls++ % 2 === 0) {
        throw new RateLimitedError(429, 1_000, "https://api.openai.com/v1/responses");
      }
      return inner(input);
    });

    expect(await executeOnAClock(s.h, "--concurrency", "1")).toBe(0);

    expect(s.h.err.filter((line) => line.includes("rate-limit ceiling"))).toEqual([]);
    expect(
      s.h.err.filter((line) => line.includes("pausing new judgements")),
    ).toHaveLength(COUNT);
    expect(s.h.out.join("\n")).toContain(
      `Judged: ${COUNT}; failures: 0`,
    );
  });

  it("defaults the backoff when the provider sends no Retry-After", async () => {
    const s = scaled();
    const inner = s.h.judge.getMockImplementation()!;
    let first = true;
    s.h.judge.mockImplementation(async (input) => {
      if (first) {
        first = false;
        throw new RateLimitedError(429, null, "https://api.openai.com/v1/responses");
      }
      return inner(input);
    });

    expect(await execute(s.h)).toBe(0);

    expect(s.h.err.join("\n")).toContain("pausing new judgements for 8.000s");
  });
});

// reading-lite-gh319.1. The stand-in provider sends `request` through the paid
// transport the command hands it, as the real judge client does.
describe("ops corpus refresh-connections spend admission", () => {
  const run = (h: ReturnType<typeof harness>, ...argv: string[]) =>
    corpusRefreshConnectionsCommand.run(["--tenant", TENANT, ...argv], h.deps);
  const billed = ["--billing-tenant", BILLING_TENANT];

  function paying(h: ReturnType<typeof harness>, request: RequestInit) {
    const base = h.deps.loadProvider;
    h.deps.loadProvider = async (execute, paidFetch) => ({
      ...(await base(execute)),
      judge: async (input) => {
        await paidFetch!(EMBED_URL, request);
        return h.judge(input);
      },
    });
  }

  it("opens no spend session for a plan or a refused execute", async () => {
    const h = harness();
    expect(await run(h)).toBe(0);
    await expect(run(h, ...billed, "--execute")).rejects.toThrow(/--sole-writer/);
    expect(h.spend.openSpend).not.toHaveBeenCalled();
    expect(h.spend.fetch).not.toHaveBeenCalled();
  });

  // A tenant pass bills itself, so --billing-tenant is optional here; what it
  // must never do is bill something that is not a tenant. (The one selector
  // that required an explicit billing tenant was `global`, which this command
  // now refuses outright — it has no rows to judge.)
  it("refuses a malformed --billing-tenant before opening a spend session", async () => {
    const h = harness();
    await expect(run(h, "--execute", "--sole-writer", "--billing-tenant", "global")).rejects.toThrow(
      /malformed --billing-tenant/,
    );
    expect(h.spend.openSpend).not.toHaveBeenCalled();
  });

  it.each(FAIL_CLOSED_CASES)("makes no provider request after %s", async (_label, authority, request, refusal) => {
    const h = harness({ authority });
    paying(h, request);
    expect(await run(h, ...billed, "--execute", "--sole-writer")).toBe(1);
    expect(h.spend.fetch).not.toHaveBeenCalled();
    expect(h.err.join("\n")).toMatch(refusal);
    expect(h.writes).toEqual([]);
    expect(h.spend.dispose).toHaveBeenCalledTimes(1);
  });
});
