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

const READING_TABLES = [
  "reading_attempts",
  "reading_embeddings",
  "reading_jobs",
  "reading_relationships",
  "reading_revisions",
  "reading_urls",
  "readings",
];

describe("reading schema", () => {
  it("creates the reading tables, every one led by tenant_id in its primary key", async () => {
    const result = await client.query(
      `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu USING (constraint_schema, constraint_name)
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
         AND tc.table_name LIKE 'reading%' AND kcu.ordinal_position = 1
       ORDER BY tc.table_name`,
    );
    expect(result.rows).toEqual(READING_TABLES.map((table_name) => ({ table_name, column_name: "tenant_id" })));
  });

  // The control-plane tables (control-plane-schema.test.ts) key on the user.
  it("includes tenant_id in every reading foreign key", async () => {
    const result = await client.query(
      `SELECT c.conname FROM pg_constraint c
       WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
         AND c.conrelid::regclass::text LIKE 'reading%'
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

describe("inbox schema", () => {
  const URL_HASH = "a".repeat(64);
  const insert = (markdown: string, urlHash = URL_HASH) =>
    client.query(
      `INSERT INTO inbox_items (tenant_id, id, url, url_hash, markdown, created_at, updated_at)
       VALUES ('t_schema', 'in_schema', 'https://example.com/', $1, $2, now(), now())`,
      [urlHash, markdown],
    );
  // Each case rolls back, so nothing reaches the shared database.
  const inTransaction = async (work: () => Promise<unknown>) => {
    await client.query("BEGIN");
    try {
      await work();
    } finally {
      await client.query("ROLLBACK");
    }
  };

  it("leads the primary key with tenant_id and holds one item per tenant URL", async () => {
    const pk = await client.query(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu USING (constraint_schema, constraint_name)
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = 'inbox_items'
       ORDER BY kcu.ordinal_position`,
    );
    expect(pk.rows).toEqual([{ column_name: "tenant_id" }, { column_name: "id" }]);
    const unique = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'inbox_items'::regclass AND contype = 'u'`,
    );
    expect(unique.rows).toEqual([{ def: "UNIQUE (tenant_id, url_hash)" }]);
  });

  // Bytes, not characters: "é" is two bytes in UTF-8.
  it("caps markdown at 128_000 bytes", async () => {
    await inTransaction(() => insert("é".repeat(64_000)));
    await expect(inTransaction(() => insert(`${"é".repeat(64_000)}a`))).rejects.toThrow(/inbox_items_markdown_check/);
    await expect(inTransaction(() => insert(""))).rejects.toThrow(/inbox_items_markdown_check/);
  });

  it("requires a sha256 url_hash", async () => {
    await expect(inTransaction(() => insert("# hi", "not-a-hash"))).rejects.toThrow(/inbox_items_url_hash_check/);
  });
});
