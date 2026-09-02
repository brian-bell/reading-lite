import { describe, expect, it } from "vitest";
import {
  corpusRefreshNeighboursCommand,
  type CorpusRefreshNeighboursDeps,
  type CorpusRefreshNeighboursR2,
} from "../../../scripts/ops-lib/commands/corpus-refresh-neighbours";
import { UsageError, type CommandIo } from "../../../scripts/ops-lib/contract";
import type { RefreshNeighbour, RefreshRow } from "../../../scripts/corpus-lib/refresh-neighbours";
import type { ListRowPatch } from "../../../scripts/ops-lib/list-index-cas";
import { SIMILAR_TOP_K } from "../../../src/modules/stores/similarity-store";
import {
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
  manifestThrow?: string;
  queryThrow?: (id: string) => Error | undefined;
  listEtag?: string;
  state?: unknown;
  stateThrow?: string;
  stateWriteThrow?: string;
}) {
  const { io: cio, lines } = io();
  const calls = {
    queries: [] as Array<{ id: string; topK: number; namespace: string | undefined; metadata?: boolean }>,
    puts: [] as Array<{ key: string; body: Record<string, unknown> }>,
    indexWrites: 0,
    stateReads: 0,
    stateWrites: [] as unknown[],
    reports: [] as Array<{ path: string; body: string }>,
    mkdirs: [] as string[],
  };
  const deps: CorpusRefreshNeighboursDeps = {
    io: cio,
    r2: {
      readListIndex: async () => ({
        items: opts.items ?? [READY, NEIGHBOUR],
        ...(opts.listEtag === undefined ? {} : { etag: opts.listEtag }),
      }),
      readRefreshState: async () => {
        calls.stateReads++;
        if (opts.stateThrow) throw new Error(opts.stateThrow);
        return opts.state ?? null;
      },
      writeRefreshState: async (state) => {
        if (opts.stateWriteThrow) throw new Error(opts.stateWriteThrow);
        calls.stateWrites.push(state);
      },
      readManifest: async () => {
        if (opts.manifestThrow) throw new Error(opts.manifestThrow);
        return opts.manifest === undefined ? { ...VALID_MANIFEST } : opts.manifest;
      },
      queryByVectorId: async (_index, id, topK, namespace, queryOpts) => {
        calls.queries.push({
          id,
          topK,
          namespace,
          ...(queryOpts?.metadata === undefined ? {} : { metadata: queryOpts.metadata }),
        });
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
      putManifest: async (key, body) => {
        calls.puts.push({ key, body: body as Record<string, unknown> });
      },
      mergeListRows: async () => {
        calls.indexWrites++;
      },
    },
    now: () => Date.parse("2026-08-22T12:00:00Z"),
    mkdir: async (dir) => {
      calls.mkdirs.push(dir);
    },
    writeFile: async (filePath, body) => {
      calls.reports.push({ path: filePath, body });
    },
  };
  return { deps, lines, calls };
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
  it("prints a Timing block naming every phase the pass used", async () => {
    const { deps, lines } = makeDeps({});
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", "global"], {
      ...deps,
      now: fakeClock(10),
    });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Timing:");
    expect(text).toMatch(/list read\s+1 call\s+0\.010s/);
    // Two ready readings measured: one Vectorize query and one manifest read each.
    expect(text).toMatch(/vectorize query\s+2 calls\s+0\.020s/);
    expect(text).toMatch(/manifest read\s+2 calls\s+0\.020s/);
    expect(text).toMatch(/total\s+0\.\d\d\ds/);
    // Plan mode writes nothing, so the write phases never ran.
    expect(text).not.toContain("manifest write");
    expect(text).not.toContain("list write");
  });

  it("times the writes an execute pass makes and still prints the block on a failed run", async () => {
    const { deps, lines } = makeDeps({ manifestThrow: "unparseable" });
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", "global", "--execute", "--sole-writer"],
      { ...deps, now: fakeClock(5) },
    );
    expect(code).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("Timing:");
    // The failed reads are counted: a stalled read is exactly the wall time an
    // operator needs to see.
    expect(text).toMatch(/manifest read\s+2 calls/);
  });

  it("plan mode queries and writes the report but does not mutate R2", async () => {
    const { deps, calls, lines } = makeDeps({});
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", "global"], deps);
    expect(code).toBe(0);
    expect(calls.queries).toHaveLength(2);
    expect(calls.puts).toHaveLength(0);
    expect(calls.indexWrites).toBe(0);
    expect(calls.reports).toHaveLength(1);
    expect(calls.reports[0]!.path).toMatch(/refresh-report\.json$/);
    const report = JSON.parse(calls.reports[0]!.body);
    expect(report.version).toBe(1);
    expect(report.tenant).toBe("global");
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

    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", "global", "rd_r"],
      deps,
    );

    expect(code).toBe(0);
    expect(JSON.parse(calls.reports[0]!.body).readings[0].reasons).toEqual([
      "uncited_neighbour",
      "verdict_inconsistent",
    ]);
    expect(lines.join("\n")).toContain("uncited_neighbour,verdict_inconsistent");
  });

  it("--execute refreshes only drifted snapshots and preserves protected fields", async () => {
    const { deps, calls } = makeDeps({});
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", "global", "rd_r", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls.puts).toHaveLength(1);
    expect(calls.puts[0]!.key).toBe("readings/rd_r");
    expect(calls.indexWrites).toBe(1);
    const written = calls.puts[0]!.body;
    expect(written.status).toBe("ready");
    expect(written.title).toBe("A title");
    expect(written.tldr).toBe("A stored TL;DR.");
    expect(written.tags).toEqual(["ai"]);
    expect(written.keywords).toEqual(["one", "two", "three"]);
    expect(written.people).toEqual(["Ada"]);
    expect(written.orgs).toEqual(["OpenAI"]);
    expect(written.summary_markdown).toBe("body");
    expect(written.updated_at).toBe(AT);
    expect(written.similarity).toEqual({
      count: 1,
      max: 0.72,
      mean: 0.72,
      computed_at: "2026-08-22T12:00:00.000Z",
    });
  });

  it("a second immediate execute writes nothing when the snapshot already matches", async () => {
    const scored: RefreshRow = {
      ...READY,
      similarity: { count: 1, max: 0.72, mean: 0.72, computed_at: AT },
    };
    const { deps, calls } = makeDeps({ items: [scored, NEIGHBOUR] });
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", "global", "rd_r", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls.puts).toHaveLength(0);
    expect(calls.indexWrites).toBe(0);
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
      ["--tenant", "global", "rd_r", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls.puts).toHaveLength(0);
  });

  it("tenant mode queries by the prefixed id and strips the prefix from matches", async () => {
    const tenantId = "usr_11111111-1111-4111-8111-111111111111";
    const { deps, calls } = makeDeps({
      items: [READY, NEIGHBOUR],
      matches: [
        { id: `${tenantId}:rd_r`, score: 1 },
        { id: `${tenantId}:rd_n`, score: 0.6, title: "N", created_at: LATER },
      ],
    });
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", tenantId, "rd_r", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls.queries).toEqual([{ id: `${tenantId}:rd_r`, topK: SIMILAR_TOP_K + 1, namespace: tenantId }]);
    expect(calls.puts[0]!.body.similarity).toEqual({
      count: 1,
      max: 0.6,
      mean: 0.6,
      computed_at: "2026-08-22T12:00:00.000Z",
    });
    const report = JSON.parse(calls.reports[0]!.body);
    expect(report.tenant).toBe(tenantId);
    expect(report.readings[0].current_neighbours[0].id).toBe("rd_n");
  });

  it("refuses --execute without --sole-writer before touching R2", async () => {
    const { deps, calls, lines } = makeDeps({});
    await expect(
      corpusRefreshNeighboursCommand.run(["--tenant", "global", "--execute"], deps),
    ).rejects.toThrow(UsageError);
    expect(calls.queries).toHaveLength(0);
    expect(calls.puts).toHaveLength(0);
    expect(calls.indexWrites).toBe(0);
    expect(calls.reports).toHaveLength(0);
    expect(lines.join("\n")).toContain(
      "REFUSED: ops corpus refresh-neighbours --execute requires --sole-writer.",
    );
  });

  it("--sole-writer without --execute stays a plan and prints no banner", async () => {
    const { deps, calls, lines } = makeDeps({});
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", "global", "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls.puts).toHaveLength(0);
    expect(calls.indexWrites).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Mode: PLAN");
    expect(text).not.toContain("SOLE-WRITER MODE");
  });

  it("--execute --sole-writer announces the sole-writer banner", async () => {
    const { deps, lines } = makeDeps({});
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", "global", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("SOLE-WRITER MODE: ops corpus refresh-neighbours");
  });

  it("documents --sole-writer in help", async () => {
    expect(corpusRefreshNeighboursCommand.helpText).toContain("--sole-writer");
  });

  it("fails closed without --tenant", async () => {
    const { deps, calls } = makeDeps({});
    await expect(corpusRefreshNeighboursCommand.run(["--execute"], deps)).rejects.toThrow(/--tenant is required/);
    expect(calls.puts).toHaveLength(0);
    expect(calls.reports).toHaveLength(0);
  });

  it("a missing vector makes an execute run incomplete (exit 1)", async () => {
    const { deps, calls } = makeDeps({ items: [READY], matches: null });
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", "global", "--execute", "--sole-writer"], deps);
    expect(code).toBe(1);
    expect(calls.puts).toHaveLength(0);
    expect(calls.reports).toHaveLength(1);
  });

  it("plan mode still exits 0 when a vector is missing", async () => {
    const { deps } = makeDeps({ items: [READY], matches: null });
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", "global"], deps);
    expect(code).toBe(0);
  });

  it("honours --out for the report path", async () => {
    const { deps, calls } = makeDeps({ items: [READY] });
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", "global", "--out", "reports/neighbours.json"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls.reports[0]!.path).toMatch(/reports\/neighbours\.json$/);
  });

  it("rejects an unknown flag as usage", async () => {
    const { deps } = makeDeps({});
    await expect(
      corpusRefreshNeighboursCommand.run(["--tenant", "global", "--bogus"], deps),
    ).rejects.toThrow(UsageError);
  });

  it("skips a non-ready reading even when named", async () => {
    const failed: RefreshRow = { ...READY, id: "rd_f", status: "failed", key_prefix: "readings/rd_f" };
    const { deps, calls } = makeDeps({ items: [failed] });
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", "global", "rd_f", "--execute", "--sole-writer"], deps);
    expect(code).toBe(0);
    expect(calls.queries).toHaveLength(0);
    expect(calls.puts).toHaveLength(0);
  });

  it("rewrites list.json when the manifest snapshot is current but the list row is stale", async () => {
    // Manifest write succeeded, list flush did not: the list row still has the
    // pre-refresh snapshot, while the live measurement matches the manifest.
    const current = { count: 1, max: 0.72, mean: 0.72, computed_at: AT };
    const listStale: RefreshRow = { ...READY, similarity: { count: 0, computed_at: AT } };
    const { deps, calls, lines } = makeDeps({
      items: [listStale, NEIGHBOUR],
      manifest: { ...VALID_MANIFEST, similarity: current },
    });
    const patched: ListRowPatch[][] = [];
    deps.r2.mergeListRows = async (patches) => {
      patched.push(patches);
      calls.indexWrites++;
    };

    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", "global", "rd_r", "--execute", "--sole-writer"],
      deps,
    );

    expect(code).toBe(0);
    expect(calls.puts).toHaveLength(0);
    expect(calls.indexWrites).toBe(1);
    expect(patched[0]).toEqual([{ id: "rd_r", similarity: current }]);
    expect(lines.join("\n")).toContain("list-stale");
  });

  it("heals the list row from manifest.similarity, not the sub-epsilon fresh measurement", async () => {
    // The retry re-query can land within the 0.02 epsilon of the manifest's
    // snapshot without matching it. The heal must restore row/manifest
    // lockstep, so it copies the manifest's values, never the fresh ones.
    const current = { count: 1, max: 0.729, mean: 0.729, computed_at: LATER };
    const listStale: RefreshRow = { ...READY, similarity: { count: 0, computed_at: AT } };
    const { deps, calls } = makeDeps({
      items: [listStale, NEIGHBOUR],
      manifest: { ...VALID_MANIFEST, similarity: current },
    });
    const patched: ListRowPatch[][] = [];
    deps.r2.mergeListRows = async (patches) => {
      patched.push(patches);
      calls.indexWrites++;
    };

    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", "global", "rd_r", "--execute", "--sole-writer"],
      deps,
    );

    expect(code).toBe(0);
    expect(calls.puts).toHaveLength(0);
    expect(calls.indexWrites).toBe(1);
    expect(patched[0]).toEqual([{ id: "rd_r", similarity: current }]);
  });

  it("plan mode treats a schema-invalid manifest as a failed measurement, not a report row", async () => {
    // storedConnections would silently drop the malformed entry and invent a
    // new_neighbour flag; the measurement must fail instead.
    const { deps, calls, lines } = makeDeps({
      items: [READY, NEIGHBOUR],
      manifest: { ...VALID_MANIFEST, connections: [{ id: "rd_n" }] },
    });
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", "global", "rd_r"], deps);
    expect(code).toBe(1);
    expect(calls.puts).toHaveLength(0);
    expect(JSON.parse(calls.reports[0]!.body).readings).toEqual([]);
    expect(lines.join("\n")).toMatch(/manifest fails ManifestSchema for rd_r/);
    expect(lines.join("\n")).toMatch(/not measured — run incomplete/);
  });

  it("execute fails closed on a schema-invalid manifest even without snapshot drift", async () => {
    const scored: RefreshRow = {
      ...READY,
      similarity: { count: 1, max: 0.72, mean: 0.72, computed_at: AT },
    };
    const { deps, calls, lines } = makeDeps({
      items: [scored, NEIGHBOUR],
      manifest: {
        ...VALID_MANIFEST,
        similarity: { count: 1, max: 0.72, mean: 0.72, computed_at: AT },
        connections: [{ id: "rd_n" }],
      },
    });
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", "global", "rd_r", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(1);
    expect(calls.puts).toHaveLength(0);
    expect(calls.indexWrites).toBe(0);
    expect(JSON.parse(calls.reports[0]!.body).readings).toEqual([]);
    expect(lines.join("\n")).toMatch(/manifest fails ManifestSchema for rd_r/);
  });

  it("plan mode treats a missing manifest as a failed measurement, not a list-only report row", async () => {
    const { deps, calls, lines } = makeDeps({ items: [READY], manifest: null });
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", "global"], deps);
    expect(code).toBe(1);
    expect(calls.puts).toHaveLength(0);
    expect(calls.reports).toHaveLength(1);
    expect(JSON.parse(calls.reports[0]!.body).readings).toEqual([]);
    expect(lines.join("\n")).toMatch(/manifest unreadable for rd_r/);
    expect(lines.join("\n")).toMatch(/not measured — run incomplete/);
  });

  it("execute still fails closed on an unreadable manifest when the list snapshot would not rewrite", async () => {
    const scored: RefreshRow = {
      ...READY,
      similarity: { count: 1, max: 0.72, mean: 0.72, computed_at: AT },
    };
    const { deps, calls, lines } = makeDeps({
      items: [scored, NEIGHBOUR],
      manifest: null,
    });
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", "global", "rd_r", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(1);
    expect(calls.puts).toHaveLength(0);
    expect(calls.indexWrites).toBe(0);
    expect(JSON.parse(calls.reports[0]!.body).readings).toEqual([]);
    expect(lines.join("\n")).toMatch(/manifest unreadable for rd_r/);
  });

  it("treats an unparseable manifest as a failed measurement in plan mode", async () => {
    const { deps, calls, lines } = makeDeps({
      items: [READY],
      manifestThrow: "Unexpected token",
    });
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", "global"], deps);
    expect(code).toBe(1);
    expect(JSON.parse(calls.reports[0]!.body).readings).toEqual([]);
    expect(calls.puts).toHaveLength(0);
    expect(lines.join("\n")).toMatch(/manifest unparseable for rd_r/);
  });

  it("isolates a Vectorize query failure and still writes the report for measured readings", async () => {
    const other: RefreshRow = { ...NEIGHBOUR, novelty_verdict: "familiar" };
    const { deps, calls, lines } = makeDeps({
      items: [READY, other],
      queryThrow: (id) => (id === "rd_n" ? new Error("vectorize query failed for rd_n: 503") : undefined),
    });
    const code = await corpusRefreshNeighboursCommand.run(["--tenant", "global"], deps);
    expect(code).toBe(1);
    expect(calls.queries.map((q) => q.id)).toEqual(["rd_r", "rd_n"]);
    expect(calls.reports).toHaveLength(1);
    const report = JSON.parse(calls.reports[0]!.body);
    expect(report.readings.map((r: { id: string }) => r.id)).toEqual(["rd_r"]);
    expect(lines.join("\n")).toMatch(/vectorize query failed for rd_n/);
    expect(lines.join("\n")).toMatch(/not measured — run incomplete/);
  });

  it("writes refresh-report.json even when the list flush fails, then exits 1", async () => {
    const { deps, calls, lines } = makeDeps({});
    deps.r2.mergeListRows = async () => {
      calls.indexWrites++;
      throw new Error("put index/list.json failed: 500");
    };
    const code = await corpusRefreshNeighboursCommand.run(
      ["--tenant", "global", "rd_r", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(1);
    expect(calls.puts).toHaveLength(1);
    expect(calls.indexWrites).toBe(1);
    expect(calls.reports).toHaveLength(1);
    expect(JSON.parse(calls.reports[0]!.body).readings[0].id).toBe("rd_r");
    expect(lines.join("\n")).toMatch(/index\/list\.json rewrite failed/);
  });
  describe("storage backend selection", () => {
    const CREDS = {
      CORPUS_R2_ACCOUNT_ID: "acct",
      CORPUS_R2_ACCESS_KEY: "AKIA",
      CORPUS_R2_SECRET_KEY: "secret",
      CORPUS_CF_API_TOKEN: "tok",
    };

    /** Marks whichever adapter a pass actually reads through. */
    function tracked(
      deps: CorpusRefreshNeighboursDeps,
      used: string[],
      label: string,
    ): CorpusRefreshNeighboursR2 {
      return {
        ...deps.r2,
        readListIndex: async (d) => {
          used.push(label);
          return deps.r2.readListIndex(d);
        },
      };
    }

    it("uses wrangler and says so when no credentials are present", async () => {
      const { deps, lines } = makeDeps({});
      const code = await corpusRefreshNeighboursCommand.run(["--tenant", "global"], deps);
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain(
        "Storage: wrangler — no CORPUS_R2_*/CLOUDFLARE_API_TOKEN credentials",
      );
    });

    it("auto-selects the direct path when credentials are present", async () => {
      const { deps, lines } = makeDeps({});
      const used: string[] = [];
      const direct = tracked(deps, used, "direct");
      const code = await corpusRefreshNeighboursCommand.run(["--tenant", "global"], {
        ...deps,
        r2: tracked(deps, used, "wrangler"),
        directR2: () => direct,
        storageVars: () => CREDS,
      });
      expect(code).toBe(0);
      expect(used).toEqual(["direct"]);
      expect(lines.join("\n")).toContain("Storage: direct (S3/REST) — CORPUS_R2_* keys");
    });

    it("--via wrangler forces the fallback even with credentials present", async () => {
      const { deps, lines } = makeDeps({});
      const used: string[] = [];
      const direct = tracked(deps, used, "direct");
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", "global", "--via", "wrangler"],
        { ...deps, r2: tracked(deps, used, "wrangler"), directR2: () => direct, storageVars: () => CREDS },
      );
      expect(code).toBe(0);
      expect(used).toEqual(["wrangler"]);
      expect(lines.join("\n")).toContain("Storage: wrangler — --via wrangler");
    });

    // The header must never name a path the pass did not take.
    it("reports the fallback it actually used when no direct client exists", async () => {
      const { deps, lines } = makeDeps({});
      const code = await corpusRefreshNeighboursCommand.run(["--tenant", "global"], {
        ...deps,
        storageVars: () => CREDS,
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain(
        "Storage: wrangler — CORPUS_R2_* keys, but no direct client available",
      );
    });

    it("rejects an unknown --via value as usage", async () => {
      const { deps } = makeDeps({});
      await expect(
        corpusRefreshNeighboursCommand.run(["--tenant", "global", "--via", "s3"], deps),
      ).rejects.toThrow(/--via "s3" is not one of/);
    });

    // Nothing but wrangler can reach the miniflare bucket, so the combination
    // is a contradiction rather than a silent preference.
    it("rejects --via direct with --local", async () => {
      const { deps } = makeDeps({});
      await expect(
        corpusRefreshNeighboursCommand.run(
          ["--tenant", "global", "--via", "direct", "--local"],
          deps,
        ),
      ).rejects.toThrow(/--via direct cannot be combined with --local/);
    });

    it("documents --via in help", async () => {
      expect(corpusRefreshNeighboursCommand.helpText).toContain("--via <path>");
    });
  });

  describe("incremental scope", () => {
    const MARKER: RefreshState = {
      version: 1,
      last_run_at: "2026-08-21T00:00:00.000Z",
      list_row_count: 2,
    };

    /** Both list rows unchanged since the marker, so nothing is in scope. */
    function quietCorpus() {
      return makeDeps({ state: MARKER });
    }

    it("measures everything by default, whatever the marker says", async () => {
      const { deps, calls, lines } = quietCorpus();
      const code = await corpusRefreshNeighboursCommand.run(["--tenant", "global"], deps);
      expect(code).toBe(0);
      // Read, but not scoped against: a full pass overwrites the marker, so it
      // needs the stored one to build the next from.
      expect(calls.stateReads).toBe(1);
      expect(calls.queries).toHaveLength(2);
      expect(lines.join("\n")).toContain("Scope: full — --full");
    });

    it("measures nothing when no reading has moved since the marker", async () => {
      const { deps, calls, lines } = quietCorpus();
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", "global", "--since-last-run"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.stateReads).toBe(1);
      expect(calls.queries).toEqual([]);
      const text = lines.join("\n");
      expect(text).toContain("Scope: incremental (0 reading(s))");
      expect(text).toContain("To measure: 0");
    });

    it("measures a changed reading and its reverse neighbourhood, asking for no metadata", async () => {
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
        ["--tenant", "global", "--since-last-run"],
        deps,
      );
      expect(code).toBe(0);
      const reverse = calls.queries.filter((q) => q.topK === REVERSE_TOP_K);
      expect(reverse).toEqual([
        { id: "rd_r", topK: REVERSE_TOP_K, namespace: undefined, metadata: false },
      ]);
      // The changed reading and the neighbour its vector reaches, both measured.
      const measured = calls.queries.filter((q) => q.topK !== REVERSE_TOP_K).map((q) => q.id);
      expect(measured.sort()).toEqual(["rd_n", "rd_r"]);
      expect(lines.join("\n")).toContain("Scope: incremental (2 reading(s))");
    });

    it("sweeps when the reverse query for a changed reading fails", async () => {
      const { deps, calls, lines } = makeDeps({
        state: MARKER,
        items: [{ ...READY, updated_at: "2026-08-21T12:00:00.000Z" }, NEIGHBOUR],
        queryThrow: (id) => (id === "rd_r" ? new Error("boom") : undefined),
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", "global", "--since-last-run"],
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
          ["--tenant", "global", "--since-last-run"],
          deps,
        );
        expect(code).toBe(0);
        expect(lines.join("\n")).toContain("Scope: full");
      }
    });

    it("sweeps when the corpus lost a row, which no timestamp can name", async () => {
      const { deps, lines } = makeDeps({
        state: { ...MARKER, list_row_count: 5 },
      });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", "global", "--since-last-run"],
        deps,
      );
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("Scope: full — 3 list row(s) removed since the last run");
    });

    it("records the scope in the report header", async () => {
      const { deps, calls } = quietCorpus();
      await corpusRefreshNeighboursCommand.run(["--tenant", "global", "--since-last-run"], deps);
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
    it("records --only and --limit in the report scope", async () => {
      const { deps, calls } = makeDeps({ state: MARKER });
      await corpusRefreshNeighboursCommand.run(
        ["--tenant", "global", "--limit", "1", "rd_r"],
        deps,
      );
      expect(JSON.parse(calls.reports[0]!.body).scope).toEqual({
        kind: "full",
        reason: "--full",
        narrowed_by: "--only (1 id(s)), --limit 1",
      });
    });

    it("advances the marker only on a complete execute pass", async () => {
      const { deps, calls } = quietCorpus();
      await corpusRefreshNeighboursCommand.run(["--tenant", "global", "--since-last-run"], deps);
      expect(calls.stateWrites).toEqual([]);

      const executed = quietCorpus();
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", "global", "--since-last-run", "--execute", "--sole-writer"],
        executed.deps,
      );
      expect(code).toBe(0);
      expect(executed.calls.stateWrites).toEqual([
        {
          version: 1,
          last_run_at: "2026-08-22T12:00:00.000Z",
          list_row_count: 2,
        },
      ]);
    });

    it("records a full sweep as the last full run", async () => {
      const { deps, calls } = makeDeps({ state: MARKER });
      await corpusRefreshNeighboursCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer"],
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
          ["--tenant", "global", "--execute", "--sole-writer", ...flags],
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
        ["--tenant", "global", "--execute", "--sole-writer", "--limit", "500"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.stateWrites).toHaveLength(1);
    });

    // A written marker is an optimisation, not corpus state: every snapshot the
    // pass owed R2 is already committed when it is attempted.
    it("does not fail a completed pass whose marker write failed", async () => {
      const { deps, lines } = makeDeps({ state: MARKER, stateWriteThrow: "no write" });
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer"],
        deps,
      );
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("run marker write failed: no write");
    });

    // The ETag this pass read is superseded by its own list flush, so recording
    // it would store a token no later read can match.
    it("stores the list ETag only when the pass did not rewrite the index", async () => {
      // One reading whose stored snapshot already matches the measurement, so
      // the pass writes nothing at all.
      const quiet = makeDeps({
        state: { ...MARKER, list_row_count: 1 },
        listEtag: "etag-1",
        items: [READY],
        matches: [{ id: "rd_r", score: 1 }],
      });
      await corpusRefreshNeighboursCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer"],
        quiet.deps,
      );
      expect(quiet.calls.indexWrites).toBe(0);
      expect(quiet.calls.stateWrites[0]).toMatchObject({ list_etag: "etag-1" });

      const flushed = makeDeps({
        state: MARKER,
        listEtag: "etag-1",
        items: [{ ...READY, similarity: undefined }, NEIGHBOUR],
      });
      await corpusRefreshNeighboursCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer"],
        flushed.deps,
      );
      expect(flushed.calls.indexWrites).toBe(1);
      expect(flushed.calls.stateWrites[0]).not.toHaveProperty("list_etag");
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
        ["--tenant", "global", "--since-last-run"],
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

    // The marker must never be newer than the list it describes, or a reading
    // activated between the two reads is invisible to every later pass.
    it("stamps the marker no later than the list it read", async () => {
      const { deps, calls } = quietCorpus();
      let listReadAt = 0;
      const clock = (() => {
        let value = Date.parse("2026-08-22T12:00:00Z");
        return () => (value += 1000);
      })();
      const code = await corpusRefreshNeighboursCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer"],
        {
          ...deps,
          now: clock,
          r2: {
            ...deps.r2,
            readListIndex: async (d) => {
              listReadAt = clock();
              return deps.r2.readListIndex(d);
            },
          },
        },
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
        ["--tenant", "global", "--since-last-run", "rd_r"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.queries).toEqual([
        { id: "rd_r", topK: SIMILAR_TOP_K + 1, namespace: undefined },
      ]);
      expect(lines.join("\n")).toContain("Scope: full — --only names 1 reading(s)");
    });

    // A reading the planner brings into scope is not merely flagged for tier 2:
    // it is measured like any other target, so its stored similarity snapshot
    // and its list row are brought current in the same pass.
    it("rewrites the snapshot and list row of a reading pulled in by a reverse query", async () => {
      const { deps, calls } = makeDeps({
        state: MARKER,
        // Only rd_r changed. rd_n is the stranger its vector reaches, and its
        // list row carries a stale snapshot.
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
        ["--tenant", "global", "--since-last-run", "--execute", "--sole-writer"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.puts.map((p) => p.key).sort()).toEqual(["readings/rd_n", "readings/rd_r"]);
      expect(calls.indexWrites).toBe(1);
    });

    it("rejects --since-last-run together with --full", async () => {
      const { deps } = makeDeps({});
      await expect(
        corpusRefreshNeighboursCommand.run(
          ["--tenant", "global", "--since-last-run", "--full"],
          deps,
        ),
      ).rejects.toThrow(/--since-last-run cannot be combined with --full/);
    });

    it("documents both scope flags in help", () => {
      expect(corpusRefreshNeighboursCommand.helpText).toContain("--since-last-run");
      expect(corpusRefreshNeighboursCommand.helpText).toContain("--full ");
    });
  });
});
