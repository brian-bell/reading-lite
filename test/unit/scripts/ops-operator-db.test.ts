import { describe, expect, it } from "vitest";
import type { Sql, SqlRow } from "../../../src/modules/db/sql";
import {
  DATABASE_URL_ENV_DEFAULT,
  isLocalDatabaseUrl,
  operatorDatabaseUrl,
  requireLocalDatabase,
  withOperatorSql,
} from "../../../scripts/pg-lib/operator-db";
import { OperatorCorpus, operatorCorpusFor, requirePgTenant, toListItem } from "../../../scripts/pg-lib/operator-corpus";
import { UsageError } from "../../../scripts/ops-lib/contract";
import type { ListIndexItem } from "../../../src/schemas/api";
import {
  CONTROL_PLANE_BY_BUCKET,
  openControlPlaneForBucket,
} from "../../../scripts/account-lib/control-plane";

interface Recorded {
  text: string;
  values: unknown[];
}

function fakeSql(rows: SqlRow[] = [], affected = 0): Sql & { calls: Recorded[]; ended: number } {
  const calls: Recorded[] = [];
  const sql = {
    calls,
    ended: 0,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return rows as never;
    },
    async execute(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return affected;
    },
    async transaction<T>(run: (tx: never) => Promise<T>) {
      return run(sql as never);
    },
    async end() {
      sql.ended += 1;
    },
  };
  return sql as never;
}

describe("operatorDatabaseUrl", () => {
  it("defaults to DATABASE_URL", () => {
    expect(DATABASE_URL_ENV_DEFAULT).toBe("DATABASE_URL");
    expect(operatorDatabaseUrl("DATABASE_URL", { DATABASE_URL: "postgres://x" })).toBe("postgres://x");
  });

  it("fails closed as a UsageError naming the variable, never printing a value", () => {
    let caught: unknown;
    try {
      operatorDatabaseUrl("NEON_MAIN_DATABASE_URL", { OTHER: "postgres://secret" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect(String(caught)).toContain("NEON_MAIN_DATABASE_URL");
    expect(String(caught)).not.toContain("postgres://secret");
  });

  it("treats a whitespace-only value as unset", () => {
    expect(() => operatorDatabaseUrl("DATABASE_URL", { DATABASE_URL: "   " })).toThrow(UsageError);
  });
});

describe("withOperatorSql", () => {
  it("closes the session when the body succeeds", async () => {
    const sql = fakeSql();
    await withOperatorSql("postgres://x", async () => "done", () => sql);
    expect(sql.ended).toBe(1);
  });

  it("closes the session when the body throws, and preserves the failure", async () => {
    const sql = fakeSql();
    await expect(
      withOperatorSql("postgres://x", async () => {
        throw new Error("mid-plan failure");
      }, () => sql),
    ).rejects.toThrow("mid-plan failure");
    expect(sql.ended).toBe(1);
  });
});

describe("requirePgTenant", () => {
  it("refuses --tenant global, which has no PostgreSQL corpus", () => {
    expect(() => requirePgTenant({ kind: "global", keyRoot: "", namespace: undefined })).toThrow(UsageError);
    expect(() => operatorCorpusFor(fakeSql(), { kind: "global", keyRoot: "", namespace: undefined })).toThrow(
      /#348/,
    );
  });

  it("returns the tenant id for a tenant selector", () => {
    expect(
      requirePgTenant({ kind: "tenant", tenantId: "usr_abc", keyRoot: "u/usr_abc", namespace: "usr_abc" }),
    ).toBe("usr_abc");
  });
});

describe("isLocalDatabaseUrl", () => {
  it.each([
    ["postgres://u:p@127.0.0.1:54329/reading_lite", true],
    ["postgres://u:p@localhost:5432/reading_lite", true],
    ["postgres://u:p@[::1]:5432/reading_lite", true],
    ["postgres://u:p@ep-cool-name.eu-central-1.aws.neon.tech/main", false],
    ["postgres://u:p@10.0.0.4:5432/main", false],
    ["not a url", false],
  ])("%s -> %s", (url, expected) => {
    expect(isLocalDatabaseUrl(url)).toBe(expected);
  });

  // --local reads the miniflare bucket, but the row deletes go wherever the
  // named variable points: the pair would delete production rows while
  // deleting local objects.
  it("refuses a --local run against a non-local database", () => {
    expect(() => requireLocalDatabase("postgres://u:p@prod.neon.tech/main", "DATABASE_URL")).toThrow(
      UsageError,
    );
    expect(() =>
      requireLocalDatabase("postgres://u:p@127.0.0.1:54329/reading_lite", "DATABASE_URL"),
    ).not.toThrow();
  });
});

describe("toListItem", () => {
  // corpus sweep ranks duplicates by tldr/tags/keywords; dropping them made
  // every copy score zero and silently reduced the ranking to "newest wins".
  it("carries the summary fields corpus sweep ranks on", () => {
    const item: ListIndexItem = {
      id: "rd_1",
      key_prefix: "u/usr_abc/readings/rd_1",
      url: "https://example.com/a",
      status: "ready",
      created_at: "2026-01-01T00:00:00.000Z",
      tldr: "a real summary",
      tags: ["x", "y"],
      keywords: ["k1", "k2", "k3"],
    };
    expect(toListItem(item)).toMatchObject({
      tldr: "a real summary",
      tags: ["x", "y"],
      keywords: ["k1", "k2", "k3"],
    });
  });

  it("keeps the fields the corpus tools read and drops the rest", () => {
    const item: ListIndexItem = {
      id: "rd_1",
      key_prefix: "u/usr_abc/readings/rd_1",
      url: "https://example.com/a",
      title: "A",
      tldr: "summary",
      tags: ["x"],
      keywords: ["k"],
      status: "ready",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    };
    expect(toListItem(item)).toEqual({
      id: "rd_1",
      url: "https://example.com/a",
      status: "ready",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      key_prefix: "u/usr_abc/readings/rd_1",
      title: "A",
      tldr: "summary",
      tags: ["x"],
      keywords: ["k"],
      source_date: undefined,
      error: undefined,
      active_attempt: undefined,
      last_attempt: undefined,
      enrichment_degradation: undefined,
    });
  });
});

describe("OperatorCorpus writes", () => {
  it("scopes the reading delete to the tenant and reports whether a row went", async () => {
    const present = new OperatorCorpus(fakeSql([], 1), "usr_abc");
    expect(await present.deleteReading("rd_1")).toBe(true);

    const sql = fakeSql([], 0);
    expect(await new OperatorCorpus(sql, "usr_abc").deleteReading("rd_missing")).toBe(false);
    expect(sql.calls[0].text).toContain("DELETE FROM readings");
    expect(sql.calls[0].values).toEqual(["usr_abc", "rd_missing"]);
  });

  it("records a similarity snapshot without touching updated_at", async () => {
    const sql = fakeSql([], 1);
    const snapshot = { count: 3, max: 0.82, computed_at: "2026-09-19T00:00:00.000Z" };
    expect(await new OperatorCorpus(sql, "usr_abc").setSimilarity("rd_1", snapshot)).toBe(true);
    expect(sql.calls[0].text).toContain("UPDATE readings SET similarity");
    // No content changed, so bumping updated_at would misreport the reading as
    // freshly written to anything ordering by it.
    expect(sql.calls[0].text).not.toContain("updated_at");
    expect(sql.calls[0].values).toEqual(["usr_abc", "rd_1", JSON.stringify(snapshot)]);
  });

  it("reports no row when the reading is gone", async () => {
    const sql = fakeSql([], 0);
    expect(await new OperatorCorpus(sql, "usr_abc").setSimilarity("rd_missing", {})).toBe(false);
  });

  it("measures neighbours from the embedding the reading already owns", async () => {
    // Null, not empty: a reading with no embedding is a failed measurement,
    // which is a different answer from a reading with no neighbours.
    const sql = fakeSql([]);
    expect(await new OperatorCorpus(sql, "usr_abc").neighboursOf("rd_1", 20)).toBeNull();
    expect(sql.calls[0].text).toContain("FROM reading_embeddings");
    expect(sql.calls[0].values).toEqual(["usr_abc", "rd_1"]);
  });

  it("purges inbound relationships by target, which no cascade covers", async () => {
    const sql = fakeSql([], 3);
    expect(await new OperatorCorpus(sql, "usr_abc").deleteInboundRelationships("rd_gone")).toBe(3);
    expect(sql.calls[0].text).toContain("target_id = $2");
    expect(sql.calls[0].values).toEqual(["usr_abc", "rd_gone"]);
  });
});

describe("bucket to control-plane mapping", () => {
  // system status and system policy resolve their handle through this. Left on
  // wrangler D1 they would report a frozen policy and write spend caps to a
  // database no Worker binding reads — a cap the operator believes is set
  // would never apply.
  it("names the connection-string variable for each environment", () => {
    expect(CONTROL_PLANE_BY_BUCKET["reading-lite"]).toEqual({
      databaseUrlEnv: "NEON_MAIN_DATABASE_URL",
      env: "production",
    });
    // Staging runs on the rehearsal branch (ADR 0005, step 0).
    expect(CONTROL_PLANE_BY_BUCKET["reading-lite-staging"]).toEqual({
      databaseUrlEnv: "NEON_REHEARSAL_DATABASE_URL",
      env: "staging",
    });
  });

  it("refuses an unmapped bucket rather than guessing an environment", () => {
    expect(() => openControlPlaneForBucket("some-scratch-bucket", {})).toThrow(/no control-plane database/);
  });

  it("refuses an unset connection string rather than treating it as empty", () => {
    expect(() => openControlPlaneForBucket("reading-lite", {})).toThrow(/NEON_MAIN_DATABASE_URL is not set/);
  });

  it("honours an explicit variable override", async () => {
    const opened = openControlPlaneForBucket(
      "reading-lite",
      { OTHER_URL: "postgres://u:p@127.0.0.1:54329/reading_lite" },
      "OTHER_URL",
    );
    expect(opened.db).toBeDefined();
    await opened.close();
  });
});
