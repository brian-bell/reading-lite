import { sqlFor, type Sql, type SqlQuery } from "../modules/db/sql";

export interface SqlStatement {
  sql: string;
  params: readonly unknown[];
}

export interface BatchResult {
  changes: number;
}

export interface ControlPlaneDb {
  first<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  batch(statements: readonly SqlStatement[]): Promise<BatchResult[]>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  // One transaction around `work`, for the sites that must lock before they
  // act (SELECT … FOR UPDATE, or lockKey for rows that may not exist yet).
  // Already inside one, `work` joins it in a savepoint: all of it or none.
  transaction<T>(work: (tx: ControlPlaneDb) => Promise<T>): Promise<T>;
}

// A transaction-scoped advisory lock on `key`, held until the caller's
// transaction ends. For lock-then-act where the contended row may not exist
// yet: a first sign-in has no users row and a first challenge no challenge row
// to lock FOR UPDATE. Hyperdrive pools in transaction mode, so only the xact
// form is safe; call it inside `transaction`, never on a bare `Sql`.
export async function lockKey(tx: ControlPlaneDb, key: string): Promise<void> {
  await tx.first("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", key);
}

// SQLSTATE unique_violation, which pg puts on the error's `code`.
const PG_UNIQUE_VIOLATION = "23505";

export function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { message?: unknown; code?: unknown };
  const message = typeof record.message === "string" ? record.message : "";
  const code = typeof record.code === "string" ? record.code : "";
  return (
    code === PG_UNIQUE_VIOLATION ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT" ||
    /UNIQUE constraint failed/i.test(message)
  );
}

// Control-plane SQL is written with `?` placeholders; PostgreSQL wants `$n`.
// The switch is mechanical: number them in order, leaving alone any `?` inside
// a string literal, a quoted identifier or a `--` comment.
export function numberPlaceholders(sql: string): string {
  let out = "";
  let next = 1;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    if (char === "'" || char === '"') {
      // A doubled quote is an escaped quote: it closes and reopens at once.
      let end = sql.indexOf(char, i + 1);
      if (end === -1) end = sql.length - 1;
      out += sql.slice(i, end + 1);
      i = end;
    } else if (char === "-" && sql[i + 1] === "-") {
      let end = sql.indexOf("\n", i);
      if (end === -1) end = sql.length - 1;
      out += sql.slice(i, end + 1);
      i = end;
    } else {
      out += char === "?" ? `$${next++}` : char;
    }
  }
  return out;
}

// The PostgreSQL ControlPlaneDb (ADR 0005). Given a `Sql`, `batch` is one
// transaction: all of it commits or none does, which is what D1's batch gave.
// Given a transaction handle instead, every call joins that transaction, so a
// caller that must lock before it acts (SELECT … FOR UPDATE) can still hand
// the same seam to the code that acts.
//
// PostgreSQL aborts a transaction on any failed statement, and every later one
// then fails with 25P02 until it rolls back. D1 did not, and the control plane
// relies on that: it catches a unique violation and carries on (redeem's
// email_taken, challenge issue's retry, the wipe lease race). So inside a
// caller's transaction each `run` and `batch` gets its own savepoint: a failed
// call undoes only itself, a batch stays all-or-nothing, and the transaction
// stays usable. Reads are not wrapped; nothing catches a failed read.
const STATEMENT_SAVEPOINT = "control_plane_statement";

async function inSavepoint<T>(tx: SqlQuery, work: () => Promise<T>): Promise<T> {
  // Savepoint names may repeat; RELEASE and ROLLBACK TO take the newest, and
  // calls on one handle are sequential, so a fixed name nests correctly.
  await tx.execute(`SAVEPOINT ${STATEMENT_SAVEPOINT}`);
  try {
    const out = await work();
    await tx.execute(`RELEASE SAVEPOINT ${STATEMENT_SAVEPOINT}`);
    return out;
  } catch (error) {
    // If this fails too, the connection is gone and the caller's transaction
    // fails on its next statement; keep the real error.
    await tx
      .execute(`ROLLBACK TO SAVEPOINT ${STATEMENT_SAVEPOINT}`)
      .then(() => tx.execute(`RELEASE SAVEPOINT ${STATEMENT_SAVEPOINT}`))
      .catch(() => undefined);
    throw error;
  }
}

export function fromSql(sql: Sql | SqlQuery): ControlPlaneDb {
  const joined = !("transaction" in sql);
  const runAll = async (tx: SqlQuery, statements: readonly SqlStatement[]): Promise<BatchResult[]> => {
    const results: BatchResult[] = [];
    for (const statement of statements) {
      results.push({ changes: await tx.execute(numberPlaceholders(statement.sql), [...statement.params]) });
    }
    return results;
  };
  const db: ControlPlaneDb = {
    async first<T>(text: string, ...params: unknown[]) {
      const rows = await sql.query(numberPlaceholders(text), params);
      return (rows[0] as T | undefined) ?? null;
    },
    async all<T>(text: string, ...params: unknown[]) {
      return (await sql.query(numberPlaceholders(text), params)) as T[];
    },
    async batch(statements) {
      if (statements.length === 0) return [];
      if (joined) return inSavepoint(sql, () => runAll(sql, statements));
      return (sql as Sql).transaction((tx) => runAll(tx, statements));
    },
    async run(text, ...params) {
      const execute = () => sql.execute(numberPlaceholders(text), params);
      return { changes: await (joined ? inSavepoint(sql, execute) : execute()) };
    },
    async transaction(work) {
      if (joined) return inSavepoint(sql, () => work(db));
      return (sql as Sql).transaction((tx) => work(fromSql(tx)));
    },
  };
  return db;
}

// One short-lived client for a lookup outside any request or session, as the
// Durable Object guards make when they read policy and tenant state. Always
// closed, whether `work` resolves or throws.
export async function withControlPlane<T>(
  env: { HYPERDRIVE: Hyperdrive },
  work: (db: ControlPlaneDb) => Promise<T>,
): Promise<T> {
  const sql = sqlFor(env);
  try {
    return await work(fromSql(sql));
  } finally {
    await sql.end();
  }
}

// D1 has no interactive transactions, so `transaction` runs `work` on the same
// handle. Only operator scripts still reach D1 (retired in 1c.5); the runtime
// is on PostgreSQL.
export function fromD1(d1: D1Database): ControlPlaneDb {
  const db: ControlPlaneDb = {
    async first<T>(sql: string, ...params: unknown[]) {
      return (await d1.prepare(sql).bind(...params).first<T>()) ?? null;
    },
    async all<T>(sql: string, ...params: unknown[]) {
      const result = await d1.prepare(sql).bind(...params).all<T>();
      return result.results;
    },
    async batch(statements) {
      if (statements.length === 0) return [];
      const results = await d1.batch(
        statements.map((statement) => d1.prepare(statement.sql).bind(...statement.params)),
      );
      return results.map((result) => ({ changes: result.meta.changes ?? 0 }));
    },
    async run(sql, ...params) {
      const result = await d1.prepare(sql).bind(...params).run();
      return { changes: result.meta.changes ?? 0 };
    },
    transaction: (work) => work(db),
  };
  return db;
}
