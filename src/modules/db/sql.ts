// The PostgreSQL seam (ADR 0005). Stores take the `Sql` interface, never a pg
// client, so they are injectable in tests and reusable by Node scripts over a
// direct connection. In the Worker the connection string comes from the
// Hyperdrive binding; Hyperdrive pools, so a `Sql` is built per request and
// closed by the caller (`ctx.waitUntil(sql.end())`).
//
// A `Sql` wraps one client: run queries on it sequentially. A transaction
// holds the client until its callback settles.
//
// Hyperdrive pools in transaction mode, so session state does not survive
// between statements. Anything session-scoped (SET, advisory locks) must be
// SET LOCAL inside `transaction`.

import pg from "pg";

const OID_DATE = 1082;
const OID_TIMESTAMPTZ = 1184;

// pg's defaults would return a JS Date for both. A `date` parsed at local
// midnight is a day off on any machine west of UTC, and the manifest contract
// is strings: `source_date` is YYYY-MM-DD and every timestamp is ISO-8601 UTC
// with milliseconds, matching services.now().
const parseTimestamptz = pg.types.getTypeParser(OID_TIMESTAMPTZ) as (value: string) => Date;
const types = {
  getTypeParser(oid: number, format?: string) {
    if (format !== "binary") {
      if (oid === OID_DATE) return (value: string) => value;
      if (oid === OID_TIMESTAMPTZ) return (value: string) => parseTimestamptz(value).toISOString();
    }
    return pg.types.getTypeParser(oid, format as "text");
  },
} as pg.CustomTypesConfig;

export type SqlRow = Record<string, unknown>;

export interface SqlQuery {
  query<Row extends SqlRow = SqlRow>(text: string, values?: unknown[]): Promise<Row[]>;
}

export interface TransactionOptions {
  // SET TRANSACTION READ ONLY: any write inside fails closed.
  readOnly?: boolean;
}

export interface Sql extends SqlQuery {
  transaction<T>(run: (tx: SqlQuery) => Promise<T>, opts?: TransactionOptions): Promise<T>;
  end(): Promise<void>;
}

export function sqlFromConnectionString(connectionString: string): Sql {
  const client = new pg.Client({ connectionString, types });
  let connecting: Promise<void> | null = null;
  const connected = (): Promise<void> => (connecting ??= client.connect().then(() => undefined));

  const query: SqlQuery["query"] = async (text, values) => {
    await connected();
    const result = await client.query(text, values);
    return result.rows;
  };

  return {
    query,
    async transaction(run, opts = {}) {
      await query(opts.readOnly ? "BEGIN READ ONLY" : "BEGIN");
      try {
        const out = await run({ query });
        await query("COMMIT");
        return out;
      } catch (error) {
        await query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    },
    async end() {
      if (connecting === null) return;
      await connecting.catch(() => undefined);
      await client.end();
    },
  };
}

export function sqlFor(env: { HYPERDRIVE: Hyperdrive }): Sql {
  return sqlFromConnectionString(env.HYPERDRIVE.connectionString);
}

// For work that outlives a request: the queue consumer runs for minutes with
// provider calls between its statements, and one client held idle that long can
// be dropped underneath it. Each query and each transaction gets its own
// client, closed when it settles. Hyperdrive pools, so that is cheap, and
// nothing here ever spans two operations. `end` is a no-op.
export function sqlPerOperationFor(env: { HYPERDRIVE: Hyperdrive }): Sql {
  const scoped = async <T>(run: (sql: Sql) => Promise<T>): Promise<T> => {
    const sql = sqlFor(env);
    try {
      return await run(sql);
    } finally {
      await sql.end().catch(() => undefined);
    }
  };
  return {
    query: <Row extends SqlRow = SqlRow>(text: string, values?: unknown[]) =>
      scoped((sql) => sql.query<Row>(text, values)),
    transaction: (run, opts) => scoped((sql) => sql.transaction(run, opts)),
    end: async () => undefined,
  };
}

// pgvector's text input format.
export function vectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(",")}]`;
}
