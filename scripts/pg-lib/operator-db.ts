// The operator's PostgreSQL seam (reading-lite-gh347.4.7): which database goes
// with which data bucket, how its connection string is named, and how a
// command opens and closes a session on it.
//
// Two safety properties live here, and they are why this is one module rather
// than a helper per command.
//
// The pairing is the first. A query pointed at the wrong database answers a
// question about the wrong environment, and that answer is the input to an
// operator's decision — so an unrecognised bucket gets no database rather than
// a production-shaped guess. This is exactly the property
// scripts/account-lib/control-plane.ts held for D1, carried to PostgreSQL,
// where what is paired is a connection-string VARIABLE rather than a D1
// database name and a wrangler --env.
//
// The variable name is the second. It is the only evidence available before
// connecting, so the check is an allowlist of names per environment rather
// than a pattern — an unrecognised name is refused, not guessed at. That
// deliberately excludes bare DATABASE_URL and NEON_DEV_DATABASE_URL, neither
// of which names a deployed target. `ops db migrate` still defaults to
// DATABASE_URL because it is told its database outright; a command that
// derives its database from a bucket is not.
//
// Connections are DIRECT, never Hyperdrive: Hyperdrive is the Worker's path
// and pools in transaction mode, where session state does not survive between
// statements. Operators source the Neon strings from
// ~/.config/reading-lite/neon.env so no connection string enters the
// repository or the process list.

import type { DeployEnvName } from "../control-plane-env";
import { UsageError } from "../ops-lib/contract";
import { sqlFromConnectionString, type Sql } from "../../src/modules/db/sql";
import { fromSql, type ControlPlaneDb } from "../../src/control-plane/db";
import { LOCAL_DATABASE_URL, LOCAL_DATABASE_URL_ENV } from "./local-postgres";

export interface OperatorDatabaseTarget {
  /** The deploy environment this bucket's data lives in. */
  env: DeployEnvName;
  /** Accepted environment variables holding its DIRECT connection string. */
  databaseUrlEnvs: readonly string[];
}

// PRODUCTION_DATABASE_URL is the same GitHub secret the wipe gate reads; the
// deploy applies migrations through it, so the role behind it needs DDL.
export const OPERATOR_DATABASES: Readonly<Record<string, OperatorDatabaseTarget>> = {
  "reading-lite": {
    env: "production",
    databaseUrlEnvs: ["PRODUCTION_DATABASE_URL", "NEON_MAIN_DATABASE_URL"],
  },
  "reading-lite-staging": {
    env: "staging",
    databaseUrlEnvs: ["STAGING_DATABASE_URL", "NEON_REHEARSAL_DATABASE_URL"],
  },
};

export const DEPLOY_DATABASE_URL_ENVS: Readonly<Record<DeployEnvName, readonly string[]>> =
  Object.fromEntries(
    Object.values(OPERATOR_DATABASES).map((target) => [target.env, target.databaseUrlEnvs]),
  ) as Record<DeployEnvName, readonly string[]>;

export const DATABASE_URL_ENV_FLAG_HELP =
  `  --database-url-env <NAME>
                    Environment variable holding a DIRECT PostgreSQL connection
                    string for the bucket's database (never a Hyperdrive one).
                    Default: the first accepted name for that bucket. For Neon,
                    source ~/.config/reading-lite/neon.env.`;

/**
 * The database that goes with `bucket`.
 *
 * Throws rather than defaulting: an operator command that cannot name the
 * database for the bucket it is acting on must stop, not pick one.
 */
export function databaseTargetForBucket(bucket: string): OperatorDatabaseTarget {
  const target = OPERATOR_DATABASES[bucket];
  if (target === undefined) {
    throw new UsageError(
      `no database is mapped to bucket '${bucket}' — known buckets: ` +
        `${Object.keys(OPERATOR_DATABASES).join(", ")}`,
    );
  }
  return target;
}

/** The deploy environment that goes with a data bucket; no guess for an unknown one. */
export function deployEnvForBucket(bucket: string): DeployEnvName {
  return databaseTargetForBucket(bucket).env;
}

/** The data bucket that goes with a deploy environment. */
export function bucketForDeployEnv(env: DeployEnvName): string {
  const found = Object.entries(OPERATOR_DATABASES).find(([, target]) => target.env === env);
  if (!found) throw new UsageError(`no bucket is mapped to the ${env} environment`);
  return found[0];
}

/** Throws UsageError unless `name` is an accepted variable for `env`. */
export function assertDatabaseUrlEnvMatches(env: DeployEnvName, name: string): void {
  const accepted = DEPLOY_DATABASE_URL_ENVS[env];
  if (accepted.includes(name)) return;
  const other = (Object.keys(DEPLOY_DATABASE_URL_ENVS) as DeployEnvName[]).find((candidate) =>
    DEPLOY_DATABASE_URL_ENVS[candidate].includes(name),
  );
  throw new UsageError(
    other
      ? `--database-url-env ${name} names the ${other} database, but --env is ${env}. ` +
        `Expected one of: ${accepted.join(", ")}.`
      : `--database-url-env ${name} does not name a ${env} database. ` +
        `Expected one of: ${accepted.join(", ")}.`,
  );
}

export interface ResolveDatabaseUrlArgs {
  /** The data bucket the command is acting on. */
  bucket: string;
  /** An explicit --database-url-env, when the operator passed one. */
  databaseUrlEnv?: string | undefined;
  /** --local: this checkout's own PostgreSQL, never a deployed one. */
  local?: boolean;
  env?: Record<string, string | undefined>;
}

export interface ResolvedDatabaseUrl {
  envName: string;
  url: string;
}

/**
 * The connection string for the bucket the command is acting on.
 *
 * `--local` resolves to this checkout's own database, the one `npm run dev`
 * and `npm run seed:local` migrate. It never consults the pairing: a local
 * corpus seeded from production shares reading ids, so falling through to a
 * deployed variable here would act on PRODUCTION during an operation presented
 * as local.
 */
export function resolveOperatorDatabaseUrl(args: ResolveDatabaseUrlArgs): ResolvedDatabaseUrl {
  const env = args.env ?? process.env;
  if (args.local === true) {
    const envName = args.databaseUrlEnv ?? LOCAL_DATABASE_URL_ENV;
    // An explicit --database-url-env is still not allowed to name a deployed
    // database here. Without this the escape hatch reopens exactly the failure
    // --local exists to prevent: the banner says "(local)" while the statements
    // land on production.
    const deployed = Object.entries(OPERATOR_DATABASES).find(([, target]) =>
      target.databaseUrlEnvs.includes(envName),
    );
    if (deployed) {
      throw new UsageError(
        `--database-url-env ${envName} names the ${deployed[1].env} database, which --local must never reach. ` +
          `Use ${LOCAL_DATABASE_URL_ENV}, or drop --local.`,
      );
    }
    const url = env[envName]?.trim();
    if (url) return { envName, url };
    if (args.databaseUrlEnv !== undefined) {
      throw new UsageError(
        `${envName} is not set; it must hold a direct PostgreSQL connection string`,
      );
    }
    return { envName: LOCAL_DATABASE_URL_ENV, url: LOCAL_DATABASE_URL };
  }

  const target = databaseTargetForBucket(args.bucket);
  // Without an explicit name, the first accepted variable that is actually SET
  // wins, not simply the first accepted variable. The names are ordered with
  // the Actions secret first, but an operator at a terminal has sourced
  // ~/.config/reading-lite/neon.env, where only the NEON_ name exists.
  // Demanding the Actions name there would fail every command that exposes no
  // --database-url-env flag of its own, `account wipe` among them. Order still
  // decides when more than one is set, so CI keeps reading its own secret.
  const envName =
    args.databaseUrlEnv ??
    target.databaseUrlEnvs.find((name) => (env[name]?.trim() ?? "") !== "") ??
    target.databaseUrlEnvs[0]!;
  if (!target.databaseUrlEnvs.includes(envName)) {
    const other = Object.entries(OPERATOR_DATABASES).find(([, candidate]) =>
      candidate.databaseUrlEnvs.includes(envName),
    );
    throw new UsageError(
      other
        ? `--database-url-env ${envName} names the ${other[1].env} database, but ` +
          `--bucket ${args.bucket} is ${target.env}. ` +
          `Expected one of: ${target.databaseUrlEnvs.join(", ")}.`
        : `--database-url-env ${envName} does not name the ${target.env} database. ` +
          `Expected one of: ${target.databaseUrlEnvs.join(", ")}.`,
    );
  }
  const url = env[envName]?.trim();
  if (!url) {
    // Nothing was set. Name every accepted variable rather than only the one
    // the default landed on: the operator's next move is to set one of them,
    // and the NEON_ name is the one the documented neon.env carries.
    throw new UsageError(
      args.databaseUrlEnv !== undefined
        ? `${envName} is not set; it must hold a direct PostgreSQL connection string`
        : `none of ${target.databaseUrlEnvs.join(", ")} is set; one must hold a direct ` +
          `PostgreSQL connection string for the ${target.env} database`,
    );
  }
  return { envName, url };
}

export type OpenOperatorSql = (url: string) => Sql;

export const openOperatorSql: OpenOperatorSql = (url) => sqlFromConnectionString(url);

/**
 * Runs `work` on a direct session and closes it on every exit path — success,
 * usage error and failure alike. A command that returned without closing would
 * leave the socket open until the process exits: invisible in a one-shot CLI
 * run, and fatal in a test suite.
 */
export async function withOperatorSql<T>(
  url: string,
  work: (sql: Sql) => Promise<T>,
  open: OpenOperatorSql = openOperatorSql,
): Promise<T> {
  const sql = open(url);
  try {
    return await work(sql);
  } finally {
    // A socket the server already tore down makes end() reject. The work is
    // what the operator needs; losing it to a teardown error would fail a
    // command that succeeded. Matches sqlSession.close and the wipe gate.
    await sql.end().catch(() => undefined);
  }
}

/** The same session, as the control plane's `?`-placeholder handle. */
export async function withOperatorControlPlane<T>(
  url: string,
  work: (db: ControlPlaneDb, sql: Sql) => Promise<T>,
  open: OpenOperatorSql = openOperatorSql,
): Promise<T> {
  return withOperatorSql(url, (sql) => work(fromSql(sql), sql), open);
}
