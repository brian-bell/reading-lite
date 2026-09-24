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
    // Advisory locks (lockKey) are held until the outer transaction ends,
    // which here is the end of the test. Tests cannot see each other's rows,
    // so a lock shared across them serializes nothing real and deadlocks
    // against the unique-index waits above; each test gets its own key space.
    const salt = crypto.randomUUID();
    const salted = (text: string, values?: unknown[]): [string, unknown[] | undefined] =>
      /pg_advisory_xact_lock/.test(text) && values && typeof values[0] === "string"
        ? [text, [`${salt}:${values[0]}`, ...values.slice(1)]]
        : [text, values];
    const query: SqlQuery["query"] = (text, values) => client.query(...salted(text, values));
    const execute: SqlQuery["execute"] = (text, values) => client.execute(...salted(text, values));
    const handle: SqlQuery = { query, execute };
    // One client, so operations queue behind each other as they do on a
    // production session (sqlSession): two "concurrent" transactions run one
    // after the other instead of interleaving statements, which would leave
    // each one's savepoint inside the other's. Code inside a transaction uses
    // its `tx` handle, which does not queue.
    let queue: Promise<unknown> = Promise.resolve();
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
      const result = queue.then(work);
      queue = result.catch(() => undefined);
      return result;
    };
    current = {
      query: (text, values) => serial(() => inSavepoint(client, "autocommit", () => query(text, values))),
      execute: (text, values) => serial(() => inSavepoint(client, "autocommit", () => execute(text, values))),
      transaction(run, opts = {}) {
        // READ ONLY cannot be undone inside the outer transaction, and no
        // control-plane caller asks for it.
        if (opts.readOnly) throw new Error("useRolledBackSql does not support read-only transactions");
        return serial(async () => {
          try {
            return await inSavepoint(client, `nested_${++depth}`, () => run(handle));
          } finally {
            depth--;
          }
        });
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
