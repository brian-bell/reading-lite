// `ops deploy worker` applies pending PostgreSQL migrations before the upload
// (reading-lite-gh347.4.4). This file owns that step: the ordering, the
// fail-closed path, and the --env/--database-url-env pairing. Migration
// planning, drift and file ordering stay owned by test/unit/pg/migrate.test.ts
// and test/unit/scripts/ops-db-migrate.test.ts.

import { describe, expect, it, vi } from "vitest";
import { deployWorkerCommand, type DeployWorkerDeps } from "../../../scripts/ops-lib/commands/deploy-worker";
import { UsageError } from "../../../scripts/ops-lib/contract";
import type { MigrationFile } from "../../../scripts/pg-lib/migrate";

const file = (version: string, name: string): MigrationFile => ({
  version,
  name,
  sql: `-- ${name}`,
  checksum: version.repeat(8),
});

function deps(
  options: {
    migrateFails?: boolean;
    connectFails?: boolean;
    drift?: boolean;
    pending?: MigrationFile[];
    env?: Record<string, string>;
  } = {},
) {
  const order: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const runWrangler = vi.fn(async () => {
    order.push("wrangler");
    return 0;
  });
  const connect = vi.fn(async () => {
    order.push("migrations");
    if (options.connectFails) throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
    return {
      async query(text: string) {
        // Fail on the migration's own SQL only, so the apply path is what
        // breaks — not the read-only plan that precedes it.
        if (options.migrateFails && (options.pending ?? []).some((file) => file.sql === text)) {
          throw new Error('relation "readings" does not exist');
        }
        // planMigrations' probe; an absent table means nothing is applied yet.
        if (text.includes("to_regclass")) return { rows: [{ present: Boolean(options.drift) }] };
        // Drift: a recorded migration with no file on disk.
        if (options.drift && text.includes("FROM schema_migrations")) {
          return { rows: [{ version: "0001", name: "vanished", checksum: "c".repeat(8) }] };
        }
        return { rows: [] };
      },
      async end() {},
    };
  });
  const built: DeployWorkerDeps = {
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    runWrangler,
    validateTenantActivation: vi.fn(async () => ({ ok: true, message: "already enabled" })),
    // The cutover guard has its own owner: postgres-cutover.test.ts.
    checkPostgresCutover: () => ({ ok: true, bound: false }),
    env: options.env ?? { PRODUCTION_DATABASE_URL: "postgres://production", STAGING_DATABASE_URL: "postgres://staging" },
    readMigrations: () => options.pending ?? [],
    connect,
  };
  return { built, order, out, err, runWrangler, connect };
}

describe("ops deploy worker migrations", () => {
  it("applies pending migrations before the upload", async () => {
    const { built, order, out } = deps({ pending: [file("0006", "reading_source_date")] });
    expect(
      await deployWorkerCommand.run(["--env", "production", "--execute", "--database-url-env", "PRODUCTION_DATABASE_URL"], built),
    ).toBe(0);
    expect(order).toEqual(["migrations", "wrangler"]);
    expect(out.join("\n")).toContain("[DEPLOY] applied 0006_reading_source_date");
  });

  it("aborts the deploy when the migration's own SQL fails, with nothing uploaded", async () => {
    const { built, err, runWrangler } = deps({ migrateFails: true, pending: [file("0006", "reading_source_date")] });
    expect(
      await deployWorkerCommand.run(["--env", "production", "--execute", "--database-url-env", "PRODUCTION_DATABASE_URL"], built),
    ).toBe(1);
    expect(runWrangler).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("Migration 0006_reading_source_date failed");
    expect(err.join("\n")).toContain("[DEPLOY] migrations FAILED; nothing uploaded.");
  });

  it("aborts the deploy when the database is unreachable", async () => {
    const { built, err, runWrangler } = deps({ connectFails: true, pending: [file("0006", "reading_source_date")] });
    expect(
      await deployWorkerCommand.run(["--env", "production", "--execute", "--database-url-env", "PRODUCTION_DATABASE_URL"], built),
    ).toBe(1);
    expect(runWrangler).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("[DEPLOY] migrations FAILED; nothing uploaded.");
  });

  it("fails a plan that finds drift, after still dry-running the build", async () => {
    const { built, err, runWrangler } = deps({ drift: true });
    expect(await deployWorkerCommand.run(["--env", "staging", "--database-url-env", "STAGING_DATABASE_URL"], built)).toBe(1);
    // The build check is the point of a plan, so it still runs — but an
    // unreadable migration history is not a plan the operator may act on.
    expect(runWrangler).toHaveBeenCalledWith(["deploy", "--env", "staging", "--dry-run"]);
    expect(err.join("\n")).toContain("Migration drift");
  });

  it("fails an --execute that finds drift, with nothing uploaded", async () => {
    const { built, err, runWrangler } = deps({ drift: true });
    expect(
      await deployWorkerCommand.run(["--env", "production", "--execute", "--database-url-env", "PRODUCTION_DATABASE_URL"], built),
    ).toBe(1);
    expect(runWrangler).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("Migration drift");
  });

  it("still dry-runs the build when a plan cannot reach the database", async () => {
    const { built, err, runWrangler } = deps({ connectFails: true });
    expect(await deployWorkerCommand.run(["--env", "staging", "--database-url-env", "STAGING_DATABASE_URL"], built)).toBe(0);
    expect(err.join("\n")).toContain("continuing with the build dry-run");
    expect(runWrangler).toHaveBeenCalledWith(["deploy", "--env", "staging", "--dry-run"]);
  });

  it("refuses --execute when the named variable is unset, before uploading", async () => {
    const { built, err, runWrangler, connect } = deps({ env: {} });
    expect(
      await deployWorkerCommand.run(["--env", "production", "--execute", "--database-url-env", "PRODUCTION_DATABASE_URL"], built),
    ).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    expect(runWrangler).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("PRODUCTION_DATABASE_URL is not set");
  });

  it("lists pending migrations in plan mode without applying them", async () => {
    const { built, out, runWrangler } = deps({ pending: [file("0006", "reading_source_date")] });
    expect(
      await deployWorkerCommand.run(["--env", "staging", "--database-url-env", "STAGING_DATABASE_URL"], built),
    ).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("[PLAN] pending 0006_reading_source_date");
    expect(text).not.toContain("applied 0006_reading_source_date");
    expect(runWrangler).toHaveBeenCalledWith(["deploy", "--env", "staging", "--dry-run"]);
  });

  it("plans without a connection string, saying the migrations were not inspected", async () => {
    const { built, err, runWrangler, connect } = deps({ env: {} });
    expect(await deployWorkerCommand.run(["--env", "staging", "--database-url-env", "STAGING_DATABASE_URL"], built)).toBe(0);
    expect(connect).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("pending migrations were not inspected");
    expect(runWrangler).toHaveBeenCalled();
  });
});

describe("ops deploy worker --database-url-env pairing", () => {
  it("requires the flag, naming what it is for", async () => {
    const { built, runWrangler } = deps();
    await expect(deployWorkerCommand.run(["--env", "production", "--execute"], built)).rejects.toThrow(UsageError);
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it.each([
    ["production", "STAGING_DATABASE_URL", "names the staging database"],
    ["staging", "PRODUCTION_DATABASE_URL", "names the production database"],
    ["production", "NEON_DEV_DATABASE_URL", "does not name a production database"],
    ["production", "DATABASE_URL", "does not name a production database"],
  ])("refuses --env %s with --database-url-env %s before any remote call", async (env, name, message) => {
    const { built, runWrangler, connect } = deps();
    const checkPostgresCutover = vi.fn(() => ({ ok: true, bound: false }) as const);
    built.checkPostgresCutover = checkPostgresCutover;
    await expect(
      deployWorkerCommand.run(["--env", env, "--execute", "--database-url-env", name], built),
    ).rejects.toThrow(message);
    expect(checkPostgresCutover).not.toHaveBeenCalled();
    expect(built.validateTenantActivation).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it.each([
    ["production", "PRODUCTION_DATABASE_URL"],
    ["production", "NEON_MAIN_DATABASE_URL"],
    ["staging", "STAGING_DATABASE_URL"],
    ["staging", "NEON_REHEARSAL_DATABASE_URL"],
  ])("accepts --env %s with --database-url-env %s", async (env, name) => {
    const { built } = deps({ env: { [name]: "postgres://target" } });
    expect(await deployWorkerCommand.run(["--env", env, "--execute", "--database-url-env", name], built)).toBe(0);
  });
});
