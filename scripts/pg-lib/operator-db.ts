// How an operator command reaches PostgreSQL (ADR 0005, reading-lite-gh347.4).
//
// A DIRECT connection string, never Hyperdrive: Hyperdrive is the Worker's
// pooled path and pools in transaction mode, so session state — advisory
// locks, SET, a long-lived READ ONLY transaction — does not survive between
// statements. Operator work wants a session.
//
// The string is read from a NAMED ENVIRONMENT VARIABLE rather than a flag, so
// it never reaches shell history, `ps`, or a command echoed into a runbook.
// Operators keep the Neon strings in ~/.config/reading-lite/neon.env and
// source it per command; CI passes the deploy secret the same way. The
// convention is single-homed here and shared by `ops db migrate` and `ops
// founder bootstrap`.

import { sqlFromConnectionString, type Sql } from "../../src/modules/db/sql";
import { UsageError } from "../ops-lib/contract";

export const DATABASE_URL_ENV_DEFAULT = "DATABASE_URL";

export const DATABASE_URL_ENV_HELP = `--database-url-env <NAME>
                 Environment variable holding a DIRECT PostgreSQL connection
                 string (default: ${DATABASE_URL_ENV_DEFAULT}). Not a Hyperdrive
                 string. For Neon: source ~/.config/reading-lite/neon.env and
                 pass NEON_DEV_DATABASE_URL, NEON_REHEARSAL_DATABASE_URL or
                 NEON_MAIN_DATABASE_URL.`;

/** The parseArgs option every ported command adds, so the spelling cannot drift. */
export const DATABASE_URL_ENV_OPTION = {
  type: "string",
  default: DATABASE_URL_ENV_DEFAULT,
} as const;

/**
 * Resolves the connection string from the named variable, failing closed as a
 * UsageError (exit 2) before any command plans or connects. The value itself
 * is never echoed — only the variable's name — so a mistyped name is
 * diagnosable without printing a credential.
 */
export function operatorDatabaseUrl(
  envName: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env[envName]?.trim();
  if (!value) {
    throw new UsageError(
      `${envName} is not set; it must hold a direct PostgreSQL connection string. ` +
        "Source ~/.config/reading-lite/neon.env and pass --database-url-env with the variable you want.",
    );
  }
  return value;
}

/**
 * True when the connection string points at this machine.
 *
 * `--local` used to scope a whole command, because the only stores it touched
 * were the local miniflare bucket and (deliberately) never Vectorize. Now the
 * destructive half of `corpus drop` and `corpus sweep` is a DELETE against
 * whatever the named variable holds, so `--local` and a production
 * DATABASE_URL exported in the shell would delete production rows while
 * deleting objects from the local bucket. Commands that offer `--local` check
 * this before any write.
 */
export function isLocalDatabaseUrl(databaseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export class NonLocalDatabaseError extends UsageError {}

/**
 * Refuses a run whose bucket and database name different environments.
 *
 * `--bucket` used to scope everything destructive a corpus command did, so
 * "refuse --allow-ready against the production bucket" was a complete guard.
 * It is not any more: the delete is a row delete against whatever
 * `--database-url-env` names, which is independent of the bucket. Without this,
 * `--bucket reading-lite-staging` with DATABASE_URL still exported as the
 * production string deletes production rows while deleting staging objects.
 *
 * Only two mapped names disagreeing is an error. An unmapped variable — the
 * DATABASE_URL default, a local database, a scratch branch — is left alone,
 * because this cannot know what the operator meant and guessing would refuse
 * legitimate local runs.
 */
export function assertBucketAndDatabaseAgree(
  bucket: string,
  databaseUrlEnv: string,
  mapping: Record<string, { databaseUrlEnv: string; env: string }>,
): void {
  const forBucket = mapping[bucket];
  if (!forBucket) return;
  const named = Object.values(mapping).find((target) => target.databaseUrlEnv === databaseUrlEnv);
  if (!named || named.databaseUrlEnv === forBucket.databaseUrlEnv) return;
  throw new UsageError(
    `--bucket ${bucket} holds ${forBucket.env} content, but ${databaseUrlEnv} is the ${named.env} ` +
      `database. Refusing: the row deletes would land on ${named.env} while the object deletes ` +
      `landed on ${forBucket.env}.`,
  );
}

/** Refuses a `--local` run pointed at a database that is not on this machine. */
export function requireLocalDatabase(databaseUrl: string, envName: string): void {
  if (!isLocalDatabaseUrl(databaseUrl)) {
    throw new NonLocalDatabaseError(
      `--local reads the local miniflare bucket, but ${envName} names a non-local database. ` +
        "Refusing: the deletes would land on that database while the objects came from the local bucket. " +
        "Drop --local, or point --database-url-env at your local Postgres.",
    );
  }
}

/**
 * Opens one session for the duration of `run` and always closes it, including
 * when `run` throws. A command that leaves a Neon session open holds a
 * connection slot until the idle timeout.
 */
export async function withOperatorSql<T>(
  databaseUrl: string,
  run: (sql: Sql) => Promise<T>,
  open: (url: string) => Sql = sqlFromConnectionString,
): Promise<T> {
  const sql = open(databaseUrl);
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}
