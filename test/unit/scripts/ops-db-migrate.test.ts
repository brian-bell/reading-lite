import { describe, expect, it } from "vitest";
import { dbMigrateCommand, type DbMigrateDeps } from "../../../scripts/ops-lib/commands/db-migrate";
import { UsageError } from "../../../scripts/ops-lib/contract";
import type { MigrationFile } from "../../../scripts/pg-lib/migrate";

// A fake client: the runner itself is tested against real Postgres in
// test/unit/pg/migrate.test.ts. This file owns the command's mode contract.
function makeDeps(recorded: Array<{ version: string; name: string; checksum: string }>, files: MigrationFile[]) {
  const out: string[] = [];
  const err: string[] = [];
  const queries: string[] = [];
  let ended = false;
  const deps: DbMigrateDeps = {
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    env: { DIRECT_URL: "postgres://direct" },
    readMigrations: () => files,
    connect: async (url) => {
      expect(url).toBe("postgres://direct");
      return {
        async query(text: string) {
          queries.push(text.trim());
          if (text.includes("to_regclass")) return { rows: [{ present: true }] };
          if (text.includes("FROM schema_migrations")) return { rows: recorded };
          return { rows: [] };
        },
        async end() {
          ended = true;
        },
      };
    },
  };
  return { deps, out, err, queries, ended: () => ended };
}

const FILES: MigrationFile[] = [
  { version: "0001", name: "first", sql: "CREATE TABLE a ()", checksum: "c1" },
  { version: "0002", name: "second", sql: "CREATE TABLE b ()", checksum: "c2" },
];
const FIRST_APPLIED = [{ version: "0001", name: "first", checksum: "c1" }];

describe("ops db migrate", () => {
  it("plans by default: lists pending files and only reads", async () => {
    const { deps, out, queries, ended } = makeDeps(FIRST_APPLIED, FILES);
    expect(await dbMigrateCommand.run(["--database-url-env", "DIRECT_URL"], deps)).toBe(0);
    expect(out).toEqual([
      "[PLAN] database from DIRECT_URL: 1 applied, 1 pending",
      "[PLAN] pending 0002_second",
      "[PLAN] re-run with --execute to apply.",
    ]);
    expect(queries.every((text) => text.startsWith("SELECT"))).toBe(true);
    expect(ended()).toBe(true);
  });

  it("--execute applies the pending file under the advisory lock", async () => {
    const { deps, out, queries } = makeDeps(FIRST_APPLIED, FILES);
    expect(await dbMigrateCommand.run(["--database-url-env", "DIRECT_URL", "--execute"], deps)).toBe(0);
    expect(out.at(-1)).toBe("[MIGRATE] applied 0002_second");
    expect(queries).toContain("CREATE TABLE b ()");
    expect(queries).not.toContain("CREATE TABLE a ()");
    const lock = queries.findIndex((text) => text.includes("pg_advisory_lock"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(queries.indexOf("CREATE TABLE b ()"));
  });

  it("exits 1 on drift without applying anything", async () => {
    const { deps, err, queries } = makeDeps([{ version: "0001", name: "first", checksum: "edited" }], FILES);
    expect(await dbMigrateCommand.run(["--database-url-env", "DIRECT_URL", "--execute"], deps)).toBe(1);
    expect(err.join("\n")).toContain("Migration drift: Applied migration 0001_first changed");
    expect(queries).not.toContain("CREATE TABLE b ()");
  });

  it("is a usage error when the connection-string variable is unset", async () => {
    const { deps } = makeDeps([], FILES);
    await expect(dbMigrateCommand.run([], deps)).rejects.toThrow(UsageError);
  });
});
