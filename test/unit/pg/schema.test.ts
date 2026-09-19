import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../../helpers/test-database";

// Reads the shared test database, which globalSetup has already migrated.
let client: pg.Client;
beforeAll(async () => {
  client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
});
afterAll(() => client.end());

const READING_TABLES = ["reading_embeddings", "reading_relationships", "reading_revisions", "reading_urls", "readings"];

describe("reading schema", () => {
  it("creates the reading tables, every one led by tenant_id in its primary key", async () => {
    const result = await client.query(
      `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu USING (constraint_schema, constraint_name)
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
         AND tc.table_name <> 'schema_migrations' AND kcu.ordinal_position = 1
       ORDER BY tc.table_name`,
    );
    expect(result.rows).toEqual(READING_TABLES.map((table_name) => ({ table_name, column_name: "tenant_id" })));
  });

  it("includes tenant_id in every foreign key", async () => {
    const result = await client.query(
      `SELECT c.conname FROM pg_constraint c
       WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
         AND NOT EXISTS (
           SELECT 1 FROM pg_attribute a
           WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1] AND a.attname = 'tenant_id')`,
    );
    expect(result.rows).toEqual([]);
  });

  it("stores 1536-dimension embeddings and rejects any other size", async () => {
    const dim = await client.query(
      `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
       WHERE attrelid = 'reading_embeddings'::regclass AND attname = 'embedding'`,
    );
    expect(dim.rows).toEqual([{ type: "vector(1536)" }]);
    await expect(
      client.query("INSERT INTO reading_embeddings (tenant_id, reading_id, embedding) VALUES ('t', 'r', '[1,2,3]')"),
    ).rejects.toThrow(/expected 1536 dimensions/);
  });
});
