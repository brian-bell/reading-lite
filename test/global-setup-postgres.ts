// Vitest globalSetup (Node, once per run): bring the shared test database to
// the current schema, then empty the reading tables. Store tests mint a tenant
// id per test, so without the truncate a developer's persistent local database
// would grow without bound.
import pg from "pg";
import { migrate, readMigrations } from "../scripts/pg-lib/migrate";
import { testDatabaseUrl } from "./helpers/test-database";

export default async function setup(): Promise<void> {
  // CI's ops job runs one database-free test file and has no Postgres service.
  if (process.env.SKIP_TEST_POSTGRES === "1") return;
  const url = testDatabaseUrl();
  if (/neon\.tech/.test(url)) throw new Error("Tests never connect to Neon; point TEST_DATABASE_URL at a local Postgres.");
  const admin = new URL(url);
  const database = admin.pathname.slice(1);
  admin.pathname = "/postgres";
  try {
    const bootstrap = new pg.Client({ connectionString: admin.href, connectionTimeoutMillis: 5000 });
    await bootstrap.connect();
    const found = await bootstrap.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (found.rowCount === 0) await bootstrap.query(`CREATE DATABASE "${database.replaceAll('"', '""')}"`);
    await bootstrap.end();
  } catch (error) {
    throw new Error(
      `Test Postgres is unreachable at ${admin.host} (${error instanceof Error ? error.message : String(error)}). ` +
        "Start it with `docker compose up -d postgres` or set TEST_DATABASE_URL.",
    );
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(client, readMigrations());
    // CASCADE covers revisions, URLs, relationships and embeddings.
    await client.query("TRUNCATE readings CASCADE");
  } finally {
    await client.end();
  }
}
