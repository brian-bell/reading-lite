import { env } from "cloudflare:test";
import { beforeEach } from "vitest";
import { bootstrapFounder } from "../src/control-plane/bootstrap";
import { parseAuthRootSecret } from "../src/control-plane/crypto";
import { fromSql } from "../src/control-plane/db";
import { GlobalUsageGuard } from "../src/control-plane/global-usage-guard";
import { TenantUsageGuard } from "../src/control-plane/tenant-usage-guard";
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

// The Durable Object guards read policy and tenant limits from PostgreSQL
// through their own `env`, which the runtime builds from the pool's binding
// and so names the base database, not this file's clone (the spike found the
// same of SELF). They run in this file's isolate and module graph, so point
// each instance at the clone as it handles a call.
for (const guard of [TenantUsageGuard, GlobalUsageGuard] as const) {
  const proto = guard.prototype as unknown as Record<string, unknown>;
  for (const method of ["fetch", "alarm"]) {
    const original = proto[method];
    if (typeof original !== "function") continue;
    proto[method] = function (this: { env: { HYPERDRIVE: Hyperdrive } }, ...args: unknown[]) {
      this.env = { ...this.env, HYPERDRIVE: env.HYPERDRIVE };
      return original.apply(this, args);
    };
  }
}

// The control-plane tables (db/migrations/0003).
const CONTROL_PLANE_TABLES = [
  "users",
  "user_settings",
  "tenant_limits",
  "api_tokens",
  "api_token_scopes",
  "system_policy",
  "sessions",
  "auth_challenges",
  "signup_invites",
  "dev_mail_outbox",
  "digest_deliveries",
  "relationship_refresh_jobs",
  "wipe_progress",
  "account_deletions",
].join(", ");

// PostgreSQL is outside the pool's per-test rollback, which D1 used to give
// the control plane. So every test starts from the state a fresh D1 gave it:
// empty control-plane tables, then the founder bootstrap, with the test
// tenant's limits raised and a spend ceiling set. The fixed tenants' readings
// are cleared too, matching the per-test R2 rollback; readings a file seeds
// for its own tenants in beforeAll (parity.test.ts) are left alone.
beforeEach(async () => {
  const sql = sqlFor(env);
  try {
    await sql.query(`TRUNCATE ${CONTROL_PLANE_TABLES} RESTART IDENTITY`);
    await sql.query("DELETE FROM readings WHERE tenant_id = ANY ($1::text[])", [[FOUNDER_TENANT_ID, OTHER_TENANT_ID]]);
    const db = fromSql(sql);
    await bootstrapFounder(db, {
      email: env.FOUNDER_EMAIL ?? "founder@test.example",
      legacyToken: env.READER_API_TOKEN,
      signupMode: "open",
      nowMs: Date.now(),
      authRoot: {
        secret: parseAuthRootSecret(env.AUTH_ROOT_SECRET),
        version: 1,
      },
      newUserId: () => FOUNDER_TENANT_ID,
      newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
    });
    // Integration suites submit far more than FOUNDER_PLACEHOLDER_LIMITS; keep
    // those production placeholders intact and only raise the test tenant.
    await db.run(
      `UPDATE tenant_limits
       SET submissions_per_hour = 100000, monthly_readings = 100000, max_concurrent_work = 100000,
           daily_spend_microdollars = 100000000000
       WHERE tenant_id = ?`,
      FOUNDER_TENANT_ID,
    );
    // Spend ceilings here are test fixtures, never production policy defaults.
    await db.run("UPDATE system_policy SET daily_spend_microdollars = 100000000000, catalog_version = 1 WHERE id = 1");
  } finally {
    await sql.end();
  }
});
