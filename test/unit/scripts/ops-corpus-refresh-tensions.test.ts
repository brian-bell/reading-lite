import { describe, expect, it, vi } from "vitest";
import { SIMILARITY_FLOOR } from "../../../src/modules/stores/similarity-store";
import { RateLimitedError } from "../../../src/modules/http-retry";
import type {
  TensionJudgementInput,
  TensionJudgementResult,
} from "../../../src/modules/tension-judgement";
import {
  corpusRefreshTensionsCommand,
  tensionProviderFromVars,
  type CorpusRefreshTensionsDeps,
  type RefreshTensionsStorage,
} from "../../../scripts/ops-lib/commands/corpus-refresh-tensions";

const AT = "2026-08-31T12:00:00.000Z";
const JUDGED_AT = "2026-08-31T12:01:00.000Z";
const EARLIER = "2026-01-01T00:00:00.000Z";

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
    created_at: EARLIER,
    updated_at: EARLIER,
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
    keywords: [`${id}-one`, `${id}-two`, `${id}-three`],
    people: [],
    orgs: [],
    novelty_verdict: "novel",
    connections: [],
    summary_markdown: `Stored summary ${id}.`,
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: EARLIER,
    updated_at: EARLIER,
    future_field: { keep: id },
    ...overrides,
  };
}

function report(rows: Array<{ id: string; neighbours: string[] }> = [{ id: "rd_a", neighbours: ["rd_b", "rd_c"] }]) {
  return {
    version: 1,
    generated_at: AT,
    tenant: "global",
    floor: SIMILARITY_FLOOR,
    readings: rows.map((row) => ({
      id: row.id,
      key_prefix: `readings/2026/${row.id}`,
      url: `https://example.com/${row.id}`,
      reasons: ["new_neighbour"],
      novelty_verdict: "novel",
      connections: [],
      current_neighbours: row.neighbours.map((id, index) => ({
        id,
        score: 0.9 - index * 0.1,
        title: id,
        tldr: `Summary ${id}`,
        created_at: EARLIER,
      })),
    })),
  };
}

const supersedes = {
  judgement: { verdict: "supersedes" as const, side: "b" as const, reason: "rd_b retracts rd_a" },
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

function harness(opts: { casFailOn?: string; manifests?: Record<string, Record<string, unknown>> } = {}) {
  const items = [listRow("rd_a"), listRow("rd_b"), listRow("rd_c"), { ...listRow("rd_failed"), status: "failed" as const }];
  const manifests = new Map<string, { manifest: Record<string, unknown>; etag: string }>([
    ["readings/2026/rd_a", { manifest: manifest("rd_a", { people: ["Ada"] }), etag: "e-a" }],
    ["readings/2026/rd_b", { manifest: manifest("rd_b", { people: ["ada"] }), etag: "e-b" }],
    ["readings/2026/rd_c", { manifest: manifest("rd_c"), etag: "e-c" }],
  ]);
  for (const [prefix, override] of Object.entries(opts.manifests ?? {})) {
    manifests.set(prefix, { manifest: override, etag: `e-${prefix}` });
  }
  const writes: Array<{ keyPrefix: string; manifest: Record<string, unknown>; etag: string }> = [];
  const listWrites: unknown[] = [];
  let casFailOn = opts.casFailOn;
  const storage: RefreshTensionsStorage = {
    readListIndex: async () => items,
    readManifest: async (keyPrefix) => {
      const stored = manifests.get(keyPrefix);
      return stored ? { manifest: structuredClone(stored.manifest), etag: stored.etag } : null;
    },
    putManifestIfMatch: async (keyPrefix, next, etag) => {
      writes.push({ keyPrefix, manifest: next, etag });
      if (casFailOn && keyPrefix.endsWith(casFailOn)) {
        casFailOn = undefined;
        return false;
      }
      manifests.set(keyPrefix, { manifest: next, etag: `${etag}-next` });
      return true;
    },
    mergeListRows: async (patches) => {
      listWrites.push(patches);
    },
  };
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const judge = vi.fn<(input: TensionJudgementInput) => Promise<TensionJudgementResult>>(
    async () => supersedes,
  );
  const readReport = vi.fn(async (): Promise<string | null> => JSON.stringify(report()));
  const createStorage = vi.fn(async () => storage);
  const deps: CorpusRefreshTensionsDeps = {
    io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    readReport,
    createStorage,
    loadProvider: async () => ({
      provider: "openai",
      model: "gpt-5.6-terra",
      effort: "high",
      estimate: () => ({ inputTokens: 900, outputTokens: 128, costUsd: 0.004 }),
      judge,
    }),
    now: () => Date.parse(JUDGED_AT),
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  const stored = (id: string) => manifests.get(`readings/2026/${id}`)!.manifest;
  return { deps, out, err, sleeps, judge, readReport, createStorage, writes, listWrites, manifests, stored };
}

const run = (h: ReturnType<typeof harness>, ...argv: string[]) =>
  corpusRefreshTensionsCommand.run(["--tenant", "global", ...argv], h.deps);

/** A fake clock that advances a fixed step on every read. */
function fakeClock(stepMs: number, startMs = Date.parse(JUDGED_AT)) {
  let value = startMs - stepMs;
  return () => {
    value += stepMs;
    return value;
  };
}

describe("ops corpus refresh-tensions", () => {
  it("prints a Timing block for a plan pass with no provider phase", async () => {
    const h = harness();
    expect(
      await corpusRefreshTensionsCommand.run(["--tenant", "global"], {
        ...h.deps,
        now: fakeClock(10),
      }),
    ).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("Timing:");
    expect(text).toMatch(/list read\s+1 call\s+0\.010s/);
    // Three reads, overlapped: the phase total sums the call durations, which
    // under concurrency exceeds the wall time they actually took.
    expect(text).toMatch(/planning reads\s+3 calls\s+0\.090s/);
    expect(text).not.toMatch(/^ {2}provider\s+\d+ call/m);
    expect(text).not.toContain("manifest write");
  });

  it("separates planning reads from the execute pass and times each judgement", async () => {
    const h = harness();
    expect(
      await corpusRefreshTensionsCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer"],
        { ...h.deps, now: fakeClock(10) },
      ),
    ).toBe(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/planning reads\s+3 calls\s+0\.090s/);
    // One judged pair, and no side of it written earlier in the pass: both
    // writes go out against the ETags planning kept, so nothing is re-read.
    expect(text).not.toContain("manifest read");
    expect(text).toMatch(/provider\s+1 call\s+0\.010s/);
    expect(text).toMatch(/manifest write\s+2 calls/);
    expect(text).not.toContain("list write");
    expect(text).toContain("rd_a|rd_b  usage input=100 output=20 reasoning=0 ms=10");
  });

  /** Wraps `createStorage` so a test can see every manifest key that is read. */
  function countReads(h: ReturnType<typeof harness>): string[] {
    const reads: string[] = [];
    const create = h.deps.createStorage;
    h.deps.createStorage = async (...args) => {
      const storage = await create(...args);
      const readManifest = storage.readManifest;
      storage.readManifest = async (keyPrefix) => {
        reads.push(keyPrefix);
        return readManifest(keyPrefix);
      };
      return storage;
    };
    return reads;
  }

  it("re-reads only a side an earlier pair in the same pass wrote", async () => {
    const h = harness();
    const reads = countReads(h);
    // Two pairs sharing rd_a. In key order rd_a|rd_b runs first and writes
    // both its sides, so rd_a|rd_c must read rd_a again for a live ETag —
    // and rd_c, untouched so far, still comes from the planning read.
    expect(await run(h, "--report", "refresh-report.json", "--pair", "rd_a,rd_c", "--execute", "--sole-writer")).toBe(0);
    expect(h.judge).toHaveBeenCalledTimes(2);
    expect(reads).toEqual([
      "readings/2026/rd_a",
      "readings/2026/rd_b",
      "readings/2026/rd_c",
      "readings/2026/rd_a",
    ]);
    expect(h.stored("rd_a").tensions).toHaveLength(2);
    expect(h.stored("rd_c").tensions).toHaveLength(1);
  });

  it("detects a manifest changed since planning through the CAS alone", async () => {
    const h = harness();
    const create = h.deps.createStorage;
    h.deps.createStorage = async (...args) => {
      const storage = await create(...args);
      const putManifestIfMatch = storage.putManifestIfMatch;
      // A conditional write that actually compares: a stale ETag loses.
      storage.putManifestIfMatch = async (keyPrefix, next, etag) =>
        h.manifests.get(keyPrefix)?.etag === etag
          ? putManifestIfMatch(keyPrefix, next, etag)
          : false;
      return storage;
    };
    // rd_a is rewritten underneath the pass while its judgement is in flight.
    h.judge.mockImplementationOnce(async () => {
      h.manifests.set("readings/2026/rd_a", {
        manifest: manifest("rd_a", { people: ["Ada"] }),
        etag: "e-a-someone-else",
      });
      return supersedes;
    });
    expect(await run(h, "--execute", "--sole-writer")).toBe(1);
    expect(h.err.join("\n")).toContain(
      "  ! rd_a|rd_b: manifest CAS lost; no overwrite performed",
    );
    // Neither side was written: the loser aborts before its partner's write.
    expect(h.stored("rd_a")).not.toHaveProperty("tensions");
    expect(h.stored("rd_b")).not.toHaveProperty("tensions");
  });

  it("lists candidate pairs with overlap evidence and cost in plan mode without provider or storage writes", async () => {
    const h = harness();
    expect(await run(h)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("rd_a<->rd_b  judge score=0.900 people=[ada] orgs=(none) keywords=0(0.00) cited=(none)");
    expect(text).toContain("input≈900 output=128 cost≈$0.004000");
    expect(text).not.toContain("rd_a<->rd_c");
    expect(text).toContain("Selected actions: 1; below overlap threshold: 1; already judged: 0; repair pending: 0");
    expect(text).toContain("Estimated synchronous cost: $0.004000");
    expect(text).toContain("no provider call or storage write");
    expect(text).not.toContain("usage input=");
    expect(text).not.toContain("Usage:");
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("prints the provider usage per judgement and a run total", async () => {
    const h = harness();
    expect(await run(h, "--execute", "--sole-writer")).toBe(0);
    expect(h.judge).toHaveBeenCalledOnce();
    const text = h.out.join("\n");
    expect(text).toContain("rd_a|rd_b  usage input=100 output=20 reasoning=0");
    expect(text).toContain("Usage: 1 judgement; input=100 output=20 reasoning=0");
  });

  it("counts the usage of a judgement that then fails to write", async () => {
    const h = harness({ casFailOn: "rd_a" });
    expect(await run(h, "--execute", "--sole-writer")).toBe(1);
    expect(h.out.join("\n")).toContain("Usage: 1 judgement; input=100 output=20 reasoning=0");
  });

  it("prints a zero run total when no judgement was made", async () => {
    const h = harness();
    h.stored("rd_a").tensions_judged = [{ id: "rd_b", judged_at: AT }];
    h.stored("rd_b").tensions_judged = [{ id: "rd_a", judged_at: AT }];
    expect(await run(h, "--execute", "--sole-writer")).toBe(0);
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.out.join("\n")).toContain("Usage: 0 judgements; input=0 output=0");
  });

  it("refuses execute without sole-writer before reading the report or storage", async () => {
    const h = harness();
    await expect(run(h, "--execute")).rejects.toThrow(/--sole-writer/);
    expect(h.readReport).not.toHaveBeenCalled();
    expect(h.createStorage).not.toHaveBeenCalled();
  });

  it("rejects malformed --pair and --limit values as usage errors", async () => {
    const h = harness();
    await expect(run(h, "--pair", "rd_a")).rejects.toThrow(/--pair/);
    await expect(run(h, "--pair", "rd_a,rd_a")).rejects.toThrow(/distinct/);
    await expect(run(h, "--limit", "0")).rejects.toThrow(/--limit/);
  });

  it("writes correct directional tensions to both manifests for a hand-picked pair", async () => {
    const h = harness();
    expect(await run(h, "--pair", "rd_b,rd_a", "--execute", "--sole-writer")).toBe(0);
    expect(h.judge).toHaveBeenCalledOnce();
    expect(h.judge.mock.calls[0]![0]).toMatchObject({ a: { id: "rd_a" }, b: { id: "rd_b" } });
    expect(h.writes.map((write) => write.keyPrefix)).toEqual(["readings/2026/rd_a", "readings/2026/rd_b"]);
    expect(h.stored("rd_a")).toMatchObject({
      tensions: [{ id: "rd_b", kind: "superseded_by", reason: "rd_b retracts rd_a", computed_at: JUDGED_AT }],
      tensions_judged: [{ id: "rd_b", judged_at: JUDGED_AT }],
      updated_at: EARLIER,
      future_field: { keep: "rd_a" },
      connections: [],
    });
    expect(h.stored("rd_b")).toMatchObject({
      tensions: [{ id: "rd_a", kind: "supersedes", reason: "rd_b retracts rd_a", computed_at: JUDGED_AT }],
      tensions_judged: [{ id: "rd_a", judged_at: JUDGED_AT }],
      updated_at: EARLIER,
      future_field: { keep: "rd_b" },
    });
    expect(h.listWrites).toEqual([]);
    expect(h.out.join("\n")).toContain("rd_a<->rd_b  judge (--pair)");
    expect(h.out.join("\n")).toContain("Judged: 1; manifests written: 2; repaired: 0; skipped since plan: 0; failures: 0");
  });

  it("lets --pair bypass the overlap filter and the judged skip, and ignores the default report", async () => {
    const h = harness();
    h.stored("rd_a").tensions_judged = [{ id: "rd_c", judged_at: JUDGED_AT }];
    h.stored("rd_c").tensions_judged = [{ id: "rd_a", judged_at: JUDGED_AT }];
    expect(await run(h, "--pair", "rd_a,rd_c", "--execute", "--sole-writer")).toBe(0);
    expect(h.readReport).not.toHaveBeenCalled();
    expect(h.out.join("\n")).toContain("Report: none (--pair only)");
    expect(h.judge).toHaveBeenCalledOnce();
    expect(h.stored("rd_c").tensions).toEqual([
      { id: "rd_a", kind: "supersedes", reason: "rd_b retracts rd_a", computed_at: JUDGED_AT },
    ]);
  });

  it("fails without a report when no --pair is given", async () => {
    const h = harness();
    h.readReport.mockResolvedValue(null);
    await expect(run(h)).rejects.toThrow(/refresh-neighbours first or pass --pair/);
  });

  it("skips report pairs both sides already remember judging", async () => {
    const h = harness();
    h.stored("rd_a").tensions_judged = [{ id: "rd_b", judged_at: AT }];
    h.stored("rd_b").tensions_judged = [{ id: "rd_a", judged_at: AT }];
    expect(await run(h, "--execute", "--sole-writer")).toBe(0);
    expect(h.out.join("\n")).toContain("Selected actions: 0; below overlap threshold: 1; already judged: 1; repair pending: 0");
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("re-judges a pair when one side was reprocessed after the judgement", async () => {
    const h = harness();
    h.stored("rd_a").tensions_judged = [{ id: "rd_b", judged_at: EARLIER }];
    h.stored("rd_b").tensions_judged = [{ id: "rd_a", judged_at: EARLIER }];
    h.stored("rd_b").updated_at = "2026-06-01T00:00:00.000Z";
    expect(await run(h)).toBe(0);
    expect(h.out.join("\n")).toContain("rd_a<->rd_b  judge score");
  });

  it("removes a prior tension on a none verdict and remembers the judgement on both sides", async () => {
    const h = harness();
    h.stored("rd_a").tensions = [{ id: "rd_b", kind: "contradicts", reason: "old", computed_at: EARLIER }];
    h.stored("rd_b").tensions = [{ id: "rd_a", kind: "contradicts", reason: "old", computed_at: EARLIER }];
    h.judge.mockResolvedValue({ ...supersedes, judgement: { verdict: "none", side: null, reason: "" } });
    expect(await run(h, "--execute", "--sole-writer")).toBe(0);
    expect(h.stored("rd_a").tensions).toEqual([]);
    expect(h.stored("rd_b").tensions).toEqual([]);
    expect(h.stored("rd_a").tensions_judged).toEqual([{ id: "rd_b", judged_at: JUDGED_AT }]);
    expect(h.stored("rd_b").tensions_judged).toEqual([{ id: "rd_a", judged_at: JUDGED_AT }]);
  });

  it("reports a one-sided write when the second CAS loses, then repairs it on rerun without a paid call", async () => {
    const h = harness({ casFailOn: "rd_b" });
    expect(await run(h, "--execute", "--sole-writer")).toBe(1);
    expect(h.judge).toHaveBeenCalledOnce();
    expect(h.stored("rd_a").tensions).toHaveLength(1);
    expect(h.stored("rd_b")).not.toHaveProperty("tensions");
    expect(h.err.join("\n")).toMatch(/rd_b not written after rd_a was \(one-sided; rerun repairs it\): manifest CAS lost/);

    h.out.length = 0;
    expect(await run(h)).toBe(0);
    expect(h.out.join("\n")).toContain("already judged: 0; repair pending: 1");
    expect(h.out.join("\n")).toContain("rd_b<-rd_a  repair mirror supersedes (no provider call)");
    expect(h.out.join("\n")).toContain("Estimated synchronous cost: $0.000000");

    expect(await run(h, "--execute", "--sole-writer")).toBe(0);
    expect(h.judge).toHaveBeenCalledOnce();
    expect(h.stored("rd_b")).toMatchObject({
      tensions: [{ id: "rd_a", kind: "supersedes", reason: "rd_b retracts rd_a", computed_at: JUDGED_AT }],
      tensions_judged: [{ id: "rd_a", judged_at: JUDGED_AT }],
    });
    expect(h.out.join("\n")).toContain("Judged: 0; manifests written: 1; repaired: 1; skipped since plan: 0; failures: 0");
  });

  it("drops a stale one-sided tension whose partner was reprocessed since", async () => {
    const h = harness();
    h.stored("rd_a").tensions = [{ id: "rd_c", kind: "qualifies", reason: "old", computed_at: EARLIER }];
    h.stored("rd_a").tensions_judged = [
      { id: "rd_c", judged_at: EARLIER },
      { id: "rd_b", judged_at: AT },
    ];
    h.stored("rd_c").updated_at = "2026-03-01T00:00:00.000Z";
    h.stored("rd_b").tensions_judged = [{ id: "rd_a", judged_at: AT }];
    expect(await run(h, "--execute", "--sole-writer")).toBe(0);
    expect(h.out.join("\n")).toContain("rd_a  repair drop stale tension -> rd_c (partner reprocessed since)");
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.stored("rd_a").tensions).toEqual([]);
    expect(h.stored("rd_a").tensions_judged).toEqual([
      { id: "rd_c", judged_at: EARLIER },
      { id: "rd_b", judged_at: AT },
    ]);
  });

  it("finishes a lost none verdict by dropping the partner's surviving entry", async () => {
    const h = harness();
    h.stored("rd_a").tensions_judged = [{ id: "rd_b", judged_at: AT }];
    h.stored("rd_b").tensions = [{ id: "rd_a", kind: "supersedes", reason: "old", computed_at: EARLIER }];
    h.stored("rd_b").tensions_judged = [{ id: "rd_a", judged_at: EARLIER }];
    expect(await run(h, "--execute", "--sole-writer")).toBe(0);
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.out.join("\n")).toContain(`rd_b  repair drop tension -> rd_a (partner judged none at ${AT})`);
    expect(h.stored("rd_b").tensions).toEqual([]);
    expect(h.stored("rd_b").tensions_judged).toEqual([{ id: "rd_a", judged_at: AT }]);
    expect(h.stored("rd_a")).not.toHaveProperty("tensions");
  });

  it("refuses an explicitly passed stale report even when --pair names the drifted reading", async () => {
    const h = harness();
    h.stored("rd_b").updated_at = JUDGED_AT;
    await expect(run(h, "--report", "r.json", "--pair", "rd_a,rd_b")).rejects.toThrow(
      /rd_b changed after.*regenerate/,
    );
    expect(h.readReport).toHaveBeenCalledWith("r.json");
  });

  it("combines an explicit report with --pair and forces the hand-picked pair", async () => {
    const h = harness();
    h.stored("rd_a").tensions_judged = [{ id: "rd_b", judged_at: AT }];
    h.stored("rd_b").tensions_judged = [{ id: "rd_a", judged_at: AT }];
    expect(await run(h, "--report", "r.json", "--pair", "rd_a,rd_b")).toBe(0);
    expect(h.out.join("\n")).toContain("Report: r.json (1 flagged)");
    expect(h.out.join("\n")).toContain("rd_a<->rd_b  judge (--pair) score=0.900");
  });

  it("purges tensions and judged records whose partner was deleted or is not ready", async () => {
    const h = harness();
    h.stored("rd_c").tensions = [
      { id: "rd_deleted", kind: "supersedes", reason: "gone", computed_at: EARLIER },
      { id: "rd_failed", kind: "contradicts", reason: "never ready", computed_at: EARLIER },
    ];
    h.stored("rd_c").tensions_judged = [
      { id: "rd_deleted", judged_at: EARLIER },
      { id: "rd_failed", judged_at: EARLIER },
    ];
    h.stored("rd_c").connections = [{ id: "rd_deleted", reason: "still cited" }];
    const before = structuredClone(h.stored("rd_c"));
    h.out.length = 0;
    expect(await run(h)).toBe(0);
    expect(h.out.join("\n")).toContain("rd_c  repair drop dangling tension -> rd_deleted (partner deleted or not ready)");
    expect(h.out.join("\n")).toContain("rd_c  repair drop dangling tension -> rd_failed (partner deleted or not ready)");
    expect(h.writes).toEqual([]);

    expect(await run(h, "--execute", "--sole-writer")).toBe(0);
    expect(h.judge).toHaveBeenCalledOnce();
    const after = h.stored("rd_c");
    expect(after.tensions).toEqual([]);
    expect(after.tensions_judged).toEqual([]);
    const { tensions: _t, tensions_judged: _j, ...rest } = after;
    const { tensions: _bt, tensions_judged: _bj, ...beforeRest } = before;
    expect(rest).toEqual(beforeRest);
    expect(after.connections).toEqual([{ id: "rd_deleted", reason: "still cited" }]);
    expect(after.updated_at).toBe(EARLIER);
  });

  it("caps paid judgements with --limit while free repairs always run", async () => {
    const h = harness();
    h.stored("rd_c").tensions = [{ id: "rd_b", kind: "contradicts", reason: "r", computed_at: AT }];
    h.stored("rd_c").people = ["Ada"];
    h.readReport.mockResolvedValue(
      JSON.stringify(report([{ id: "rd_a", neighbours: ["rd_b", "rd_c"] }])),
    );
    expect(await run(h, "--limit", "1")).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("Selected actions: 2;");
    expect(text).toContain("rd_a<->rd_b  judge");
    expect(text).not.toContain("rd_a<->rd_c  judge");
    expect(text).toContain("rd_b<-rd_c  repair mirror contradicts");
  });

  it("still repairs a pair whose paid judgement was cut by --limit", async () => {
    const h = harness();
    // rd_a|rd_c is a candidate (shared person) sorted after rd_a|rd_b, so
    // --limit 1 cuts its judgement; its stale one-sided entry must still drop.
    h.stored("rd_c").people = ["Ada"];
    h.stored("rd_c").tensions = [{ id: "rd_a", kind: "qualifies", reason: "old", computed_at: EARLIER }];
    h.stored("rd_a").updated_at = "2026-06-01T00:00:00.000Z";
    expect(await run(h, "--limit", "1")).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("rd_a<->rd_b  judge");
    expect(text).not.toContain("rd_a<->rd_c  judge");
    expect(text).toContain("rd_c  repair drop stale tension -> rd_a (partner reprocessed since)");
    expect(text).toContain("Selected actions: 2;");
  });

  it("fails on an explicitly passed report that does not exist even with --pair", async () => {
    const h = harness();
    h.readReport.mockResolvedValue(null);
    await expect(run(h, "--report", "typo.json", "--pair", "rd_a,rd_b")).rejects.toThrow(
      /report typo.json not found/,
    );
    expect(h.judge).not.toHaveBeenCalled();
  });

  it("does not write the second side when the first CAS loses", async () => {
    const h = harness({ casFailOn: "rd_a" });
    expect(await run(h, "--execute", "--sole-writer")).toBe(1);
    expect(h.writes).toHaveLength(1);
    expect(h.stored("rd_b")).not.toHaveProperty("tensions");
    expect(h.err.join("\n")).toMatch(/rd_a\|rd_b: manifest CAS lost/);
  });

  it("rejects a stale report and a tenant mismatch", async () => {
    const h = harness();
    h.stored("rd_b").updated_at = JUDGED_AT;
    await expect(run(h)).rejects.toThrow(/rd_b changed after.*regenerate/);
    const mismatch = harness();
    mismatch.readReport.mockResolvedValue(JSON.stringify({ ...report(), tenant: "usr_x" }));
    await expect(run(mismatch)).rejects.toThrow(/does not match --tenant/);
    expect(mismatch.judge).not.toHaveBeenCalled();
  });

  it("reports an invalid manifest and an unknown --pair id as an incomplete plan", async () => {
    const h = harness();
    delete h.stored("rd_b").content_type;
    expect(await run(h)).toBe(1);
    expect(h.err.join("\n")).toMatch(/rd_b: live ready manifest is invalid/);
    expect(h.judge).not.toHaveBeenCalled();
    const missing = harness();
    expect(await run(missing, "--pair", "rd_a,rd_zz")).toBe(1);
    expect(missing.err.join("\n")).toMatch(/rd_zz: no live ready list row/);
  });

  it("skips a target without stored summary text", async () => {
    const h = harness();
    h.stored("rd_a").summary_markdown = " ";
    delete h.stored("rd_a").tldr;
    expect(await run(h)).toBe(1);
    expect(h.err.join("\n")).toMatch(/rd_a\|rd_b: ready reading rd_a has no stored summary text/);
  });

  it("builds a provider plan from Worker vars with a tension-shaped estimate", () => {
    const plan = tensionProviderFromVars(
      { SUMMARIZER_PROVIDER: "openai", OPENAI_SUMMARIZATION_MODEL: "gpt-5.6-terra" },
      false,
    );
    expect(plan).toMatchObject({ provider: "openai", model: "gpt-5.6-terra", effort: "low" });
    const estimate = plan.estimate({
      a: { id: "rd_a", url: "u", title: "t", tldr: "l", summary_markdown: "s" },
      b: { id: "rd_b", url: "u", title: "t", tldr: "l", summary_markdown: "s" },
    });
    expect(estimate.outputTokens).toBe(128);
    expect(estimate.inputTokens).toBeGreaterThan(100);
    expect(estimate.costUsd).toBeGreaterThan(0);
    expect(() => tensionProviderFromVars({ SUMMARIZER_PROVIDER: "openai" }, true)).toThrow(/OPENAI_API_KEY/);
    expect(
      tensionProviderFromVars({ SUMMARIZER_PROVIDER: "anthropic", ANTHROPIC_MODEL: "claude-sonnet-5" }, false),
    ).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" });
  });
});

describe("ops corpus refresh-tensions planning read concurrency", () => {
  const COUNT = 12;
  const ids = Array.from({ length: COUNT }, (_, i) => `rd_${String(i).padStart(2, "0")}`);

  /**
   * Runs a plan pass over `COUNT` readings, each flagged with the next one as
   * its neighbour, and reports both the peak overlap and the plan output.
   */
  async function planPass(delayFor: (keyPrefix: string) => number) {
    const items = ids.map(listRow);
    const manifests = new Map(
      items.map((row) => [
        row.key_prefix,
        { manifest: manifest(row.id, { keywords: ["shared-one", "shared-two", "shared-three"] }), etag: `e-${row.id}` },
      ]),
    );
    let inFlight = 0;
    let peak = 0;
    const completed: string[] = [];
    const storage: RefreshTensionsStorage = {
      readListIndex: async () => items,
      readManifest: async (keyPrefix) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, delayFor(keyPrefix)));
        inFlight--;
        completed.push(keyPrefix);
        const stored = manifests.get(keyPrefix);
        return stored ? { manifest: structuredClone(stored.manifest), etag: stored.etag } : null;
      },
      putManifestIfMatch: async () => true,
      mergeListRows: async () => {},
    };
    const h = harness();
    h.createStorage.mockResolvedValue(storage);
    h.readReport.mockResolvedValue(
      JSON.stringify(
        report(ids.map((id, index) => ({ id, neighbours: [ids[(index + 1) % COUNT]!] }))),
      ),
    );
    const code = await corpusRefreshTensionsCommand.run(["--tenant", "global"], h.deps);
    // The Timing block is wall-clock and is expected to differ between a
    // sequential and a concurrent pass; everything else must not.
    const plan = h.out.slice(0, h.out.findIndex((line) => line.includes("Timing:")));
    return { code, plan, peak, completed, err: h.err };
  }

  it("overlaps planning reads up to the cap without changing the plan", async () => {
    const inOrder = await planPass(() => 0);
    // Two of the reads finish late, so this pass completes in a different
    // order from the one above while planning exactly the same corpus.
    const outOfOrder = await planPass((keyPrefix) => (keyPrefix.endsWith("0") ? 3 : 0));

    expect(outOfOrder.peak).toBe(8);
    expect(inOrder.peak).toBe(8);
    expect(outOfOrder.completed).not.toEqual(inOrder.completed);
    expect(outOfOrder.code).toBe(inOrder.code);
    expect(outOfOrder.err).toEqual(inOrder.err);
    expect(outOfOrder.plan).toEqual(inOrder.plan);
    expect(outOfOrder.plan.join("\n")).toMatch(/Selected actions: \d+/);
  });

  it("reads each manifest once", async () => {
    const { completed } = await planPass(() => 0);
    expect(completed).toHaveLength(COUNT);
    expect(new Set(completed).size).toBe(COUNT);
  });
});

describe("ops corpus refresh-tensions execute concurrency", () => {
  const ids = Array.from({ length: 10 }, (_, i) => `rd_${String(i).padStart(2, "0")}`);
  // A chain whose neighbours share a side (00-01, 01-02, 02-03) alongside
  // pairs that share nothing, so the fixture needs both exclusion and overlap.
  const pairs: Array<[string, string]> = [
    ["rd_00", "rd_01"],
    ["rd_01", "rd_02"],
    ["rd_02", "rd_03"],
    ["rd_04", "rd_05"],
    ["rd_06", "rd_07"],
    ["rd_08", "rd_09"],
  ];
  const plannedKeys = [...pairs]
    .map(([a, b]) => `${a}|${b}`)
    .sort((x, y) => x.localeCompare(y));

  function scaled(opts: { casFailOn?: string } = {}) {
    const items = ids.map(listRow);
    const manifests = new Map(
      ids.map((id) => [
        `readings/2026/${id}`,
        { manifest: manifest(id) as Record<string, unknown>, etag: `e-${id}` },
      ]),
    );
    const writes: Array<{ keyPrefix: string; etag: string }> = [];
    const storage: RefreshTensionsStorage = {
      readListIndex: async () => items,
      readManifest: async (keyPrefix) => {
        const stored = manifests.get(keyPrefix);
        return stored
          ? { manifest: structuredClone(stored.manifest), etag: stored.etag }
          : null;
      },
      putManifestIfMatch: async (keyPrefix, next, etag) => {
        writes.push({ keyPrefix, etag });
        if (opts.casFailOn !== undefined && keyPrefix.endsWith(opts.casFailOn)) return false;
        manifests.set(keyPrefix, { manifest: next, etag: `${etag}-next` });
        return true;
      },
      mergeListRows: async () => {},
    };

    const held = new Set<string>();
    const clashes: string[] = [];
    const judgeOrder: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const h = harness();
    h.readReport.mockResolvedValue(null);
    h.createStorage.mockResolvedValue(storage);
    h.judge.mockImplementation(async (input) => {
      // A reading held by two judgements at once is the CAS loss the flag must
      // not manufacture; record it rather than relying on the write to notice.
      for (const id of [input.a.id, input.b.id]) {
        if (held.has(id)) clashes.push(id);
        held.add(id);
      }
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, input.a.id.endsWith("0") ? 4 : 1));
      inFlight--;
      for (const id of [input.a.id, input.b.id]) held.delete(id);
      judgeOrder.push(`${input.a.id}|${input.b.id}`);
      return supersedes;
    });
    return { h, manifests, writes, clashes, judgeOrder, peak: () => peak };
  }

  const execute = (h: ReturnType<typeof harness>, ...extra: string[]) =>
    corpusRefreshTensionsCommand.run(
      [
        "--tenant",
        "global",
        "--execute",
        "--sole-writer",
        ...pairs.flatMap(([a, b]) => ["--pair", `${a},${b}`]),
        ...extra,
      ],
      h.deps,
    );

  it("overlaps disjoint pairs but never two that share a reading", async () => {
    const s = scaled();

    expect(await execute(s.h)).toBe(0);

    expect(s.clashes).toEqual([]);
    expect(s.peak()).toBeGreaterThan(1);
    expect(s.peak()).toBeLessThanOrEqual(4);
    expect(s.h.out.join("\n")).toContain("Mode: EXECUTE (concurrency 4)");
  });

  it("prints every pair in plan order however the calls complete", async () => {
    const s = scaled();

    expect(await execute(s.h)).toBe(0);

    expect(s.judgeOrder).not.toEqual(plannedKeys);
    const printed = s.h.out
      .filter((line) => line.includes("usage input="))
      .map((line) => line.trim().split(/\s+/)[0]);
    expect(printed).toEqual(plannedKeys);
    expect(s.h.out.join("\n")).toContain(
      `Judged: ${pairs.length}; manifests written: ${pairs.length * 2}; repaired: 0; ` +
        "skipped since plan: 0; failures: 0",
    );
  });

  it("honours a lower cap", async () => {
    const s = scaled();
    expect(await execute(s.h, "--concurrency", "2")).toBe(0);
    expect(s.peak()).toBe(2);
    expect(s.clashes).toEqual([]);
  });

  it("writes neither side of a pair whose first write loses the CAS", async () => {
    // rd_00 is the `a` side of the first pair, so its loss lands before any
    // write for that pair.
    const s = scaled({ casFailOn: "rd_00" });

    expect(await execute(s.h)).toBe(1);

    expect(s.writes.filter((write) => write.keyPrefix.endsWith("rd_00"))).toHaveLength(1);
    expect(s.manifests.get("readings/2026/rd_00")!.etag).toBe("e-rd_00");
    expect(s.manifests.get("readings/2026/rd_00")!.manifest.tensions).toBeUndefined();
    // The partner is untouched too: the pair wrote nothing at all.
    expect(s.writes.filter((write) => write.keyPrefix.endsWith("rd_01"))).toHaveLength(1);
    expect(s.manifests.get("readings/2026/rd_01")!.manifest.tensions).toEqual([
      expect.objectContaining({ id: "rd_02" }),
    ]);
    expect(s.h.err.join("\n")).toContain("rd_00|rd_01: manifest CAS lost; no overwrite performed");
    expect(s.h.out.join("\n")).toContain(
      `Judged: ${pairs.length}; manifests written: ${pairs.length * 2 - 2}; repaired: 0; ` +
        "skipped since plan: 0; failures: 1",
    );
  });

  /** Runs with a clock that a backoff actually moves, as a real one would. */
  const executeOnAClock = (h: ReturnType<typeof harness>, ...extra: string[]) => {
    let clock = Date.parse(JUDGED_AT);
    return corpusRefreshTensionsCommand.run(
      [
        "--tenant",
        "global",
        "--execute",
        "--sole-writer",
        ...pairs.flatMap(([a, b]) => ["--pair", `${a},${b}`]),
        ...extra,
      ],
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

  it("backs the whole pass off once on a 429, and retries the pair that hit it", async () => {
    const s = scaled();
    const inner = s.h.judge.getMockImplementation()!;
    let first = true;
    s.h.judge.mockImplementation(async (input) => {
      if (first) {
        first = false;
        throw new RateLimitedError(429, 1_500, "https://api.openai.com/v1/responses");
      }
      return inner(input);
    });

    expect(await execute(s.h)).toBe(0);

    expect(
      s.h.err.filter((line) => line.includes("pausing new judgements")),
    ).toEqual(["  ! provider rate limited; pausing new judgements for 1.500s"]);
    expect(s.h.sleeps.length).toBeGreaterThan(1);
    expect(new Set(s.h.sleeps)).toEqual(new Set([1_500]));
    // The retry lands after the window, so a transient limit costs a pause
    // rather than a pair — and it writes both sides, as any judgement does.
    expect(s.h.judge).toHaveBeenCalledTimes(pairs.length + 1);
    expect(s.h.out.join("\n")).toContain(
      `Judged: ${pairs.length}; manifests written: ${pairs.length * 2}; repaired: 0; ` +
        "skipped since plan: 0; failures: 0",
    );
  });

  it("fails a pair whose retry is rate limited too, without a third attempt", async () => {
    const s = scaled();
    const inner = s.h.judge.getMockImplementation()!;
    s.h.judge.mockImplementation(async (input) => {
      if (input.a.id === "rd_04") {
        throw new RateLimitedError(429, 1_000, "https://api.openai.com/v1/responses");
      }
      return inner(input);
    });

    expect(await executeOnAClock(s.h)).toBe(1);

    expect(
      s.h.judge.mock.calls.filter(([input]) => input.a.id === "rd_04"),
    ).toHaveLength(2);
    expect(s.h.err.join("\n")).toContain("rd_04|rd_05: rate limited by");
    expect(s.h.out.join("\n")).toContain(
      `Judged: ${pairs.length - 1}; manifests written: ${(pairs.length - 1) * 2}; ` +
        "repaired: 0; skipped since plan: 0; failures: 1",
    );
  });

  it("stops dispatching once the pass has spent its whole backoff budget", async () => {
    const s = scaled();
    s.h.judge.mockImplementation(async () => {
      throw new RateLimitedError(429, 60_000, "https://api.openai.com/v1/responses");
    });

    expect(await executeOnAClock(s.h, "--concurrency", "1", "--max-backoff", "2m")).toBe(1);

    expect(s.h.err.filter((line) => line.includes("backoff reached"))).toEqual([
      "  ! rate-limit backoff reached the 120.000s ceiling after 120.000s; " +
        "not dispatching the rest of this pass",
    ]);
    expect(s.h.sleeps.reduce((total, ms) => total + ms, 0)).toBe(120_000);
    expect(s.h.judge).toHaveBeenCalledTimes(3);
    expect(s.h.err).toContain(
      `  ! skip ${plannedKeys[plannedKeys.length - 1]}: ` +
        "backoff ceiling reached before this action ran",
    );
    expect(s.h.out.join("\n")).toContain(
      "Judged: 0; manifests written: 0; repaired: 0; skipped since plan: 0; " +
        `failures: 2; skipped at the backoff ceiling: ${pairs.length - 2}`,
    );
    expect(s.writes).toEqual([]);
  });
});
