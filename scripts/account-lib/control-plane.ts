// The operator-side control plane: which D1 database goes with which data
// bucket, and a `ControlPlaneDb` reaching it through wrangler.
//
// Single-homed because the pairing is a safety property, not a convenience. A
// query pointed at the wrong control plane answers a question about the wrong
// environment, and that answer is the input to an operator's decision — so an
// unrecognised bucket gets no database rather than a production-shaped guess.
// `ops account sweep-wipe-prefix` reads it to offer a scoped query;
// `ops corpus seed-vector-ledger` writes ledger rows through it.

import { makeWranglerD1 } from "../lib/founder-bootstrap";
import type { ControlPlaneDb } from "../../src/control-plane/db";

export interface ControlPlaneTarget {
  database: string;
  /** The wrangler `--env` the database is declared under. */
  env: "production" | "staging";
}

export const CONTROL_PLANE_BY_BUCKET: Record<string, ControlPlaneTarget> = {
  "reading-lite": { database: "reading-lite-control", env: "production" },
  "reading-lite-staging": { database: "reading-lite-control-staging", env: "staging" },
};

export function controlPlaneForBucket(bucket: string): ControlPlaneTarget | undefined {
  return CONTROL_PLANE_BY_BUCKET[bucket];
}

/**
 * A remote `ControlPlaneDb` for the control plane that belongs to `bucket`.
 *
 * Throws rather than defaulting: an operator command that cannot name the
 * control plane for the bucket it is acting on must stop, not pick one.
 */
export function controlPlaneDbForBucket(
  bucket: string,
  run?: (args: string[]) => Promise<{ stdout: string; code: number; stderr: string }>,
): ControlPlaneDb {
  const target = controlPlaneForBucket(bucket);
  if (target === undefined) {
    throw new Error(
      `no control-plane database is mapped to bucket '${bucket}' — ` +
        `known buckets: ${Object.keys(CONTROL_PLANE_BY_BUCKET).join(", ")}`,
    );
  }
  return makeWranglerD1({
    database: target.database,
    wranglerEnv: target.env,
    local: false,
    ...(run ? { run } : {}),
  });
}
