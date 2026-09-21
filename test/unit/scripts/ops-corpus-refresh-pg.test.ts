// Blackbox cases for the three corpus refresh passes (reading-lite-gh347.4.1).
// Each one seeds real rows, runs the real command through its real store, and
// asserts on what is left in the database.
//
// This is the layer the command tests cannot reach. They inject a fake store
// so they can drive the scope rules, the rate-limit ceiling and the exit-code
// contract without a database, which leaves `openStore` — the mapping from
// `listItems` / `readManifest` / `setSimilarity` / `replaceRelationships` onto
// actual SQL — executed by nothing. Everything here runs that mapping.
//
// What stays faked is what is external and paid: the provider, the spend
// authority and the report file. The storage is real, which is the point.
import { beforeEach, describe, expect, it } from "vitest";
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
import { SIMILARITY_FLOOR } from "../../../src/modules/stores/similarity-store";
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
    "SELECT similarity, updated_at, novelty_verdict FROM readings WHERE tenant_id = $1 AND id = $2",
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
            v.connections_neighbourhood_ids
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

describe("ops corpus refresh-neighbours, against the database", () => {
  function deps(): { deps: CorpusRefreshNeighboursDeps; io: ReturnType<typeof captureIo>; reports: string[] } {
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

  it("writes the measured snapshot to readings.similarity and nothing else", async () => {
    await seedPair();
    const h = deps();

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
      [...tenantArg(), "--full", "--execute", "--sole-writer"], deps().deps,
    )).toBe(0);
    const [marker] = await sql.query<{ state: { version: number; list_ids: string[] } }>(
      "SELECT state FROM corpus_refresh_state WHERE tenant_id = $1",
      [String(tenant.tenantId)],
    );
    expect(marker!.state).toMatchObject({ list_ids: ["rd_a", "rd_b"], last_full_run_at: NOW });

    // The second pass reads that row back and finds nothing has moved since.
    const quiet = deps();
    expect(await corpusRefreshNeighboursCommand.run(
      [...tenantArg(), "--since-last-run", "--execute", "--sole-writer"], quiet.deps,
    )).toBe(0);
    expect(quiet.io.out.join("\n")).toContain("Scope: incremental (0 reading(s))");
  });

  it("reports a ready reading that owns no vector, and exits 3", async () => {
    await seedPair();
    await seedReading(sql, tenant, "rd_bare");

    const h = deps();
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

describe("ops corpus refresh-connections, against the database", () => {
  /** `beforeJudging` runs between planning and the write, as a real race would. */
  function deps(beforeJudging: () => Promise<void> = async () => {}): {
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

  // The rows and the revision flags are one write. A set stored without its
  // flag reads back as never computed, which is the whole reason the writer
  // does both in one transaction.
  it("writes the judged connections, the flags and the verdict together", async () => {
    await seedPair();
    const h = deps();

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
    const h = deps(async () => {
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
    // Still judged: the flags say an empty set was computed, not that none was.
    expect(await revisionFlags("rd_a")).toMatchObject({ connections_present: true });
  });
});

describe("ops corpus refresh-tensions, against the database", () => {
  function deps(): { deps: CorpusRefreshTensionsDeps; io: ReturnType<typeof captureIo> } {
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

  // One transaction over both readings: the corpus never holds a tension one
  // side cites and the other has never heard of.
  it("writes both sides of a judged pair", async () => {
    await seedPair();
    const h = deps();

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
