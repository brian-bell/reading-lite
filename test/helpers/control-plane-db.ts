// The control plane as a test sees it: a ControlPlaneDb over this file's
// PostgreSQL database (test/apply-control-plane.ts points env.HYPERDRIVE at
// it), for setup rows and assertions. Each call is its own short-lived client,
// so it never holds a connection across a request the test is driving.
import { withControlPlane, type ControlPlaneDb } from "../../src/control-plane/db";
import { toTimestamp } from "../../src/control-plane/pg-time";

export function testControlPlane(env: { HYPERDRIVE: Hyperdrive }): ControlPlaneDb {
  return {
    first: <T>(sql: string, ...params: unknown[]) => withControlPlane(env, (db) => db.first<T>(sql, ...params)),
    all: <T>(sql: string, ...params: unknown[]) => withControlPlane(env, (db) => db.all<T>(sql, ...params)),
    run: (sql, ...params) => withControlPlane(env, (db) => db.run(sql, ...params)),
    batch: (statements) => withControlPlane(env, (db) => db.batch(statements)),
    transaction: (work) => withControlPlane(env, (db) => db.transaction(work)),
  };
}

// An active, verified user for a tenant a test minted, so the consumer's
// tenant-status checks find it. No settings, limits or token.
export async function insertActiveUser(env: { HYPERDRIVE: Hyperdrive }, tenantId: string): Promise<void> {
  const now = toTimestamp(Date.now());
  await testControlPlane(env).run(
    `INSERT INTO users (id, email_canonical, email_display, status, email_verified_at, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    tenantId,
    `${tenantId}@test.example`,
    `${tenantId}@test.example`,
    now,
    now,
    now,
  );
}
