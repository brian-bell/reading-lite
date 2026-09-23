// Blackbox cases for the three corpus refresh passes (reading-lite-gh347.4.1).
// Each one seeds real rows, runs the real command through its real store, and
// asserts on what is left in the database.
//
// Persistence behavior belongs here. Command unit tests retain scheduling,
// retry and fail-closed guards; their stores do not simulate version checks.
// These cases exercise the real openStore mapping and SQL, with paid providers
// and the spend authority substituted. One CLI case also writes and consumes a
// real report file. Row-lock contention keeps its separate integration owner:
// this harness substitutes savepoints inside a rolled-back test transaction.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  corpusRefreshNeighboursCommand,
  openStore as openNeighboursStore,
  type CorpusRefreshNeighboursDeps,
} from "../../../scripts/ops-lib/commands/corpus-refresh-neighbours";
import {
  corpusRefreshConnectionsCommand,
  openStore as openJudgementStore,
  type CorpusRefreshConnectionsDeps,
} from "../../../scripts/ops-lib/commands/corpus-refresh-connections";
import {
  corpusRefreshTensionsCommand,
  type CorpusRefreshTensionsDeps,
} from "../../../scripts/ops-lib/commands/corpus-refresh-tensions";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../../scripts/ops-lib/cli";
import { operatorReadings } from "../../../scripts/pg-lib/operator-corpus";
import { SIMILARITY_FLOOR } from "../../../src/modules/stores/similarity";
import type { Sql } from "../../../src/modules/db/sql";
import type { TenantContext } from "../../../src/control-plane/ids";
import { BILLING_TENANT, spendHarness } from "../../helpers/operator-spend";
import {
  captureIo,
  keyPrefixFor,
  operatorSession,
  seedReading,
  seedTenant,
  unitVector,
  useCorpusDatabase,
  OPERATOR_ENV,
} from "../../helpers/ops-corpus-e2e";

const sqlFor = useCorpusDatabase();
const NOW = "2026-06-02T00:00:00.000Z";
const REPORT_AT = "2026-06-01T00:00:00.000Z";
const SEEDED_AT = "2026-01-01T00:00:00.000Z";

let sql: Sql;
let tenant: TenantContext;
beforeEach(async () => {
  sql = sqlFor();
  tenant = await seedTenant(sql);
});

/** A vector a fixed angle from `unitVector`, so the pair scores above the floor. */
function leaningVector(lean: number): number[] {
  const vector = new Array(unitVector().length).fill(0);
  vector[0] = 1;
  vector[1] = lean;
  return vector;
}

const tenantArg = () => ["--tenant", String(tenant.tenantId)];

async function row(id: string): Promise<Record<string, unknown>> {
  const [found] = await sql.query(
    "SELECT similarity, updated_at, novelty_verdict, tldr FROM readings WHERE tenant_id = $1 AND id = $2",
    [String(tenant.tenantId), id],
  );
  return found!;
}

async function relationships(sourceId: string): Promise<{ kind: string; target_id: string }[]> {
  return sql.query<{ kind: string; target_id: string }>(
    `SELECT kind, target_id FROM reading_relationships
     WHERE tenant_id = $1 AND source_id = $2 ORDER BY kind, target_id`,
    [String(tenant.tenantId), sourceId],
  );
}

async function revisionFlags(readingId: string): Promise<Record<string, unknown>> {
  const [found] = await sql.query(
    `SELECT v.connections_present, v.tensions_present, v.connections_computed_at,
            v.connections_neighbourhood_ids, v.tensions_judged
     FROM reading_revisions v
     JOIN readings r ON (r.tenant_id, r.id) = (v.tenant_id, v.reading_id)
                    AND r.current_revision_id = v.id
     WHERE v.tenant_id = $1 AND v.reading_id = $2`,
    [String(tenant.tenantId), readingId],
  );
  return found!;
}

/** The two ready, embedded readings every pass below measures or judges. */
async function seedPair(): Promise<void> {
  await seedReading(sql, tenant, "rd_a", { embedding: unitVector(), keywords: ["one", "two", "three"] });
  await seedReading(sql, tenant, "rd_b", { embedding: leaningVector(0.2), keywords: ["one", "two", "three"] });
}

function neighboursDeps(): { deps: CorpusRefreshNeighboursDeps; io: ReturnType<typeof captureIo>; reports: string[] } {
  const io = captureIo();
  const session = operatorSession(() => sql);
  const reports: string[] = [];
  return {
    io,
    reports,
    deps: {
      io: io.io,
      withStore: openNeighboursStore(session.openSql, { ...OPERATOR_ENV }),
      now: () => Date.parse(NOW),
      mkdir: async () => {},
      writeFile: async (_path, body) => {
        reports.push(body);
      },
    },
  };
}

describe("ops corpus refresh-neighbours, against the database", () => {
  it("writes the measured snapshot to readings.similarity and nothing else", async () => {
    await seedPair();
    const h = neighboursDeps();

    expect(await corpusRefreshNeighboursCommand.run(
      [...tenantArg(), "--full", "--execute", "--sole-writer"], h.deps,
    )).toBe(0);

    const measured = await row("rd_a");
    expect(measured.similarity).toMatchObject({ count: 1, computed_at: NOW });
    // Not `updated_at`: no content changed, and bumping it would put the
    // reading back in the next incremental scope every night.
    expect(measured.updated_at).toBe(SEEDED_AT);
    expect(measured.novelty_verdict).toBeNull();
  });

  it("stores its run marker as a row the next pass scopes against", async () => {
    await seedPair();

    expect(await corpusRefreshNeighboursCommand.run(
      [...tenantArg(), "--full", "--execute", "--sole-writer"], neighboursDeps().deps,
    )).toBe(0);
    const [marker] = await sql.query<{ state: { version: number; list_ids: string[] } }>(
      "SELECT state FROM corpus_refresh_state WHERE tenant_id = $1",
      [String(tenant.tenantId)],
    );
    expect(marker!.state).toMatchObject({ list_ids: ["rd_a", "rd_b"], last_full_run_at: NOW });

    // The second pass reads that row back and finds nothing has moved since.
    const quiet = neighboursDeps();
    expect(await corpusRefreshNeighboursCommand.run(
      [...tenantArg(), "--since-last-run", "--execute", "--sole-writer"], quiet.deps,
    )).toBe(0);
    expect(quiet.io.out.join("\n")).toContain("Scope: incremental (0 reading(s))");
  });

  it("reports a ready reading that owns no vector, and exits 3", async () => {
    await seedPair();
    await seedReading(sql, tenant, "rd_bare");

    const h = neighboursDeps();
    expect(await corpusRefreshNeighboursCommand.run(
      [...tenantArg(), "--full", "--execute", "--sole-writer"], h.deps,
    )).toBe(3);
    expect(h.io.err.join("\n")).toContain("no vector stored for rd_bare");
  });
});

/** The tier-1 report both judgement passes consume, naming rd_a's neighbour. */
function report(): string {
  return JSON.stringify({
    version: 1,
    generated_at: REPORT_AT,
    tenant: String(tenant.tenantId),
    floor: SIMILARITY_FLOOR,
    readings: [
      {
        id: "rd_a",
        key_prefix: keyPrefixFor("rd_a"),
        url: "https://example.com/rd_a",
        reasons: ["new_neighbour"],
        connections: [],
        current_neighbours: [
          {
            id: "rd_b",
            score: 0.9,
            title: "Title rd_b",
            tldr: "Tldr rd_b",
            created_at: SEEDED_AT,
          },
        ],
      },
    ],
  });
}

/** Runs between planning and publication, allowing a deterministic concurrent edit. */
function connectionsDeps(beforeJudging: () => Promise<void> = async () => {}): {
  deps: CorpusRefreshConnectionsDeps;
  io: ReturnType<typeof captureIo>;
} {
  const io = captureIo();
  const session = operatorSession(() => sql);
  const spend = spendHarness();
  return {
    io,
    deps: {
      io: io.io,
      readReport: async () => report(),
      withStore: openJudgementStore(session.openSql, { ...OPERATOR_ENV }),
      loadProvider: async () => ({
        provider: "openai",
        model: "gpt-5.6-terra",
        effort: "high",
        estimate: () => ({ inputTokens: 500, outputTokens: 256, costUsd: 0.005 }),
        judge: async () => {
          await beforeJudging();
          return {
            judgement: {
              novelty_verdict: "familiar" as const,
              connections: [{ id: "rd_b", reason: "both measure the same thing" }],
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
          };
        },
      }),
      openSpend: spend.openSpend,
      fetch: spend.fetch,
      now: () => Date.parse(NOW),
      sleep: async () => {},
    },
  };
}

describe("ops corpus refresh-connections, against the database", () => {
  // The rows and the revision flags are one write. A set stored without its
  // flag reads back as never computed, which is the whole reason the writer
  // does both in one transaction.
  it("writes the judged connections, the flags and the verdict together", async () => {
    await seedPair();
    const h = connectionsDeps();

    expect(await corpusRefreshConnectionsCommand.run(
      [...tenantArg(), "--billing-tenant", BILLING_TENANT, "--execute", "--sole-writer"], h.deps,
    )).toBe(0);

    expect(await relationships("rd_a")).toEqual([{ kind: "connection", target_id: "rd_b" }]);
    expect(await revisionFlags("rd_a")).toMatchObject({
      connections_present: true,
      connections_computed_at: NOW,
      connections_neighbourhood_ids: ["rd_b"],
    });
    expect((await row("rd_a")).novelty_verdict).toBe("familiar");
  });

  // The judgement raced a delete. `reading_relationships` keys the source only,
  // so the schema would accept the row; the write drops it instead.
  it("drops a connection whose target was deleted, and says so", async () => {
    await seedPair();
    // Deleted while the judgement is in flight: the one window in which a
    // refresh can name a target that is gone by the time it writes.
    const h = connectionsDeps(async () => {
      await sql.execute("DELETE FROM readings WHERE tenant_id = $1 AND id = $2", [
        String(tenant.tenantId),
        "rd_b",
      ]);
    });

    expect(await corpusRefreshConnectionsCommand.run(
      [...tenantArg(), "--billing-tenant", BILLING_TENANT, "--execute", "--sole-writer"], h.deps,
    )).toBe(0);
    expect(await relationships("rd_a")).toEqual([]);
    expect(h.io.err.join("\n")).toContain(
      "rd_a: skipped connection target rd_b: no longer exists",
    );
    expect(h.io.all()).toContain("targets skipped as missing: 1");
    // Still judged: the flags say an empty set was computed, not that none was.
    expect(await revisionFlags("rd_a")).toMatchObject({ connections_present: true });
  });
});

function tensionsDeps(): { deps: CorpusRefreshTensionsDeps; io: ReturnType<typeof captureIo> } {
  const io = captureIo();
  const session = operatorSession(() => sql);
  const spend = spendHarness();
  return {
    io,
    deps: {
      io: io.io,
      readReport: async () => report(),
      withStore: openJudgementStore(session.openSql, { ...OPERATOR_ENV }),
      loadProvider: async () => ({
        provider: "openai",
        model: "gpt-5.6-terra",
        effort: "high",
        estimate: () => ({ inputTokens: 900, outputTokens: 128, costUsd: 0.004 }),
        judge: async () => ({
          judgement: {
            verdict: "supersedes" as const,
            side: "b" as const,
            reason: "rd_b retracts rd_a",
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
        }),
      }),
      openSpend: spend.openSpend,
      fetch: spend.fetch,
      now: () => Date.parse(NOW),
      sleep: async () => {},
    },
  };
}

describe("ops corpus refresh-tensions, against the database", () => {
  // One transaction over both readings: the corpus never holds a tension one
  // side cites and the other has never heard of.
  it("writes both sides of a judged pair", async () => {
    await seedPair();
    const h = tensionsDeps();

    expect(await corpusRefreshTensionsCommand.run(
      [...tenantArg(), "--billing-tenant", BILLING_TENANT, "--pair", "rd_a,rd_b", "--execute", "--sole-writer"],
      h.deps,
    )).toBe(0);

    expect(await relationships("rd_a")).toEqual([{ kind: "tension", target_id: "rd_b" }]);
    expect(await relationships("rd_b")).toEqual([{ kind: "tension", target_id: "rd_a" }]);
    expect(await revisionFlags("rd_a")).toMatchObject({ tensions_present: true });
    expect(await revisionFlags("rd_b")).toMatchObject({ tensions_present: true });
    // Tensions touch nothing else.
    expect((await row("rd_a")).updated_at).toBe(SEEDED_AT);
  });
});

const execute = () => [...tenantArg(), "--billing-tenant", BILLING_TENANT, "--execute", "--sole-writer"];

async function manifest(id: string, owner = tenant) {
  return (await operatorReadings(sql, owner).loadReadingById(id))!.manifest;
}

async function snapshot(owner = tenant) {
  const readings = await sql.query<{ id: string }>(
    "SELECT id FROM readings WHERE tenant_id = $1 ORDER BY id", [String(owner.tenantId)],
  );
  return Promise.all(readings.map(({ id }) => manifest(id, owner)));
}

// Spy only at the paid boundary. The command, version checks and storage stay real.
async function providerSpy(h: { deps: CorpusRefreshConnectionsDeps | CorpusRefreshTensionsDeps }) {
  const provider = await h.deps.loadProvider(true);
  const judge = vi.fn(provider.judge);
  // Both command provider contracts have the same wrapper; keep the union's
  // correlated input/output types when handing it back to its original command.
  h.deps.loadProvider = (async () => ({ ...provider, judge })) as typeof h.deps.loadProvider;
  return judge;
}

describe("refresh commands through their persisted state", () => {
  it.each(["neighbours", "connections", "tensions"] as const)(
    "%s plans through the CLI without changing either tenant", async (pass) => {
      await seedPair();
      const other = await seedTenant(sql);
      await seedReading(sql, other, "rd_a", { embedding: unitVector() });
      const before = await snapshot();
      const otherBefore = await snapshot(other);
      const h = pass === "neighbours" ? neighboursDeps() : pass === "connections" ? connectionsDeps() : tensionsDeps();
      const judge = pass === "neighbours" ? null : await providerSpy(h as ReturnType<typeof connectionsDeps>);
      expect(await runCli(["corpus", `refresh-${pass}`, ...tenantArg()], {
        io: h.io.io, depsFor: () => h.deps,
      })).toBe(0);
      expect(await snapshot()).toEqual(before);
      expect(await snapshot(other)).toEqual(otherBefore);
      if (judge) expect(judge).not.toHaveBeenCalled();
      expect(await sql.query("SELECT * FROM corpus_refresh_state WHERE tenant_id = $1", [String(tenant.tenantId)])).toEqual([]);
    },
  );

  it("writes a real report through CLI arguments and consumes it in both judgement passes", async () => {
    await seedPair();
    const dir = await mkdtemp(join(tmpdir(), "refresh-report-"));
    const path = join(dir, "report.json");
    try {
      const n = neighboursDeps();
      n.deps.mkdir = async (path) => { await mkdir(path, { recursive: true }); };
      n.deps.writeFile = async (path, body) => { await writeFile(path, body); };
      expect(await runCli(["corpus", "refresh-neighbours", ...tenantArg(), "--full", "--out", path], {
        io: n.io.io, depsFor: () => n.deps,
      })).toBe(0);
      const report = JSON.parse(await readFile(path, "utf8"));
      expect(report).toMatchObject({ version: 1, tenant: String(tenant.tenantId) });
      expect(report.readings.map((r: { id: string }) => r.id).sort()).toEqual(["rd_a", "rd_b"]);
      for (const [name, h] of [["connections", connectionsDeps()], ["tensions", tensionsDeps()]] as const) {
        h.deps.readReport = async (file) => readFile(file, "utf8");
        expect(await runCli(["corpus", `refresh-${name}`, ...execute(), "--report", path], {
          io: h.io.io, depsFor: () => h.deps,
        })).toBe(0);
      }
      expect((await manifest("rd_a")).connections).toHaveLength(1);
      expect((await manifest("rd_a")).tensions).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reruns a full neighbour pass without rewriting matching snapshots or another tenant", async () => {
    await seedPair();
    const other = await seedTenant(sql);
    await seedReading(sql, other, "rd_a", { embedding: unitVector() });
    const otherBefore = await snapshot(other);
    const args = [...tenantArg(), "--full", "--execute", "--sole-writer"];
    expect(await corpusRefreshNeighboursCommand.run(args, neighboursDeps().deps)).toBe(0);
    const before = await snapshot();
    const h = neighboursDeps();
    h.deps.now = () => Date.parse(NOW) + 60_000;
    expect(await corpusRefreshNeighboursCommand.run(args, h.deps)).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(await snapshot(other)).toEqual(otherBefore);
    expect(h.io.all()).toContain("snapshots written: 0");
  });

  it("limits connections, resumes the remaining reading, then skips paid work on rerun", async () => {
    await seedPair();
    await seedReading(sql, tenant, "rd_c", { keywords: ["one", "two", "three"] });
    const other = await seedTenant(sql);
    await seedReading(sql, other, "rd_a");
    const otherBefore = await snapshot(other);
    const h = connectionsDeps();
    const data = JSON.parse(report());
    data.readings.push({ ...data.readings[0], id: "rd_c", key_prefix: keyPrefixFor("rd_c"), url: "https://example.com/rd_c" });
    h.deps.readReport = async () => JSON.stringify(data);
    const judge = await providerSpy(h);
    expect(await corpusRefreshConnectionsCommand.run([...execute(), "--limit", "1"], h.deps)).toBe(0);
    expect((await manifest("rd_a")).connections).toHaveLength(1);
    expect((await revisionFlags("rd_c")).connections_computed_at).toBeNull();
    expect(judge).toHaveBeenCalledTimes(1);
    expect(await corpusRefreshConnectionsCommand.run(execute(), h.deps)).toBe(0);
    expect((await manifest("rd_c")).connections).toHaveLength(1);
    expect(judge).toHaveBeenCalledTimes(2);
    const before = await snapshot();
    judge.mockClear();
    expect(await corpusRefreshConnectionsCommand.run(execute(), h.deps)).toBe(0);
    expect(judge).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(await snapshot(other)).toEqual(otherBefore);
  });

  it.each(["connections", "tensions"] as const)("%s rejects a changed reading and still accounts for the judgement", async (pass) => {
    await seedPair();
    const h = pass === "connections" ? connectionsDeps() : tensionsDeps();
    if (pass === "connections") {
      await seedReading(sql, tenant, "rd_c", { keywords: ["one", "two", "three"] });
      const data = JSON.parse(report());
      data.readings.push({ ...data.readings[0], id: "rd_c", key_prefix: keyPrefixFor("rd_c"), url: "https://example.com/rd_c" });
      h.deps.readReport = async () => JSON.stringify(data);
    }
    const provider = await h.deps.loadProvider(true);
    const judge = vi.fn(async (input: never) => {
      await sql.execute("UPDATE readings SET tldr = 'concurrent edit' WHERE tenant_id = $1 AND id = 'rd_a'", [String(tenant.tenantId)]);
      return provider.judge(input);
    });
    h.deps.loadProvider = (async () => ({ ...provider, judge })) as typeof h.deps.loadProvider;
    const beforeB = await manifest("rd_b");
    const command = pass === "connections" ? corpusRefreshConnectionsCommand : corpusRefreshTensionsCommand;
    expect(await command.run(execute(), h.deps as never)).toBe(1);
    expect(judge).toHaveBeenCalledTimes(pass === "connections" ? 2 : 1);
    expect((await row("rd_a")).tldr).toBe("concurrent edit");
    expect(await relationships("rd_a")).toEqual([]);
    expect(await manifest("rd_b")).toEqual(beforeB);
    expect((await revisionFlags("rd_a")).connections_computed_at).toBeNull();
    expect(h.io.err.join("\n")).toContain("changed since it was planned");
    if (pass === "connections") {
      expect((await manifest("rd_c")).connections).toHaveLength(1);
      expect(h.io.all()).toContain("Judged: 1; failures: 1");
      expect(h.io.all()).toContain("Usage: 2 judgements; input=200 output=40 reasoning=0");
    } else {
      expect(h.io.all()).toContain("Usage: 1 judgement; input=100 output=20 reasoning=0");
    }
  });

  it("preserves both overlapping tension pairs and skips them on rerun", async () => {
    await seedPair();
    await seedReading(sql, tenant, "rd_c", { keywords: ["one", "two", "three"] });
    const other = await seedTenant(sql);
    await seedReading(sql, other, "rd_a");
    const otherBefore = await snapshot(other);
    const h = tensionsDeps();
    const data = JSON.parse(report());
    data.readings[0].current_neighbours.push({ ...data.readings[0].current_neighbours[0], id: "rd_c" });
    h.deps.readReport = async () => JSON.stringify(data);
    const judge = await providerSpy(h);
    expect(await corpusRefreshTensionsCommand.run(execute(), h.deps)).toBe(0);
    expect((await manifest("rd_a")).tensions?.map((t) => t.id).sort()).toEqual(["rd_b", "rd_c"]);
    for (const id of ["rd_b", "rd_c"]) {
      expect((await manifest(id)).tensions).toMatchObject([{ id: "rd_a", kind: "supersedes" }]);
    }
    expect(judge).toHaveBeenCalledTimes(2);
    const before = await snapshot();
    judge.mockClear();
    expect(await corpusRefreshTensionsCommand.run(execute(), h.deps)).toBe(0);
    expect(judge).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(await snapshot(other)).toEqual(otherBefore);
  });

  it("removes both prior tensions on a none verdict and persists both judgement records", async () => {
    await seedPair();
    const h = tensionsDeps();
    const args = [...execute(), "--pair", "rd_b,rd_a"];
    expect(await corpusRefreshTensionsCommand.run(args, h.deps)).toBe(0);
    expect((await manifest("rd_a")).tensions).toMatchObject([{ id: "rd_b", kind: "superseded_by" }]);
    const provider = await h.deps.loadProvider(true);
    h.deps.loadProvider = async () => ({ ...provider, judge: async (input) => ({
      ...(await provider.judge(input)), judgement: { verdict: "none", side: null, reason: "" },
    }) });
    expect(await corpusRefreshTensionsCommand.run(args, h.deps)).toBe(0);
    for (const [id, partner] of [["rd_a", "rd_b"], ["rd_b", "rd_a"]]) {
      const saved = await manifest(id!);
      expect(saved.tensions).toEqual([]);
      expect(saved.tensions_judged).toEqual([{ id: partner, judged_at: NOW }]);
      expect(saved.updated_at).toBe(SEEDED_AT);
    }
  });

  it("repairs a legacy one-sided tension without another judgement", async () => {
    await seedPair();
    const h = tensionsDeps();
    expect(await corpusRefreshTensionsCommand.run(execute(), h.deps)).toBe(0);
    await sql.execute("DELETE FROM reading_relationships WHERE tenant_id = $1 AND source_id = 'rd_b'", [String(tenant.tenantId)]);
    await sql.execute("UPDATE reading_revisions SET tensions_present = false, tensions_judged = NULL WHERE tenant_id = $1 AND reading_id = 'rd_b'", [String(tenant.tenantId)]);
    const judge = await providerSpy(h);
    expect(await corpusRefreshTensionsCommand.run(execute(), h.deps)).toBe(0);
    expect(judge).not.toHaveBeenCalled();
    expect((await manifest("rd_b")).tensions).toMatchObject([{ id: "rd_a", kind: "supersedes" }]);
    expect((await manifest("rd_b")).tensions_judged).toEqual([{ id: "rd_a", judged_at: NOW }]);
  });
});
