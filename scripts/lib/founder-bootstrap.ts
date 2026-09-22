// Founder-bootstrap library: argument parsing, the idempotent bootstrap run,
// and the PostgreSQL connection it writes through (ADR 0005).
// The operator entry point is `ops founder bootstrap`
// (scripts/ops-lib/commands/founder-bootstrap.ts); dev-setup and
// cloud-agent-install reuse the same run function.
import { parseArgs } from "node:util";
import { bootstrapFounder, signupModeForEnv, type SignupMode } from "../../src/control-plane/bootstrap";
import { parseAuthRootKeyVersion, parseAuthRootSecret } from "../../src/control-plane/crypto";
import { redactEmail } from "../../src/control-plane/email";
import { fromSql, type ControlPlaneDb } from "../../src/control-plane/db";
import { sqlFromConnectionString } from "../../src/modules/db/sql";
import { localDatabase } from "../pg-lib/local-postgres";
import { bucketForDeployEnv, resolveOperatorDatabaseUrl } from "../pg-lib/operator-db";
import { UsageError } from "../ops-lib/contract";
import { loadDotVars } from "./dotvars";

export type BootstrapEnvName = "local" | "staging" | "production";

export interface FounderBootstrapCliArgs {
  execute: boolean;
  email?: string;
  env: BootstrapEnvName;
  confirmProduction: boolean;
  // Staging and production: the environment variable holding a DIRECT
  // PostgreSQL connection string, checked against the operator-db pairing.
  // Omitted, the pairing picks whichever accepted name is set. Local uses the
  // dev database.
  databaseUrlEnv?: string | undefined;
}

export interface FounderBootstrapRunResult {
  exitCode: number;
}

export interface OpenedControlPlane {
  db: ControlPlaneDb;
  close(): Promise<void>;
}

export interface FounderBootstrapDeps {
  envVars: Record<string, string | undefined>;
  nowMs: number;
  write: (line: string) => void;
  openDb: (databaseUrl: string) => Promise<OpenedControlPlane>;
}

// A direct connection, never Hyperdrive: the bootstrap's advisory lock and
// transaction need one session.
export async function openPostgresControlPlane(databaseUrl: string): Promise<OpenedControlPlane> {
  const sql = sqlFromConnectionString(databaseUrl);
  return { db: fromSql(sql), close: () => sql.end() };
}

// Where the founder goes: the local dev database, or the environment's paired
// database for staging and production. The pairing is what stops a staging
// bootstrap writing its founder and token into production (or a local
// DATABASE_URL); it throws UsageError on an unset or mis-paired variable.
export function founderDatabaseUrl(
  args: Pick<FounderBootstrapCliArgs, "env" | "databaseUrlEnv">,
  envVars: Record<string, string | undefined>,
): string {
  if (args.env === "local") return localDatabase(envVars).url;
  return resolveOperatorDatabaseUrl({
    bucket: bucketForDeployEnv(args.env),
    databaseUrlEnv: args.databaseUrlEnv,
    env: envVars,
  }).url;
}

// Staging's database is the #349 rehearsal target. The #348 importer refuses a
// target holding any application row, and a bootstrapped founder would
// conflict with the imported one. There is no code gate; the rule is stated
// wherever staging bootstrap comes up.
export const STAGING_BOOTSTRAP_PROHIBITION =
  "Do not run founder bootstrap against staging before the #349 import: the #348 importer " +
  "refuses a database that already holds application rows.";

const ENV_NAMES = new Set<BootstrapEnvName>(["local", "staging", "production"]);

export const DOTVARS_BY_ENV: Record<BootstrapEnvName, string> = {
  local: ".dev.vars",
  staging: ".stg.vars",
  production: ".prd.vars",
};

export function parseFounderBootstrapArgs(
  argv: string[] = process.argv.slice(2),
): FounderBootstrapCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      execute: { type: "boolean", default: false },
      email: { type: "string" },
      env: { type: "string", default: "local" },
      "confirm-production": { type: "boolean", default: false },
      "database-url-env": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    throw new HelpRequested();
  }
  const env = values.env ?? "local";
  if (!ENV_NAMES.has(env as BootstrapEnvName)) {
    throw new Error(`unknown --env ${env} (expected local|staging|production)`);
  }
  return {
    execute: values.execute === true,
    ...(values.email ? { email: values.email } : {}),
    env: env as BootstrapEnvName,
    confirmProduction: values["confirm-production"] === true,
    ...(values["database-url-env"] ? { databaseUrlEnv: values["database-url-env"] } : {}),
  };
}

export class HelpRequested extends Error {
  constructor() {
    super("help");
  }
}

export async function runFounderBootstrap(
  args: FounderBootstrapCliArgs,
  deps: FounderBootstrapDeps,
): Promise<FounderBootstrapRunResult> {
  if (args.env === "production" && args.execute && !args.confirmProduction) {
    deps.write("refusing production write without --confirm-production\n");
    return { exitCode: 2 };
  }

  const email = args.email ?? deps.envVars.FOUNDER_EMAIL;
  const legacyToken = deps.envVars.READER_API_TOKEN;
  const rootSecret = deps.envVars.AUTH_ROOT_SECRET;
  if (!email) {
    deps.write("missing founder email (pass --email or set FOUNDER_EMAIL)\n");
    return { exitCode: 2 };
  }
  if (!legacyToken) {
    deps.write("missing READER_API_TOKEN\n");
    return { exitCode: 2 };
  }
  if (!rootSecret) {
    deps.write("missing AUTH_ROOT_SECRET\n");
    return { exitCode: 2 };
  }

  let databaseUrl: string;
  try {
    databaseUrl = founderDatabaseUrl(args, deps.envVars);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    deps.write(`${error.message}\n`);
    return { exitCode: 2 };
  }

  const signupMode: SignupMode = signupModeForEnv(args.env);
  const opened = await deps.openDb(databaseUrl);
  const previousRootSecret = deps.envVars.AUTH_PREVIOUS_ROOT_SECRET;
  const result = await bootstrapFounder(
    opened.db,
    {
      email,
      legacyToken,
      signupMode,
      nowMs: deps.nowMs,
      authRoot: {
        secret: parseAuthRootSecret(rootSecret),
        version: parseAuthRootKeyVersion(deps.envVars.AUTH_ROOT_KEY_VERSION),
      },
      ...(previousRootSecret
        ? {
            previousAuthRoot: {
              secret: parseAuthRootSecret(previousRootSecret),
              version: parseAuthRootKeyVersion(deps.envVars.AUTH_PREVIOUS_ROOT_KEY_VERSION),
            },
          }
        : {}),
    },
    { apply: args.execute },
  ).finally(() => opened.close());

  deps.write(`founder email: ${redactEmail(email)}\n`);
  deps.write(`environment:   ${args.env} (signup_mode=${signupMode})\n`);
  deps.write(`user:          ${result.userId} (${result.createdUser ? "create" : "resolve"})\n`);
  deps.write(`legacy token:  ${result.tokenId} (${result.createdToken ? "import" : "resolve"})\n`);
  for (const action of result.actions) {
    deps.write(`  - ${action}\n`);
  }

  if (!args.execute) {
    deps.write("\n[DRY RUN] not writing. Pass --execute to apply.\n");
    return { exitCode: 0 };
  }
  deps.write("\n[EXECUTE] founder principal and imported legacy token are in PostgreSQL.\n");
  return { exitCode: 0 };
}

export function resolveEnvVars(env: BootstrapEnvName): Record<string, string | undefined> {
  return {
    ...loadDotVars(DOTVARS_BY_ENV[env]),
    ...process.env,
  };
}
