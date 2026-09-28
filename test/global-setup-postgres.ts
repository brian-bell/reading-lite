// Vitest globalSetup (Node, once per run): bring the test databases to the
// current schema. There are two. The base database serves the Node pool, where
// each test rolls back its own transaction (helpers/pg-rollback.ts) or mints a
// tenant id; its reading tables are emptied here so a developer's persistent
// local database does not grow without bound. The template is what each
// workers-pool file clones (helpers/file-database.ts); it stays empty, and the
// clones are dropped when the run ends.
import pg from "pg";
import { migrate, readMigrations } from "../scripts/pg-lib/migrate";
import {
  databaseOf,
  fileDatabasePrefix,
  quoteIdentifier,
  templateDatabaseName,
  withDatabase,
} from "./helpers/file-database";
import { hostEnv, testDatabaseUrl } from "./helpers/test-database";

async function withClient<T>(connectionString: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

// A killed run never reaches teardown, so this also runs before the next one.
async function dropFileDatabases(admin: pg.Client, base: string): Promise<void> {
  const found = await admin.query("SELECT datname FROM pg_database WHERE starts_with(datname, $1)", [
    fileDatabasePrefix(base),
  ]);
  for (const row of found.rows) {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(row.datname)} WITH (FORCE)`);
  }
}

export default async function setup(): Promise<(() => Promise<void>) | void> {
  // CI's ops job runs one database-free test file and has no Postgres service.
  if (hostEnv().SKIP_TEST_POSTGRES === "1") return;
  const url = testDatabaseUrl();
  if (/neon\.tech/.test(url)) throw new Error("Tests never connect to Neon; point TEST_DATABASE_URL at a local Postgres.");
  const base = databaseOf(url);
  const template = templateDatabaseName(base);
  const adminUrl = withDatabase(url, "postgres");
  try {
    await withClient(adminUrl, async (admin) => {
      await dropFileDatabases(admin, base);
      for (const database of [base, template]) {
        const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
        if (found.rowCount === 0) await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
      }
    });
  } catch (error) {
    throw new Error(
      `Test Postgres is unreachable at ${new URL(adminUrl).host} (${error instanceof Error ? error.message : String(error)}). ` +
        "Start it with `docker compose up -d postgres` or set TEST_DATABASE_URL.",
    );
  }
  const migrations = readMigrations();
  await withClient(withDatabase(url, template), (client) => migrate(client, migrations));
  await withClient(url, async (client) => {
    await migrate(client, migrations);
    // CASCADE covers revisions, URLs, relationships and embeddings.
    await client.query("TRUNCATE readings CASCADE");
    await client.query("TRUNCATE inbox_items");
    // Node-pool tests roll their control-plane rows back, but a test that
    // commits one (or a killed run) must not leave it for every later run to
    // see: control-plane assertions read whole tables.
    await client.query(
      `TRUNCATE users, user_settings, tenant_limits, api_tokens, api_token_scopes, system_policy, sessions,
         auth_challenges, signup_invites, dev_mail_outbox, digest_deliveries, relationship_refresh_jobs,
         tension_refresh_jobs, wipe_progress, account_deletions, archive_exports RESTART IDENTITY`,
    );
  });

  return () => withClient(adminUrl, (admin) => dropFileDatabases(admin, base));
}
