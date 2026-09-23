import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MigrationDriftError,
  migrate,
  planMigrations,
  readMigrations,
  type MigrationFile,
} from "../../../scripts/pg-lib/migrate";
import { testDatabaseUrl } from "../../helpers/test-database";

// A scratch database per file: the shared test database already carries the
// real schema_migrations, and these cases need to start from nothing.
const scratch = `migrate_${randomUUID().replaceAll("-", "")}`;
let admin: pg.Client;

function file(version: string, name: string, sql: string): MigrationFile {
  return { version, name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
}

async function freshDatabase(): Promise<pg.Client> {
  const name = `${scratch}_${randomUUID().slice(0, 8)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  return client;
}

// CREATE and DROP DATABASE are cluster-wide and queue behind the workers
// pool's per-file template clones, which run concurrently against the same
// server; on CI that wait outlasts Vitest's 5s test and 10s hook defaults.
const DATABASE_DDL_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: testDatabaseUrl() });
  await admin.connect();
}, DATABASE_DDL_TIMEOUT_MS);

afterAll(async () => {
  const found = await admin.query("SELECT datname FROM pg_database WHERE datname LIKE $1", [`${scratch}%`]);
  for (const row of found.rows) await admin.query(`DROP DATABASE ${row.datname} WITH (FORCE)`);
  await admin.end();
}, DATABASE_DDL_TIMEOUT_MS);

describe("PostgreSQL migration runner", { timeout: DATABASE_DDL_TIMEOUT_MS }, () => {
  it("applies pending files in order, records them, and is idempotent", async () => {
    const client = await freshDatabase();
    const files = [
      file("0001", "first", "CREATE TABLE a (id int)"),
      file("0002", "second", "ALTER TABLE a ADD COLUMN note text"),
    ];
    expect((await planMigrations(client, files)).pending.map((f) => f.version)).toEqual(["0001", "0002"]);
    expect((await migrate(client, files)).map((f) => f.version)).toEqual(["0001", "0002"]);
    const recorded = await client.query("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
    expect(recorded.rows).toEqual(files.map(({ version, name, checksum }) => ({ version, name, checksum })));

    expect(await migrate(client, files)).toEqual([]);
    const next = [...files, file("0003", "third", "CREATE TABLE b (id int)")];
    expect((await migrate(client, next)).map((f) => f.version)).toEqual(["0003"]);
    await client.end();
  });

  it("refuses when an applied file changed, was renamed, disappeared, or a pending one is older", async () => {
    const client = await freshDatabase();
    const applied = [file("0002", "second", "CREATE TABLE a (id int)")];
    await migrate(client, applied);
    await expect(migrate(client, [file("0002", "second", "CREATE TABLE a (id bigint)")])).rejects.toBeInstanceOf(
      MigrationDriftError,
    );
    await expect(migrate(client, [file("0002", "renamed", "CREATE TABLE a (id int)")])).rejects.toThrow(
      /0002_second was renamed to 0002_renamed/,
    );
    await expect(migrate(client, [])).rejects.toBeInstanceOf(MigrationDriftError);
    await expect(migrate(client, [file("0001", "late", "SELECT 1"), ...applied])).rejects.toBeInstanceOf(
      MigrationDriftError,
    );
    await client.end();
  });

  it("rolls a failing file back, stops there, and keeps earlier files", async () => {
    const client = await freshDatabase();
    const files = [
      file("0001", "ok", "CREATE TABLE kept (id int)"),
      file("0002", "broken", "CREATE TABLE half (id int); SELECT * FROM missing_table"),
      file("0003", "never", "CREATE TABLE never (id int)"),
    ];
    await expect(migrate(client, files)).rejects.toThrow(/0002_broken failed/);
    const tables = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(["kept", "schema_migrations"]);
    const recorded = await client.query("SELECT version FROM schema_migrations");
    expect(recorded.rows).toEqual([{ version: "0001" }]);
    await client.end();
  });

  it("plans without creating anything", async () => {
    const client = await freshDatabase();
    await planMigrations(client, [file("0001", "first", "CREATE TABLE a (id int)")]);
    const found = await client.query("SELECT to_regclass('schema_migrations') AS t");
    expect(found.rows[0].t).toBeNull();
    await client.end();
  });

  it("applies the checked-in migrations to an empty database", async () => {
    const client = await freshDatabase();
    const files = readMigrations();
    expect((await migrate(client, files)).length).toBe(files.length);
    await client.end();
  });
});
