// `ops deploy worker` — deploy the Cloudflare Worker (reading-lite).
// Plan-first: a mode-less run passes wrangler --dry-run (config validation +
// in-place build check, no upload) and prints the secrets the environment must
// already hold; --execute uploads. Before the write, require established
// tenant activation or an explicit manual acknowledgement.
//
// Schema IS deployed from here, replacing the `d1 migrations apply` this
// command used to run. The control plane and readings are on PostgreSQL (ADR
// 0005), and its pending migrations are applied over a direct connection
// string immediately before the upload.
//
// Ordering: cutover guard, then activation preflight, then migrations, then
// upload. Migrations go last among the checks so a deploy that is going to be
// refused changes nothing, and before the upload because a Worker must never
// run against a schema older than the code expects. They are forward-only, so
// the window between a successful migration and a failed upload leaves the
// database ahead of the Worker, which the previous Worker tolerates; the
// reverse would not be true.

import { parseArgs } from "node:util";
import { assertCleanCandidate, ShaSchema } from "../../lib/release-evidence";
import { CONTROL_PLANE_REQUIRED_SECRETS } from "../../control-plane-env";
import { validateTenantActivation } from "../tenant-activation-preflight";
import { checkPostgresCutover } from "../postgres-cutover";
import { migrate, planMigrations, readMigrations, MigrationDriftError } from "../../pg-lib/migrate";
import { operatorDatabaseUrl } from "../../pg-lib/operator-db";
import { sqlFromConnectionString } from "../../../src/modules/db/sql";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export type DeployEnv = "production" | "staging";

/**
 * The variables a deploy may name, per environment.
 *
 * Two spellings each, because two callers reach this command: GitHub Actions
 * holds the connection string as `PRODUCTION_DATABASE_URL`, and an operator
 * deploying by hand sources `~/.config/reading-lite/neon.env`, whose names are
 * the Neon branches. Anything else is unmapped, and an execute refuses it
 * rather than migrating a database nobody named.
 */
export const DEPLOY_DATABASE_URL_ENVS: Readonly<Record<DeployEnv, readonly string[]>> = {
  production: ["PRODUCTION_DATABASE_URL", "NEON_MAIN_DATABASE_URL"],
  staging: ["STAGING_DATABASE_URL", "NEON_REHEARSAL_DATABASE_URL"],
};

/** Which environment a variable names, or null when it names none. */
export function deployDatabaseEnv(databaseUrlEnv: string): DeployEnv | null {
  for (const [env, names] of Object.entries(DEPLOY_DATABASE_URL_ENVS) as [DeployEnv, readonly string[]][]) {
    if (names.includes(databaseUrlEnv)) return env;
  }
  return null;
}

export interface MigrationOutcome {
  applied: string[];
  pending: string[];
}

export interface DeployWorkerDeps extends BaseDeps {
  runWrangler: (args: string[]) => Promise<number>;
  validateCandidate?: (sha: string) => Promise<void>;
  validateTenantActivation: typeof validateTenantActivation;
  checkPostgresCutover: typeof checkPostgresCutover;
  /**
   * Lists pending migrations (plan) or applies them (execute), against the
   * connection string in `databaseUrlEnv`. Injected so the deploy tests never
   * need a database.
   */
  migrateDatabase: (databaseUrlEnv: string, execute: boolean) => Promise<MigrationOutcome>;
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
        execute: { type: "boolean", default: false },
        env: { type: "string", default: "production" },
        "database-url-env": { type: "string", default: "DATABASE_URL" },
        "acknowledge-tenant-migration": { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const env = parseDeployEnv(values.env);
  if (!env) throw new UsageError(`invalid --env: ${values.env}. Expected production or staging.`);
  const execute = values.execute === true;

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
    deps.io.stderr("[PLAN] execute will inspect the active tenant-mode version and R2/Vectorize resource creation metadata before upload; no remote readiness check has run.");
  }

  // Schema before code. A Worker must never run against a schema older than
  // the code expects, and the migrations are forward-only, so the only window
  // this leaves is a migrated database with the previous Worker still serving
  // — which that Worker tolerates.
  const databaseUrlEnv = values["database-url-env"]!;
  const named = deployDatabaseEnv(databaseUrlEnv);
  // An execute must name the database it is about to migrate. The default is
  // the unmapped DATABASE_URL, and the staging Worker is deployed by hand, so
  // without this `ops deploy worker --env staging --execute` with a production
  // string exported as DATABASE_URL applies this repo's pending migrations to
  // production and then uploads the staging Worker.
  //
  // An earlier version of this guard only compared mapped names and so was
  // inert on every real invocation: CI passes PRODUCTION_DATABASE_URL and the
  // default is DATABASE_URL, neither of which it knew.
  if (named === null && execute) {
    deps.io.stderr(
      `[${mode}] migrations: REFUSED. ${databaseUrlEnv} does not name a deploy database. ` +
        `Pass --database-url-env ${DEPLOY_DATABASE_URL_ENVS[env].join(" or ")}.`,
    );
    return 2;
  }
  if (named !== null && named !== env) {
    deps.io.stderr(
      `[${mode}] migrations: REFUSED. --env ${env} but ${databaseUrlEnv} is the ${named} database.`,
    );
    if (execute) return 2;
    // Plan mode stops here too. Falling through would list the migrations of
    // the database it just refused, so the plan would describe work --execute
    // will not do.
    deps.io.stderr("[PLAN] execute would refuse here; not listing migrations or dry-running the deploy.");
    return 0;
  }
  try {
    const outcome = await deps.migrateDatabase(databaseUrlEnv, execute);
    if (execute) {
      deps.io.stderr(
        outcome.applied.length > 0
          ? `[DEPLOY] migrations applied from ${databaseUrlEnv}: ${outcome.applied.join(", ")}`
          : `[DEPLOY] migrations: none pending in ${databaseUrlEnv}`,
      );
    } else {
      deps.io.stderr(
        outcome.pending.length > 0
          ? `[PLAN] would apply ${outcome.pending.length} migration(s) from ${databaseUrlEnv}: ${outcome.pending.join(", ")}`
          : `[PLAN] migrations: none pending in ${databaseUrlEnv}`,
      );
    }
  } catch (error) {
    // A deploy that cannot prove the schema is current must not upload. This
    // is the same fail-closed reasoning as the wipe gate: not being able to
    // see the migrations is not the same as there being none.
    deps.io.stderr(
      `[${mode}] migrations: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (execute) return 2;
    deps.io.stderr("[PLAN] execute would refuse here.");
  }

  return deps.runWrangler(wranglerArgs);
}

export const deployWorkerCommand: CommandDefinition<DeployWorkerDeps> = {
  group: "deploy",
  name: "worker",
  summary: "Deploy the Cloudflare Worker (wrangler deploy)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- deploy worker [--env production|staging] [--execute]

Plans by default: runs \`wrangler deploy --dry-run\` (validates config and
build without uploading) and prints the secrets the environment must already
hold. --execute uploads. Idempotent: re-running with the same source produces
the same Worker version. Does not create the database or import the founder
token.

Applies this repository's pending PostgreSQL migrations immediately before the
upload, over the direct connection string in --database-url-env. Plan mode
lists what it would apply and changes nothing. A migration that fails, or
drift the runner refuses, stops the deploy before the upload: a deploy that
cannot prove the schema is current must not ship code that assumes it is.

Before the upload, tenant mode must already be active with matching
R2/Vectorize bindings and resource creation metadata, or the operator must
acknowledge manual migration verification. Unverified activation prints deletion
eligibility when available and exits 2 without the override. Plan mode does not
inspect remote readiness. See docs/operations.md: Tenant-mode activation guard.

Options:
  --env <name>   Worker environment to deploy (default: production).
  --database-url-env <NAME>
                 Environment variable holding the DIRECT PostgreSQL connection
                 string whose migrations to apply (default: DATABASE_URL).
                 --execute requires one that names the target environment:
                 PRODUCTION_DATABASE_URL or NEON_MAIN_DATABASE_URL for
                 production, STAGING_DATABASE_URL or
                 NEON_REHEARSAL_DATABASE_URL for staging.
  --acknowledge-tenant-migration
                 Override unverified activation only after manually verifying
                 target tenant R2 data, namespaced vectors, and deletion eligibility.
  --release-sha <full SHA>
                 Tag the deployed version after verifying a clean exact checkout.
                 Required when preparing staging evidence for deploy release.
  --execute      Upload (otherwise wrangler --dry-run is passed).
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
--execute exits 2 before the preflight or upload, and also refuses a
placeholder Hyperdrive id.`,
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
    migrateDatabase: async (databaseUrlEnv, execute) => {
      const sql = sqlFromConnectionString(operatorDatabaseUrl(databaseUrlEnv));
      // The runner wants a pg.Client shape; Sql.query returns rows directly.
      const client = { query: async (text: string, values?: unknown[]) => ({ rows: await sql.query(text, values) }) };
      try {
        const files = readMigrations();
        if (!execute) {
          const plan = await planMigrations(client, files);
          return { applied: [], pending: plan.pending.map((f) => `${f.version}_${f.name}`) };
        }
        const applied = await migrate(client, files);
        return { applied: applied.map((f) => `${f.version}_${f.name}`), pending: [] };
      } catch (error) {
        if (error instanceof MigrationDriftError) throw new Error(`REFUSED, drift: ${error.message}`);
        throw error;
      } finally {
        await sql.end();
      }
    },
  }),
  run: runDeployWorker,
};
