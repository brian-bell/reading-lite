// The operator-side control plane: which database goes with which data
// bucket, and a `ControlPlaneDb` reaching it over a direct connection.
//
// Single-homed because the pairing is a safety property, not a convenience. A
// query pointed at the wrong control plane answers a question about the wrong
// environment, and that answer is the input to an operator's decision — so an
// unrecognised bucket gets no database rather than a production-shaped guess.
//
// The control plane is PostgreSQL now (ADR 0005), so a bucket no longer names
// a D1 database reached through wrangler; it names the ENVIRONMENT VARIABLE
// that holds a direct connection string. Keeping the indirection at the
// variable, rather than storing a connection string anywhere, is what lets the
// mapping stay checked in: ~/.config/reading-lite/neon.env supplies the
// values, per command, and never enters the repository.
//
// The Neon branches are main (production) and rehearsal (staging, which is
// where #349 rehearses the cutover) — ADR 0005, step 0.

import { sqlFromConnectionString } from "../../src/modules/db/sql";
import { fromSql, type ControlPlaneDb } from "../../src/control-plane/db";

export interface ControlPlaneTarget {
  /** The variable holding this environment's direct connection string. */
  databaseUrlEnv: string;
  env: "production" | "staging";
}

export const CONTROL_PLANE_BY_BUCKET: Record<string, ControlPlaneTarget> = {
  "reading-lite": { databaseUrlEnv: "NEON_MAIN_DATABASE_URL", env: "production" },
  "reading-lite-staging": { databaseUrlEnv: "NEON_REHEARSAL_DATABASE_URL", env: "staging" },
};

export function controlPlaneForBucket(bucket: string): ControlPlaneTarget | undefined {
  return CONTROL_PLANE_BY_BUCKET[bucket];
}

export interface OpenControlPlane {
  db: ControlPlaneDb;
  close(): Promise<void>;
}

function targetOrThrow(bucket: string): ControlPlaneTarget {
  const target = controlPlaneForBucket(bucket);
  if (target === undefined) {
    throw new Error(
      `no control-plane database is mapped to bucket '${bucket}' — ` +
        `known buckets: ${Object.keys(CONTROL_PLANE_BY_BUCKET).join(", ")}`,
    );
  }
  return target;
}

/**
 * Opens the control plane that belongs to `bucket`, with the session to close.
 *
 * Throws rather than defaulting: an operator command that cannot name the
 * control plane for the bucket it is acting on must stop, not pick one. A
 * missing connection string is the same kind of stop — an unset variable is
 * not an empty database.
 */
export function openControlPlaneForBucket(
  bucket: string,
  env: Record<string, string | undefined> = process.env,
  databaseUrlEnvOverride?: string,
): OpenControlPlane {
  const target = targetOrThrow(bucket);
  const envName = databaseUrlEnvOverride ?? target.databaseUrlEnv;
  const url = env[envName]?.trim();
  if (!url) {
    throw new Error(
      `${envName} is not set; it must hold a direct PostgreSQL connection string for ${target.env}. ` +
        "Source ~/.config/reading-lite/neon.env first.",
    );
  }
  const sql = sqlFromConnectionString(url);
  return { db: fromSql(sql), close: () => sql.end() };
}

/**
 * The same handle without the closer, for callers whose shape predates the
 * move and cannot await a close. `pg` connects lazily on the first query, so
 * an unused handle costs nothing; a used one holds its session until the
 * process exits, which for a one-shot CLI is the same moment.
 */
export function controlPlaneDbForBucket(
  bucket: string,
  env: Record<string, string | undefined> = process.env,
  databaseUrlEnvOverride?: string,
): ControlPlaneDb {
  return openControlPlaneForBucket(bucket, env, databaseUrlEnvOverride).db;
}
