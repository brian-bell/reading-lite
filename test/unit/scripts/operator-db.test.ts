import { describe, expect, it, vi } from "vitest";
import {
  databaseTargetForBucket,
  OPERATOR_DATABASES,
  resolveOperatorDatabaseUrl,
  withOperatorSql,
} from "../../../scripts/pg-lib/operator-db";
import { LOCAL_DATABASE_URL } from "../../../scripts/pg-lib/local-postgres";
import { UsageError } from "../../../scripts/ops-lib/contract";
import type { Sql } from "../../../src/modules/db/sql";

const ENV = {
  PRODUCTION_DATABASE_URL: "postgres://prod",
  STAGING_DATABASE_URL: "postgres://stg",
};

function fakeSql(end: () => Promise<void>): Sql {
  return {
    query: async () => [],
    execute: async () => 0,
    transaction: async (run) => run({ query: async () => [], execute: async () => 0 }),
    end,
  };
}

describe("the bucket-to-database pairing", () => {
  it("pairs each known bucket with its environment", () => {
    expect(databaseTargetForBucket("reading-lite").env).toBe("production");
    expect(databaseTargetForBucket("reading-lite-staging").env).toBe("staging");
  });

  // The whole point of the module: a wrong answer here is an operator's
  // irreversible decision taken against the wrong environment.
  it("refuses an unrecognised bucket rather than defaulting to production", () => {
    expect(() => databaseTargetForBucket("reading-lite-typo")).toThrow(UsageError);
    expect(() => databaseTargetForBucket("reading-lite-typo")).toThrow(/known buckets/);
  });

  it("refuses a variable that names the other environment's database", () => {
    expect(() =>
      resolveOperatorDatabaseUrl({
        bucket: "reading-lite",
        databaseUrlEnv: "STAGING_DATABASE_URL",
        env: ENV,
      }),
    ).toThrow(/names the staging database, but bucket reading-lite is production/);
  });

  it("refuses a variable that names no database at all", () => {
    expect(() =>
      resolveOperatorDatabaseUrl({ bucket: "reading-lite", databaseUrlEnv: "DATABASE_URL", env: ENV }),
    ).toThrow(/does not name the production database/);
  });

  it("defaults to the bucket's first accepted variable", () => {
    expect(resolveOperatorDatabaseUrl({ bucket: "reading-lite", env: ENV })).toEqual({
      envName: "PRODUCTION_DATABASE_URL",
      url: "postgres://prod",
    });
  });

  // An operator who sourced the documented neon.env has only the NEON_ name
  // set. Insisting on the Actions-only first name would fail every command
  // that exposes no --database-url-env flag, including account wipe.
  it("falls through to whichever accepted variable the operator actually set", () => {
    expect(
      resolveOperatorDatabaseUrl({
        bucket: "reading-lite",
        env: { NEON_MAIN_DATABASE_URL: "postgres://neon-main" },
      }),
    ).toEqual({ envName: "NEON_MAIN_DATABASE_URL", url: "postgres://neon-main" });
    expect(
      resolveOperatorDatabaseUrl({
        bucket: "reading-lite-staging",
        env: { NEON_REHEARSAL_DATABASE_URL: "postgres://neon-rehearsal" },
      }),
    ).toEqual({ envName: "NEON_REHEARSAL_DATABASE_URL", url: "postgres://neon-rehearsal" });
  });

  // Order still decides when both are set: the Actions name wins, so a CI run
  // that happens to carry a stale NEON_ value does not silently switch.
  it("prefers the first accepted variable when more than one is set", () => {
    expect(
      resolveOperatorDatabaseUrl({
        bucket: "reading-lite",
        env: { ...ENV, NEON_MAIN_DATABASE_URL: "postgres://neon-main" },
      }),
    ).toEqual({ envName: "PRODUCTION_DATABASE_URL", url: "postgres://prod" });
  });

  it("names every accepted variable when none of them is set", () => {
    expect(() => resolveOperatorDatabaseUrl({ bucket: "reading-lite", env: {} })).toThrow(
      /PRODUCTION_DATABASE_URL, NEON_MAIN_DATABASE_URL/,
    );
  });

  it("refuses an explicitly named accepted variable that is not set", () => {
    expect(() =>
      resolveOperatorDatabaseUrl({
        bucket: "reading-lite",
        databaseUrlEnv: "PRODUCTION_DATABASE_URL",
        env: {},
      }),
    ).toThrow(/PRODUCTION_DATABASE_URL is not set/);
  });

  // A local corpus seeded from production shares reading ids, so a --local run
  // that fell through to a deployed variable would act on production.
  it("--local uses this checkout's database and never a deployed variable", () => {
    expect(resolveOperatorDatabaseUrl({ bucket: "reading-lite", local: true, env: ENV })).toEqual({
      envName: "READING_LITE_DATABASE_URL",
      url: LOCAL_DATABASE_URL,
    });
  });

  // The escape hatch that would otherwise reopen exactly what --local prevents:
  // the banner says "(local)" while the statements land on production.
  it("--local refuses an explicit variable that names a deployed database", () => {
    expect(() =>
      resolveOperatorDatabaseUrl({
        bucket: "reading-lite",
        databaseUrlEnv: "PRODUCTION_DATABASE_URL",
        local: true,
        env: ENV,
      }),
    ).toThrow(/names the production database, which --local must never reach/);
  });

  it("--local still accepts a non-deploy variable", () => {
    expect(
      resolveOperatorDatabaseUrl({
        bucket: "reading-lite",
        databaseUrlEnv: "MY_SCRATCH_URL",
        local: true,
        env: { ...ENV, MY_SCRATCH_URL: "postgres://scratch" },
      }),
    ).toEqual({ envName: "MY_SCRATCH_URL", url: "postgres://scratch" });
  });
});

describe("withOperatorSql", () => {
  // A command that returns without closing leaves the socket open until the
  // process exits: invisible in a one-shot CLI run, fatal in a test suite.
  it("closes the session on success, on usage error and on failure", async () => {
    const end = vi.fn(async () => {});
    const open = () => fakeSql(end);

    await expect(withOperatorSql("postgres://x", async () => 7, open)).resolves.toBe(7);
    expect(end).toHaveBeenCalledTimes(1);

    await expect(
      withOperatorSql("postgres://x", async () => { throw new UsageError("bad flag"); }, open),
    ).rejects.toThrow(UsageError);
    expect(end).toHaveBeenCalledTimes(2);

    await expect(
      withOperatorSql("postgres://x", async () => { throw new Error("boom"); }, open),
    ).rejects.toThrow("boom");
    expect(end).toHaveBeenCalledTimes(3);
  });

  it("does not fail successful work because the teardown rejected", async () => {
    const open = () => fakeSql(async () => { throw new Error("socket already gone"); });
    await expect(withOperatorSql("postgres://x", async () => "done", open)).resolves.toBe("done");
  });
});

describe("bucket → database pairing against wrangler.toml", () => {
  // Every operator command picks its database from the bucket it acts on.
  // wrangler.toml owns the bucket names; if one moves, a command would read or
  // write the wrong environment's rows, so pin the pair rather than trusting two
  // copies to stay in step.
  it("names, for each env, the bucket wrangler.toml declares", async () => {
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    const toml = await fs.readFile(path.resolve(__dirname, "../../../wrangler.toml"), "utf8");

    // Everything from `[env.<name>]` to the next TOP-LEVEL env header is that
    // environment's block. The cut must ignore `[env.<name>.vars]` and
    // `[[env.<name>.r2_buckets]]`, which belong to the block they sit in.
    const blockFor = (env: string): string => {
      const start = toml.indexOf(`\n[env.${env}]\n`);
      expect(start, `wrangler.toml has no [env.${env}] section`).toBeGreaterThanOrEqual(0);
      const rest = toml.slice(start + 1);
      const next = /\n\[env\.[A-Za-z0-9_-]+\]\n/.exec(rest.slice(1));
      return next === null ? rest : rest.slice(0, next.index + 1);
    };
    const valueIn = (block: string, key: string): string | undefined =>
      new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m").exec(block)?.[1];

    for (const [bucket, { env }] of Object.entries(OPERATOR_DATABASES)) {
      expect(valueIn(blockFor(env), "bucket_name"), `${env} bucket_name`).toBe(bucket);
    }
  });
});
