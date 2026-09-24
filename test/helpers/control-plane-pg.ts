// Node-pool control-plane tests on PostgreSQL (ADR 0005): each test runs in a
// rolled-back transaction (./pg-rollback.ts), so tests share one database and
// never see each other's rows or collide on a global unique.
//
// `db` is what the code under test is handed; `raw` is the same connection for
// the test's own setup and assertions. They are one handle under two names so
// a test reads as "arrange through raw, act through db".
import { fromSql, type ControlPlaneDb } from "../../src/control-plane/db";
import type { Sql } from "../../src/modules/db/sql";
import { useRolledBackSql } from "./pg-rollback";

export interface TestControlPlane {
  db: ControlPlaneDb;
  raw: ControlPlaneDb;
  sql: Sql;
}

// Call at the top of a file. Returns the current test's control plane.
export function useControlPlane(): () => TestControlPlane {
  const sql = useRolledBackSql();
  return () => {
    const db = fromSql(sql());
    return { db, raw: db, sql: sql() };
  };
}

// Assertions written against D1 read epoch milliseconds from `*_at_ms`
// columns. PostgreSQL returns `*_at` timestamptz as ISO strings, so each one is
// renamed back to its `_ms` name as epoch milliseconds: the row D1 returned.
// Callers cast the result to the row shape they assert on.
export function withMs(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((row) => withMs(row as Record<string, unknown>));
  const row = { ...(value as Record<string, unknown>) };
  for (const [key, field] of Object.entries(row)) {
    if (!key.endsWith("_at")) continue;
    delete row[key];
    row[`${key}_ms`] = typeof field === "string" ? Date.parse(field) : field;
  }
  return row;
}
