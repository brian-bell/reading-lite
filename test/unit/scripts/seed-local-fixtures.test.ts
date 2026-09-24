import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replaceTenantReadings, runSeed } from "../../../scripts/seed-local-fixtures";
import { sqlFromConnectionString, type Sql } from "../../../src/modules/db/sql";
import { manifestToRows, writeReadingRows, type ReadingRows } from "../../../scripts/pg-lib/manifest-rows";
import type { Manifest, ProcessingAttempt } from "../../../src/schemas/manifest";
import { testDatabaseUrl } from "../../helpers/test-database";
import { buildLocalSeed, type LocalSeedObject, type LocalSeedPlan } from "../../fixtures/local-seed";

const NOW = "2026-09-11T10:00:00.000Z";

interface DepsOptions {
  failingKeys?: Set<string>;
  flakyKeys?: Set<string>;
  postgresError?: string;
  /** How many vectors the PostgreSQL seed reads back; defaults to one per ready fixture. */
  embeddings?: number;
}

function makeDeps(opts: DepsOptions = {}) {
  const puts: LocalSeedObject[] = [];
  const postgresPlans: LocalSeedPlan[] = [];
  const putsBeforePostgres: number[] = [];
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
      log: (line: string) => {
        logs.push(line);
      },
      nowIso: () => NOW,
      sleep: async () => {},
      seedPostgres: async (plan: LocalSeedPlan) => {
        postgresPlans.push(plan);
        putsBeforePostgres.push(puts.length);
        if (opts.postgresError) throw new Error(opts.postgresError);
        const ready = plan.fixtures.filter((f) => f.manifest.status === "ready").length;
        return {
          tenantId: "usr_local",
          readings: plan.fixtures.length,
          attempts: plan.fixtures.reduce((n, f) => n + f.attempts.length, 0),
          embeddings: opts.embeddings ?? ready,
        };
      },
    },
    postgresPlans,
    putsBeforePostgres,
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

describe("seed-local-fixtures runSeed", () => {
  it("puts the plan's content, then seeds PostgreSQL with the same plan", async () => {
    const { deps, puts, postgresPlans, putsBeforePostgres, logs, restoreWarn } = makeDeps();
    try {
      expect(await runSeed(deps)).toBe(0);
      expect(postgresPlans).toHaveLength(1);
      expect(puts).toEqual(postgresPlans[0]!.objects);
      // Content before the rows that point at it.
      expect(putsBeforePostgres).toEqual([puts.length]);
      expect(puts.map((o) => o.key).filter((key) => !/\/(raw\.[a-z]+|extracted\.md)$/.test(key))).toEqual([]);
      expect(logs.some((l) => l.startsWith("Seeded PostgreSQL:"))).toBe(true);
      expect(logs.some((l) => l.includes("Pending reading id"))).toBe(true);
    } finally {
      restoreWarn();
    }
  });

  it("fails the run when the PostgreSQL seed fails", async () => {
    const { deps, errors, restoreWarn } = makeDeps({ postgresError: "connection refused" });
    try {
      expect(await runSeed(deps)).toBe(1);
      expect(errors.join("\n")).toContain("PostgreSQL seed failed: connection refused");
    } finally {
      restoreWarn();
    }
  });

  it("fails verification when PostgreSQL holds no vector for a ready fixture", async () => {
    const { deps, errors, restoreWarn } = makeDeps({ embeddings: 0 });
    try {
      expect(await runSeed(deps)).toBe(1);
      expect(errors.join("\n")).toContain("verification failed");
    } finally {
      restoreWarn();
    }
  });

  it("retries a flaky put within the attempt budget and still succeeds", async () => {
    const key = buildLocalSeed(NOW).objects[0]!.key;
    const { deps, attemptsByKey, restoreWarn } = makeDeps({ flakyKeys: new Set([key]) });
    try {
      expect(await runSeed(deps)).toBe(0);
      expect(attemptsByKey.get(key)).toBe(3);
    } finally {
      restoreWarn();
    }
  });

  it("returns failure, without seeding PostgreSQL, when a put never succeeds", async () => {
    const key = buildLocalSeed(NOW).objects[0]!.key;
    const { deps, postgresPlans, restoreWarn } = makeDeps({ failingKeys: new Set([key]) });
    try {
      expect(await runSeed(deps)).toBe(1);
      expect(postgresPlans).toEqual([]);
    } finally {
      restoreWarn();
    }
  });
});

function failedRows(tenantId: string, id: string): ReadingRows {
  const manifest = {
    id,
    url: `https://example.com/${id}`,
    url_hash: Buffer.from(id).toString("hex").padEnd(64, "0").slice(0, 64),
    status: "failed",
    content_type: "text/html",
    content_status: "failed",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
  } satisfies Manifest;
  return manifestToRows(manifest, { tenantId, keyPrefix: `readings/${id}`, ownsUrl: false });
}

describe("seed-local-fixtures replaceTenantReadings", () => {
  let sql: Sql;
  beforeAll(() => {
    sql = sqlFromConnectionString(testDatabaseUrl());
  });
  afterAll(() => sql.end());

  it("clears leftover tenant rows and refresh jobs before inserting the fixture set and its attempts", async () => {
    const tenant = `usr_seed_${crypto.randomUUID()}`;
    const other = `usr_seed_${crypto.randomUUID()}`;
    // This connection commits outside the node pool's per-test rollback, so the
    // rows are removed at the end; left behind, they break any test that
    // counts users in the shared database.
    try {
      for (const id of [tenant, other]) {
        await sql.query(
          `INSERT INTO users (id, email_canonical, email_display, status, created_at, updated_at)
           VALUES ($1, $2, $2, 'active', now(), now())`,
          [id, `${id}@test.example`],
        );
      }
      const refreshJob = (tenantId: string, readingId: string) =>
        sql.query(
          `INSERT INTO relationship_refresh_jobs (tenant_id, reading_id, run_at, owner, source_etag)
           VALUES ($1, $2, now(), 'owner', 'etag')`,
          [tenantId, readingId],
        );
      const leftover = failedRows(tenant, "rd_leftover01");
      const retired = failedRows(tenant, "rd_retired01");
      const fixture = failedRows(tenant, "rd_fixture01");
      const neighbour = failedRows(other, "rd_neighbour1");

      await sql.transaction(async (tx) => {
        await writeReadingRows(tx, leftover);
        await writeReadingRows(tx, retired);
        await writeReadingRows(tx, neighbour);
      });
      // Refresh jobs reference only the tenant, so they do not cascade with a reading.
      await refreshJob(tenant, "rd_leftover01");
      await refreshJob(other, "rd_neighbour1");
      const attempt: ProcessingAttempt = {
        id: "at_fixture01",
        reading_id: "rd_fixture01",
        url: "https://example.com/rd_fixture01",
        url_hash: fixture.reading.url_hash,
        key_prefix: "readings/rd_fixture01",
        trigger: "submit",
        status: "failed",
        stage: "fetch_source",
        started_at: "2026-09-19T00:00:00.000Z",
        finished_at: "2026-09-19T00:00:01.000Z",
        error: { code: "BadStatusError", message: "404", stage: "fetch_source", retryable: false, failed_at: "2026-09-19T00:00:01.000Z" },
        events: [{ stage: "fetch_source", status: "failed", at: "2026-09-19T00:00:01.000Z" }],
      };
      await sql.transaction((tx) => replaceTenantReadings(tx, tenant, [fixture], [attempt]));

      const remaining = await sql.query<{ tenant_id: string; id: string }>(
        "SELECT tenant_id, id FROM readings WHERE tenant_id IN ($1, $2) ORDER BY id",
        [tenant, other],
      );
      expect(remaining.filter((row) => row.tenant_id === tenant)).toEqual([{ tenant_id: tenant, id: "rd_fixture01" }]);
      expect(remaining.filter((row) => row.tenant_id === other)).toEqual([{ tenant_id: other, id: "rd_neighbour1" }]);
      const attempts = await sql.query<{ reading_id: string; id: string; status: string; events: unknown }>(
        "SELECT reading_id, id, status, events FROM reading_attempts WHERE tenant_id = $1",
        [tenant],
      );
      expect(attempts).toEqual([{ reading_id: "rd_fixture01", id: "at_fixture01", status: "failed", events: attempt.events }]);
      const jobs = await sql.query<{ tenant_id: string; reading_id: string }>(
        "SELECT tenant_id, reading_id FROM relationship_refresh_jobs WHERE tenant_id IN ($1, $2)",
        [tenant, other],
      );
      expect(jobs).toEqual([{ tenant_id: other, reading_id: "rd_neighbour1" }]);
    } finally {
      await sql.query("DELETE FROM relationship_refresh_jobs WHERE tenant_id IN ($1, $2)", [tenant, other]);
      await sql.query("DELETE FROM readings WHERE tenant_id IN ($1, $2)", [tenant, other]);
      await sql.query("DELETE FROM users WHERE id IN ($1, $2)", [tenant, other]);
    }
  });
});
