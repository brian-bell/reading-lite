// `ops staging setup` — migrate staging's PostgreSQL database, then create the
// one-time Cloudflare staging resources for reading-lite: R2 bucket and the
// Queue + DLQ pairs. Idempotent and hard-coded to staging
// names. Plan-first: a mode-less run reads the database's migration history
// read-only and prints the wrangler command plan; --execute migrates, then
// creates the resources.
//
// The database is the Neon rehearsal branch, reached through the operator-db
// pairing for the staging bucket. Setup never creates it and teardown never
// drops it. It is resolved and migrated BEFORE any Cloudflare mutation: a
// staging environment whose database cannot be reached or migrated has
// nowhere to write, and nothing would complain until the first reading. The
// migration run is the one `ops db migrate` and `ops deploy worker` use.

import { parseArgs } from "node:util";
import {
  parseSummarizerProvider,
  type SummarizerProvider,
} from "../../../src/modules/summarizer/config";
import {
  DEFAULT_STAGING_RESOURCES,
  buildSecretCommands,
  buildStagingSetupCommands,
  type WranglerCommand,
} from "../../staging-env";
import { STAGING_BOOTSTRAP_PROHIBITION } from "../../lib/founder-bootstrap";
import { readMigrations, type MigrationFile } from "../../pg-lib/migrate";
import { connectMigrationClient, runPendingMigrations, type MigrationConnection } from "../../pg-lib/migrate-runner";
import { resolveOperatorDatabaseUrl, type ResolvedDatabaseUrl } from "../../pg-lib/operator-db";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface StagingSetupDeps extends BaseDeps {
  runWranglerCommands: (commands: WranglerCommand[]) => Promise<number>;
  env: Record<string, string | undefined>;
  readMigrations: () => MigrationFile[];
  connect: (databaseUrl: string) => Promise<MigrationConnection>;
}

function printCommandPlan(io: CommandIo, title: string, commands: WranglerCommand[], execute: boolean): void {
  const mode = execute ? "EXECUTE" : "PLAN";
  io.stderr(`[${mode}] ${title}`);
  for (const command of commands) {
    io.stderr(`[${mode}] ${command.label}`);
    io.stderr(`[${mode}] $ wrangler ${command.args.join(" ")}`);
  }
}

function printSecretChecklist(io: CommandIo, provider: SummarizerProvider): void {
  io.stderr("\nSet staging secrets separately:");
  for (const command of buildSecretCommands(provider)) {
    io.stderr(`  ${command}`);
  }
}

async function runStagingSetup(argv: string[], deps: StagingSetupDeps): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        execute: { type: "boolean", default: false },
        provider: { type: "string", default: "openai" },
        "database-url-env": { type: "string" },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  let provider: SummarizerProvider;
  try {
    provider = parseSummarizerProvider(values.provider);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const execute = values.execute === true;
  const mode = execute ? "EXECUTE" : "PLAN";
  const { io } = deps;

  // Throws UsageError for a missing or mis-paired variable, before anything
  // is contacted. A plan without --database-url-env tolerates an unset
  // database, as `deploy worker`'s plan does: the migrations go uninspected,
  // which is a gap in the plan rather than evidence against it. A mis-paired
  // name is refused in both modes.
  let database: ResolvedDatabaseUrl | null;
  try {
    database = resolveOperatorDatabaseUrl({
      bucket: DEFAULT_STAGING_RESOURCES.bucket,
      databaseUrlEnv: values["database-url-env"],
      env: deps.env,
    });
  } catch (error) {
    if (execute || values["database-url-env"] !== undefined || !(error instanceof UsageError)) throw error;
    database = null;
  }
  const commands = buildStagingSetupCommands(DEFAULT_STAGING_RESOURCES);

  // Plan mode connects too, read-only: it lists applied and pending
  // migrations, exactly as `ops db migrate` does without --execute.
  io.stderr(`[${mode}] staging database migrations`);
  let planFailed = false;
  if (database === null) {
    io.stderr(`[PLAN] no staging database variable is set; migrations uninspected. --execute refuses without one.`);
  } else {
    const migrations = await runPendingMigrations({
      io,
      mode,
      envName: database.envName,
      databaseUrl: database.url,
      execute,
      readMigrations: deps.readMigrations,
      connect: deps.connect,
    });
    if (!migrations.ok) {
      if (execute) {
        io.stderr(`[EXECUTE] staging database migrations FAILED (${migrations.reason}); no Cloudflare resources were created.`);
        return 1;
      }
      // Drift (or a failed read) is the opposite of unreachable: the history
      // WAS read and is not something setup may act on, so the plan fails.
      if (migrations.reason === "unreachable") {
        io.stderr("[PLAN] could not reach the staging database; migrations uninspected. --execute stops here until it can.");
      } else {
        planFailed = true;
        io.stderr("[PLAN] the staging database's migration history is not something setup can act on; --execute would stop here.");
      }
    }
  }

  printCommandPlan(io, "staging resource setup", commands, execute);

  if (!execute) {
    io.stderr("\n[PLAN] nothing was migrated or created.");
    printSecretChecklist(io, provider);
    return planFailed ? 1 : 0;
  }

  const code = await deps.runWranglerCommands(commands);
  if (code !== 0) return code;

  io.stderr("\n[EXECUTE] staging database migrated; staging resources created or confirmed.");
  printSecretChecklist(io, provider);
  io.stderr(`\n${STAGING_BOOTSTRAP_PROHIBITION}`);
  return 0;
}

export const stagingSetupCommand: CommandDefinition<StagingSetupDeps> = {
  group: "staging",
  name: "setup",
  summary: "Migrate the staging database and create the Cloudflare staging resources (idempotent)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- staging setup [--provider openai|anthropic] [--database-url-env NAME] [--execute]

Migrates staging's PostgreSQL database (the Neon rehearsal branch), then
creates the one-time Cloudflare staging resources for reading-lite: R2 bucket,
and reading, digest, wipe, and refresh Queue + DLQ pairs.

Plans by default: connects read-only to list applied and pending migrations,
and prints the wrangler commands. With no staging database variable set, or
the database unreachable, the plan says the migrations went uninspected and
still prints the rest; migration drift fails it. --execute applies the migrations (the same
run as \`ops db migrate\`) and only then creates resources; a database that
cannot be reached or migrated stops setup before any Cloudflare change.
Idempotent — "already exists" is treated as success, and a rerun applies only
what is pending. Setup never creates the database; teardown never drops it.

${STAGING_BOOTSTRAP_PROHIBITION}

Secrets are not written by this command because wrangler secret put is
interactive; the plan prints the commands to run afterwards. OpenAI is the
default provider. Pass --provider anthropic to include the conditional
ANTHROPIC_API_KEY command. RESEND_API_KEY is optional.

Options:
  --provider <name>  openai (default) or anthropic — affects the printed
                     secret checklist only.
  --database-url-env <NAME>
                     Environment variable holding a DIRECT PostgreSQL
                     connection string for the staging database (never a
                     Hyperdrive one): STAGING_DATABASE_URL, or on a laptop
                     NEON_REHEARSAL_DATABASE_URL from
                     ~/.config/reading-lite/neon.env. Default: whichever is
                     set. The role needs DDL, including CREATE EXTENSION vector.
  --execute          Migrate the database, then create the resources.
  --help             Show this message.`,
  defaultDeps: (io: CommandIo): StagingSetupDeps => ({
    io,
    env: process.env,
    readMigrations: () => readMigrations(),
    connect: connectMigrationClient,
    runWranglerCommands: async (commands) => {
      const { runWranglerCommands } = await import("../../staging-env");
      return runWranglerCommands(commands);
    },
  }),
  run: runStagingSetup,
};
