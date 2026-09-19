import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";
import { bootstrapFounder } from "../src/control-plane/bootstrap";
import { parseAuthRootSecret } from "../src/control-plane/crypto";
import { fromD1 } from "../src/control-plane/db";
import { sqlFor, sqlFromConnectionString } from "../src/modules/db/sql";
import {
  databaseOf,
  fileDatabaseName,
  quoteIdentifier,
  templateDatabaseName,
  withDatabase,
} from "./helpers/file-database";
import { FOUNDER_TENANT_ID, OTHER_TENANT_ID } from "./helpers/file-tenants";

// This file's own PostgreSQL database (see helpers/file-database.ts). The
// local Hyperdrive proxy connects to whichever database the client names, so
// the clone is reached by rewriting the binding's connection string.
const boundConnection = env.HYPERDRIVE.connectionString;
const baseDatabase = databaseOf(boundConnection);
const fileDatabase = fileDatabaseName(baseDatabase, crypto.randomUUID());
const admin = sqlFromConnectionString(withDatabase(boundConnection, "postgres"));
try {
  await admin.query(
    `CREATE DATABASE ${quoteIdentifier(fileDatabase)} TEMPLATE ${quoteIdentifier(templateDatabaseName(baseDatabase))}`,
  );
} finally {
  await admin.end();
}
env.HYPERDRIVE = {
  ...env.HYPERDRIVE,
  database: fileDatabase,
  connectionString: withDatabase(boundConnection, fileDatabase),
};

await applyD1Migrations(env.CONTROL_PLANE, env.TEST_MIGRATIONS);
await bootstrapFounder(fromD1(env.CONTROL_PLANE), {
  email: env.FOUNDER_EMAIL ?? "founder@test.example",
  legacyToken: env.READER_API_TOKEN,
  signupMode: "open",
  nowMs: Date.now(),
  authRoot: {
    secret: parseAuthRootSecret(env.AUTH_ROOT_SECRET),
    version: 1,
  },
  // One founder id per test file (see helpers/file-tenants.ts). It predates
  // the per-file database above, which now keeps parallel files apart on its
  // own, so these ids can go back to fixed ones. D1 is per-test storage, so
  // the token id is already fixed.
  newUserId: () => FOUNDER_TENANT_ID,
  newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
});
// Integration suites submit far more than FOUNDER_PLACEHOLDER_LIMITS; keep
// those production placeholders intact and only raise the test tenant.
await env.CONTROL_PLANE.prepare(
  `UPDATE tenant_limits
   SET submissions_per_hour = 100000, monthly_readings = 100000, max_concurrent_work = 100000, daily_spend_microdollars = 100000000000
   WHERE tenant_id = ?`,
)
  .bind(FOUNDER_TENANT_ID)
  .run();

// Spend ceilings here are test fixtures, never production policy defaults.
await env.CONTROL_PLANE.prepare(
  "UPDATE system_policy SET daily_spend_microdollars = 100000000000, catalog_version = 1 WHERE id = 1",
).run();

// PostgreSQL is the one store the pool does not roll back after a test. Clear
// this file's fixed tenants before each one, so a test starts from the same
// empty library the per-test R2 and D1 rollback gives it. Tests that mint
// their own tenant ids need nothing.
beforeEach(async () => {
  const sql = sqlFor(env);
  try {
    await sql.query("DELETE FROM readings WHERE tenant_id = ANY ($1::text[])", [[FOUNDER_TENANT_ID, OTHER_TENANT_ID]]);
  } finally {
    await sql.end();
  }
});
