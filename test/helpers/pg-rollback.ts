// Node-pool isolation for PostgreSQL tests (ADR 0005). The Node pool shares one
// migrated database across parallel files, so each test runs inside a
// transaction that is rolled back afterwards: nothing it writes is ever visible
// to another test, and global uniques (a founder email, the system_policy
// singleton) cannot collide. Two tests that insert the same unique key at once
// do not fail; the second waits for the first to roll back.
//
// Code under test that opens its own transaction gets a SAVEPOINT instead, so
// its commit and rollback behave as they would at the top level.
//
// Outside such a transaction, each statement runs in a savepoint of its own.
// Production runs those statements in autocommit, where a caught failure does
// not affect the next one; without the savepoint, PostgreSQL would abort the
// outer transaction and fail everything after it with 25P02. Inside a
// transaction the statements run bare, as they do in production, so code that
// carries on after a failed statement there still fails here too.
import { afterEach, beforeEach } from "vitest";
import { sqlFromConnectionString, type Sql, type SqlQuery } from "../../src/modules/db/sql";
import { testDatabaseUrl } from "./test-database";

async function inSavepoint<T>(client: Sql, name: string, work: () => Promise<T>): Promise<T> {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const out = await work();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return out;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

// Call at the top of a describe block or file. Returns the current test's Sql.
export function useRolledBackSql(): () => Sql {
  let outer: Sql | null = null;
  let current: Sql | null = null;

  beforeEach(async () => {
    const client = sqlFromConnectionString(testDatabaseUrl());
    await client.query("BEGIN");
    outer = client;
    let depth = 0;
    const handle: SqlQuery = { query: client.query, execute: client.execute };
    current = {
      query: (text, values) => inSavepoint(client, "autocommit", () => client.query(text, values)),
      execute: (text, values) => inSavepoint(client, "autocommit", () => client.execute(text, values)),
      async transaction(run, opts = {}) {
        // READ ONLY cannot be undone inside the outer transaction, and no
        // control-plane caller asks for it.
        if (opts.readOnly) throw new Error("useRolledBackSql does not support read-only transactions");
        try {
          return await inSavepoint(client, `nested_${++depth}`, () => run(handle));
        } finally {
          depth--;
        }
      },
      end: async () => undefined,
    };
  });

  afterEach(async () => {
    await outer?.query("ROLLBACK").catch(() => undefined);
    await outer?.end();
    outer = current = null;
  });

  return () => {
    if (!current) throw new Error("useRolledBackSql: no test is running");
    return current;
  };
}
