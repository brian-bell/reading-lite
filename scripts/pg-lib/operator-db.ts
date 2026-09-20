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
