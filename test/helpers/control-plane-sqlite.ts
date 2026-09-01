import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ControlPlaneDb, SqlStatement } from "../../src/control-plane/db";

// Apply every migration in filename order, the same way D1 does, so Node-pool
// tests exercise the schema the Worker actually runs against.
const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

export function fromBetterSqlite(sqlite: Database.Database): ControlPlaneDb {
  return {
    async first<T>(sql: string, ...params: unknown[]) {
      return (sqlite.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async all<T>(sql: string, ...params: unknown[]) {
      return sqlite.prepare(sql).all(...params) as T[];
    },
    async batch(statements: readonly SqlStatement[]) {
      const apply = sqlite.transaction(() => {
        return statements.map((statement) => {
          const info = sqlite.prepare(statement.sql).run(...statement.params);
          return { changes: info.changes };
        });
      });
      return apply();
    },
    async run(sql, ...params) {
      const info = sqlite.prepare(sql).run(...params);
      return { changes: info.changes };
    },
  };
}

export function openMigratedControlPlane(): {
  sqlite: Database.Database;
  db: ControlPlaneDb;
} {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
  return { sqlite, db: fromBetterSqlite(sqlite) };
}
