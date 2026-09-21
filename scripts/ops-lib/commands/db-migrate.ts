// `ops db migrate` — apply the forward-only PostgreSQL migrations in
// db/migrations/ (ADR 0005). Plan-first: a mode-less run connects read-only in
// effect (it only SELECTs), lists applied and pending files, and refuses on
// drift; --execute applies the pending files under the runner's advisory lock.
//
// Uses a DIRECT connection string, never Hyperdrive: the lock is session
// state. Operators source the Neon strings per command from
// ~/.config/reading-lite/neon.env; the URL is read from an environment
// variable so it never lands in shell history or the process list.
//
// The run itself lives in pg-lib/migrate-runner, which `ops deploy worker`
// shares so a deploy applies exactly what this command would.

import { parseArgs } from "node:util";
import { readMigrations, type MigrationFile } from "../../pg-lib/migrate";
import { runPendingMigrations, type MigrationConnection } from "../../pg-lib/migrate-runner";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";

export interface DbMigrateDeps extends BaseDeps {
  env: Record<string, string | undefined>;
  readMigrations: () => MigrationFile[];
  connect: (databaseUrl: string) => Promise<MigrationConnection>;
}

export const dbMigrateCommand: CommandDefinition<DbMigrateDeps> = {
  group: "db",
  name: "migrate",
  summary: "Apply PostgreSQL migrations from db/migrations/",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- db migrate [--database-url-env NAME] [--execute]

Plans by default: connects, lists applied and pending migrations, and changes
nothing. --execute applies pending files in order, one transaction per file,
under an advisory lock. Forward-only. Refuses (exit 1) when an applied file
has changed or disappeared, or a pending file is older than an applied one.

Options:
  --database-url-env <NAME>
                 Environment variable holding a DIRECT PostgreSQL connection
                 string (default: DATABASE_URL). Not a Hyperdrive string. For
                 Neon: source ~/.config/reading-lite/neon.env and pass
                 NEON_DEV_DATABASE_URL, NEON_REHEARSAL_DATABASE_URL or
                 NEON_MAIN_DATABASE_URL.
  --execute      Apply the pending migrations.
  --help         Show this message.`,
  defaultDeps: (io) => ({
    io,
    env: process.env,
    readMigrations: () => readMigrations(),
    async connect(databaseUrl) {
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();
      return client;
    },
  }),
  async run(argv, deps) {
    let values;
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          "database-url-env": { type: "string", default: "DATABASE_URL" },
          execute: { type: "boolean", default: false },
        },
      }));
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    const envName = values["database-url-env"]!;
    const databaseUrl = deps.env[envName];
    if (!databaseUrl) throw new UsageError(`${envName} is not set; it must hold a direct PostgreSQL connection string`);
    const outcome = await runPendingMigrations({
      io: deps.io,
      mode: values.execute ? "MIGRATE" : "PLAN",
      envName,
      databaseUrl,
      execute: values.execute === true,
      readMigrations: deps.readMigrations,
      connect: deps.connect,
    });
    return outcome.ok ? 0 : 1;
  },
};
