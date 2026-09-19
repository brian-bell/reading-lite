import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";
import { bootstrapFounder } from "../src/control-plane/bootstrap";
import { parseAuthRootSecret } from "../src/control-plane/crypto";
import { fromD1 } from "../src/control-plane/db";
import { sqlFor } from "../src/modules/db/sql";
import { FOUNDER_TENANT_ID, OTHER_TENANT_ID } from "./helpers/file-tenants";

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
  // One founder per test file, so parallel files never share PostgreSQL rows
  // (see helpers/file-tenants.ts). D1 is per-test storage, so the token id can
  // stay fixed.
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
