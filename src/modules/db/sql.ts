// The PostgreSQL seam (ADR 0005). Stores take the `Sql` interface, never a pg
// client, so they are injectable in tests and reusable by Node scripts over a
// direct connection. In the Worker the connection string comes from the
// Hyperdrive binding; Hyperdrive pools, so a `Sql` is built per request and
// closed by the caller (`ctx.waitUntil(sql.end())`).
//
// A `Sql` wraps one client: run queries on it sequentially. A transaction
// holds the client until its callback settles, and concurrent transactions on
// one `Sql` queue rather than interleave — enforced here, not left to callers,
// because interleaving them silently commits half-written work.
//
// Hyperdrive pools in transaction mode, so session state does not survive
// between statements. Anything session-scoped (SET, advisory locks) must be
// SET LOCAL inside `transaction`.

import pg from "pg";

const OID_INT8 = 20;
const OID_DATE = 1082;
const OID_TIMESTAMPTZ = 1184;

// pg's defaults would return a JS Date for both. A `date` parsed at local
// midnight is a day off on any machine west of UTC, and the manifest contract
// is strings: `source_date` is YYYY-MM-DD and every timestamp is ISO-8601 UTC
// with milliseconds, matching services.now().
const parseTimestamptz = pg.types.getTypeParser(OID_TIMESTAMPTZ) as (value: string) => Date;

// pg returns int8 as a string because it can exceed a double. The domain's
// bigints (microdollar ceilings, identity ids) are numbers and nowhere near
// 2^53, so parse them, and refuse a value that would silently lose precision.
export function parseInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`int8 value ${value} does not fit a JavaScript number`);
  return parsed;
}

const types = {
  getTypeParser(oid: number, format?: string) {
    if (format !== "binary") {
      if (oid === OID_INT8) return parseInt8;
      if (oid === OID_DATE) return (value: string) => value;
      if (oid === OID_TIMESTAMPTZ) return (value: string) => parseTimestamptz(value).toISOString();
    }
    return pg.types.getTypeParser(oid, format as "text");
  },
} as pg.CustomTypesConfig;

export type SqlRow = Record<string, unknown>;

export interface SqlQuery {
  query<Row extends SqlRow = SqlRow>(text: string, values?: unknown[]): Promise<Row[]>;
  // Runs a statement for its effect and returns how many rows it touched: the
  // compare-and-set answer, where zero means a sibling won.
  execute(text: string, values?: unknown[]): Promise<number>;
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
  const execute: SqlQuery["execute"] = async (text, values) => {
    await connected();
    const result = await client.query(text, values);
    return result.rowCount ?? 0;
  };

  // Transactions on one client are serialized, because BEGIN/COMMIT are
  // connection state rather than per-statement. Two overlapping callbacks would
  // share one transaction: the second BEGIN is ignored with a warning, the
  // first COMMIT commits both halves, and a ROLLBACK in either discards the
  // other's writes. Nothing in pg's statement queue prevents that — it only
  // guarantees the statements themselves do not interleave.
  //
  // Callers do run them concurrently: the operator's refresh passes judge
  // through a worker pool and end each action in its own transaction. They wait
  // here rather than corrupt each other, and the wait is cheap next to the
  // provider call each one follows.
  let queued: Promise<unknown> = Promise.resolve();
  // `work` runs on both settle paths: a failed transaction must not strand the
  // ones queued behind it.
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queued.then(work, work);
    queued = next.catch(() => undefined);
    return next;
  };

  return {
    query,
    execute,
    transaction(run, opts = {}) {
      return serialized(async () => {
        await query(opts.readOnly ? "BEGIN READ ONLY" : "BEGIN");
        try {
          const out = await run({ query, execute });
          await query("COMMIT");
          return out;
        } catch (error) {
          await query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      });
    },
    async end() {
      if (connecting === null) return;
      await connecting.catch(() => undefined);
      await queued;
      await client.end();
    },
  };
}

export function sqlFor(env: { HYPERDRIVE: Hyperdrive }): Sql {
  return sqlFromConnectionString(env.HYPERDRIVE.connectionString);
}

// How long a session's client may sit unused before it is replaced.
const SESSION_MAX_IDLE_MS = 10_000;

export interface SqlSessionOptions {
  maxIdleMs?: number;
  now?: () => number;
}

// For work that outlives a request: the queue consumer and the scheduled jobs.
// The consumer runs for minutes with provider calls between its statements,
// and a connection left idle that long can be dropped underneath it, so a
// client is reused only while it keeps being used: one idle past the limit, or
// one that just threw, is closed and the next operation opens a fresh one.
// Opening a client per statement instead would be correct but floods the
// connection path (every open is a full handshake where nothing pools, as in
// local and CI runs).
//
// Operations are serialized on the one client. Never call the session itself
// from inside a `transaction` callback — use the `tx` handle — or the nested
// call waits on the transaction that is waiting on it. The owner calls `end`.
export function sqlSession(open: () => Sql, opts: SqlSessionOptions = {}): Sql {
  const maxIdleMs = opts.maxIdleMs ?? SESSION_MAX_IDLE_MS;
  const now = opts.now ?? Date.now;
  let current: { sql: Sql; lastUsed: number } | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const close = async (held: { sql: Sql }) => {
    if (current === held) current = null;
    await held.sql.end().catch(() => undefined);
  };
  const run = <T>(operation: (sql: Sql) => Promise<T>): Promise<T> => {
    const result = queue.then(async () => {
      if (current && now() - current.lastUsed > maxIdleMs) await close(current);
      const held = (current ??= { sql: open(), lastUsed: now() });
      try {
        const out = await operation(held.sql);
        held.lastUsed = now();
        return out;
      } catch (error) {
        // A client that threw may be broken; never hand it out again.
        await close(held);
        throw error;
      }
    });
    queue = result.catch(() => undefined);
    return result;
  };

  return {
    query: <Row extends SqlRow = SqlRow>(text: string, values?: unknown[]) =>
      run((sql) => sql.query<Row>(text, values)),
    execute: (text, values) => run((sql) => sql.execute(text, values)),
    transaction: (callback, txOpts) => run((sql) => sql.transaction(callback, txOpts)),
    async end() {
      await queue;
      if (current) await close(current);
    },
  };
}

export function sqlSessionFor(env: { HYPERDRIVE: Hyperdrive }, opts: SqlSessionOptions = {}): Sql {
  return sqlSession(() => sqlFor(env), opts);
}

// A session for the length of `work`, always ended.
export async function withSqlSession<T>(env: { HYPERDRIVE: Hyperdrive }, work: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = sqlSessionFor(env);
  try {
    return await work(sql);
  } finally {
    await sql.end();
  }
}

// pgvector's text input format.
export function vectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(",")}]`;
}
