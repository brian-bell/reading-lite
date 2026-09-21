// `ops deploy worker` — deploy the Cloudflare Worker (reading-lite).
// Plan-first: a mode-less run passes wrangler --dry-run (config validation +
// in-place build check, no upload) and prints the secrets the environment must
// already hold; --execute uploads. Before the write, require established
// tenant activation or an explicit manual acknowledgement.
//
// Schema is deployed from here again (reading-lite-gh347.4.4), against
// PostgreSQL now (ADR 0005): pending db/migrations/ files are applied after
// the refusal gates and before the upload, fail-closed. A failed migration
// stops the deploy with nothing uploaded, so a release whose code expects a
// new column cannot reach a database that lacks it. --database-url-env names
// the DIRECT connection string and is checked against --env before anything
// remote happens, so a production deploy cannot migrate staging.

import { parseArgs } from "node:util";
import { assertCleanCandidate, ShaSchema } from "../../lib/release-evidence";
import { CONTROL_PLANE_REQUIRED_SECRETS } from "../../control-plane-env";
import { readMigrations, type MigrationFile } from "../../pg-lib/migrate";
import { runPendingMigrations, type MigrationConnection } from "../../pg-lib/migrate-runner";
import { assertDatabaseUrlEnvMatches } from "../../pg-lib/operator-db";
import { validateTenantActivation } from "../tenant-activation-preflight";
import { checkPostgresCutover } from "../postgres-cutover";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export type DeployEnv = "production" | "staging";

export interface DeployWorkerDeps extends BaseDeps {
  runWrangler: (args: string[]) => Promise<number>;
  validateCandidate?: (sha: string) => Promise<void>;
  validateTenantActivation: typeof validateTenantActivation;
  checkPostgresCutover: typeof checkPostgresCutover;
  env: Record<string, string | undefined>;
  readMigrations: () => MigrationFile[];
  connect: (databaseUrl: string) => Promise<MigrationConnection>;
}

export function parseDeployEnv(value: unknown): DeployEnv | null {
  return value === "production" || value === "staging" ? value : null;
}

export function buildWranglerArgs(args: { env: DeployEnv; execute: boolean }): string[] {
  const out = ["deploy", "--env", args.env];
  if (!args.execute) out.push("--dry-run");
  return out;
}

async function runDeployWorker(argv: string[], deps: DeployWorkerDeps): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "release-sha": { type: "string" },
        "database-url-env": { type: "string" },
        execute: { type: "boolean", default: false },
        env: { type: "string", default: "production" },
        "acknowledge-tenant-migration": { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const env = parseDeployEnv(values.env);
  if (!env) throw new UsageError(`invalid --env: ${values.env}. Expected production or staging.`);
  const execute = values.execute === true;

  // Argument validation only, before the cutover guard and anything remote: a
  // deploy that names the wrong database must never reach the network.
  const databaseUrlEnv = values["database-url-env"];
  if (!databaseUrlEnv) {
    throw new UsageError("--database-url-env is required; it names the environment variable holding the target database's DIRECT PostgreSQL connection string.");
  }
  assertDatabaseUrlEnvMatches(env, databaseUrlEnv);

  const releaseSha = values["release-sha"];
  if (releaseSha !== undefined && !ShaSchema.safeParse(releaseSha).success) throw new UsageError("--release-sha must be a full lowercase commit SHA");
  if (releaseSha) await (deps.validateCandidate ?? assertCleanCandidate)(releaseSha);
  const wranglerArgs = buildWranglerArgs({ env, execute });
  if (releaseSha) wranglerArgs.push("--tag", releaseSha);
  const mode = execute ? "DEPLOY" : "PLAN";
  // First, before anything remote: a storage-migration candidate must not
  // reach an environment that has not been cut over (ADR 0005).
  const cutover = deps.checkPostgresCutover(env, { execute });
  if (!cutover.ok) {
    deps.io.stderr(`[${mode}] PostgreSQL cutover guard: REFUSED. ${cutover.error}`);
    if (execute) return 2;
  }
  deps.io.stderr(
    `[${mode}] worker=reading-lite env=${env}\n` +
      `[${mode}] $ wrangler ${wranglerArgs.join(" ")}\n` +
      `[${mode}] database from ${databaseUrlEnv}\n` +
      `[${mode}] required runtime secret: ${CONTROL_PLANE_REQUIRED_SECRETS.runtime.join(", ")}\n` +
      `[${mode}] bootstrap-only secret: ${CONTROL_PLANE_REQUIRED_SECRETS.bootstrapOnly.join(", ")}`,
  );
  deps.io.stderr("");
  if (execute) {
    const activation = await deps.validateTenantActivation(env);
    deps.io.stderr(`[DEPLOY] tenant activation preflight: ${activation.message}`);
    if (!activation.ok) {
      if (!values["acknowledge-tenant-migration"]) {
        deps.io.stderr("Refusing before upload. Verify the target tenant R2 corpus, namespaced vectors, and deletion eligibility, then re-run with --acknowledge-tenant-migration. See docs/operations.md (Tenant-mode activation guard).");
        return 2;
      }
      deps.io.stderr("[DEPLOY] OVERRIDE: operator acknowledges target tenant migration and deletion eligibility were verified manually for this deployment.");
    }
  } else {
    deps.io.stderr("[PLAN] execute will inspect the active tenant-mode version and R2/Vectorize resource creation metadata before upload; no remote readiness check has run. The database is read below, for the pending migrations only.");
  }

  // The last gate before the upload: the database must be at the head of
  // db/migrations/. Fail-closed — a non-zero run uploads nothing.
  let planFailed = false;
  const databaseUrl = deps.env[databaseUrlEnv];
  if (!databaseUrl) {
    if (execute) {
      deps.io.stderr(`[DEPLOY] ${databaseUrlEnv} is not set; it must hold a direct PostgreSQL connection string. Refusing before upload.`);
      return 1;
    }
    deps.io.stderr(`[PLAN] ${databaseUrlEnv} is not set; pending migrations were not inspected.`);
  } else {
    const migrations = await runPendingMigrations({
      io: deps.io,
      mode,
      envName: databaseUrlEnv,
      databaseUrl,
      execute,
      readMigrations: deps.readMigrations,
      connect: deps.connect,
    });
    if (!migrations.ok) {
      if (execute) {
        deps.io.stderr("[DEPLOY] migrations FAILED; nothing uploaded.");
        return 1;
      }
      // A plan's job is the config and build dry-run, and an unreachable
      // database must not take that away: the migration history simply went
      // unread, which is a gap in the plan rather than evidence against it.
      // Drift is the opposite — the history WAS read and is not something the
      // operator may act on — so the dry-run still runs but the plan fails.
      if (migrations.reason === "unreachable") {
        deps.io.stderr("[PLAN] could not reach the database; continuing with the build dry-run, migrations uninspected.");
      } else {
        planFailed = true;
        deps.io.stderr("[PLAN] the migration history is not a plan you can act on; the build dry-run below does not make this deploy safe.");
      }
    }
  }

  const uploaded = await deps.runWrangler(wranglerArgs);
  return uploaded === 0 && planFailed ? 1 : uploaded;
}

export const deployWorkerCommand: CommandDefinition<DeployWorkerDeps> = {
  group: "deploy",
  name: "worker",
  summary: "Deploy the Cloudflare Worker (wrangler deploy)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- deploy worker --database-url-env NAME [--env production|staging] [--execute]

Plans by default: runs \`wrangler deploy --dry-run\` (validates config and
build without uploading), prints the secrets the environment must already
hold, and lists the pending PostgreSQL migrations. --execute applies those
migrations and then uploads. Idempotent: re-running with the same source
produces the same Worker version. Does not create the database or import the
founder token.

Migrations are the last gate before the upload and are fail-closed: a drifted
or failing migration exits 1 with nothing uploaded, so a release whose code
expects a new column cannot reach a database that lacks it. A plan that finds
drift also exits 1, after the build dry-run. A plan that cannot reach the
database warns, dry-runs and exits 0: the history went unread, which is a gap
in the plan rather than evidence against it.

Before the upload, tenant mode must already be active with matching
R2/Vectorize bindings and resource creation metadata, or the operator must
acknowledge manual migration verification. Unverified activation prints deletion
eligibility when available and exits 2 without the override. Plan mode does not
inspect remote readiness. See docs/operations.md: Tenant-mode activation guard.

Options:
  --env <name>   Worker environment to deploy (default: production).
  --database-url-env <NAME>
                 Required. Environment variable holding the target database's
                 DIRECT PostgreSQL connection string (not a Hyperdrive string).
                 Checked against --env before any remote call, so a production
                 deploy cannot migrate staging. Accepted names:
                   production  PRODUCTION_DATABASE_URL, NEON_MAIN_DATABASE_URL
                   staging     STAGING_DATABASE_URL, NEON_REHEARSAL_DATABASE_URL
                 Operators source these from ~/.config/reading-lite/neon.env.
  --acknowledge-tenant-migration
                 Override unverified activation only after manually verifying
                 target tenant R2 data, namespaced vectors, and deletion eligibility.
  --release-sha <full SHA>
                 Tag the deployed version after verifying a clean exact checkout.
                 Required when preparing staging evidence for deploy release.
  --execute      Apply pending migrations and upload (otherwise wrangler
                 --dry-run is passed and migrations are only listed).
  --help         Show this message.

Secrets are NOT managed here. Set them once with:
  wrangler secret put AUTH_ROOT_SECRET
  wrangler secret put OPENAI_API_KEY

AUTH_ROOT_SECRET is required at runtime for authentication. READER_API_TOKEN
is imported once by founder bootstrap and is not a runtime auth fallback.
OPENAI_API_KEY is always required; if SUMMARIZER_PROVIDER=anthropic, also set
ANTHROPIC_API_KEY.

A wrangler.toml that binds PostgreSQL (Hyperdrive) for the target environment
is refused until POSTGRES_CUTOVER_ENABLED for that environment is true in
scripts/ops-lib/postgres-cutover.ts (ADR 0005). Plan mode reports the refusal;
--execute exits 2 before the preflight, the migrations or the upload, and also
refuses a placeholder Hyperdrive id.`,
  defaultDeps: (io: CommandIo): DeployWorkerDeps => ({
    io,
    runWrangler: async (wranglerArgs) => {
      const { spawnWrangler } = await import("../../lib/wrangler-cli");
      return new Promise((resolve, reject) => {
        const child = spawnWrangler(wranglerArgs, { stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", (code) => resolve(code ?? 1));
      });
    },
    validateTenantActivation,
    checkPostgresCutover,
    env: process.env,
    readMigrations: () => readMigrations(),
    async connect(databaseUrl) {
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();
      return client;
    },
  }),
  run: runDeployWorker,
};
