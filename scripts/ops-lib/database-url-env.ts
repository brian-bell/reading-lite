// Which environment variable may hold the connection string for which deploy
// environment (reading-lite-gh347.4.4).
//
// `ops deploy worker` migrates the database it is about to deploy code
// against, so the pairing is load-bearing: a production deploy pointed at the
// staging string would migrate the wrong database and then upload anyway. The
// variable NAME is the only evidence available before connecting, so the check
// is an allowlist of names per environment rather than a pattern — an
// unrecognised name is refused, not guessed at. That deliberately excludes
// bare DATABASE_URL and NEON_DEV_DATABASE_URL, neither of which names a
// deploy target.

import type { DeployEnvName } from "../control-plane-env";
import { UsageError } from "./contract";

export const DEPLOY_DATABASE_URL_ENVS: Readonly<Record<DeployEnvName, readonly string[]>> = {
  // PRODUCTION_DATABASE_URL is the same GitHub secret the wipe gate reads; the
  // deploy applies migrations through it, so the role behind it needs DDL.
  production: ["PRODUCTION_DATABASE_URL", "NEON_MAIN_DATABASE_URL"],
  staging: ["STAGING_DATABASE_URL", "NEON_REHEARSAL_DATABASE_URL"],
};

/** Throws UsageError unless `name` is an accepted variable for `env`. */
export function assertDatabaseUrlEnvMatches(env: DeployEnvName, name: string): void {
  if (DEPLOY_DATABASE_URL_ENVS[env].includes(name)) return;
  const other = (Object.keys(DEPLOY_DATABASE_URL_ENVS) as DeployEnvName[]).find((candidate) =>
    DEPLOY_DATABASE_URL_ENVS[candidate].includes(name),
  );
  throw new UsageError(
    other
      ? `--database-url-env ${name} names the ${other} database, but --env is ${env}. ` +
        `Expected one of: ${DEPLOY_DATABASE_URL_ENVS[env].join(", ")}.`
      : `--database-url-env ${name} does not name a ${env} database. ` +
        `Expected one of: ${DEPLOY_DATABASE_URL_ENVS[env].join(", ")}.`,
  );
}
