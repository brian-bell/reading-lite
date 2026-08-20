import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ControlPlaneDb, SqlStatement } from "../../src/control-plane/db";

const MIGRATION = path.join(process.cwd(), "migrations", "0001_control_plane_auth.sql");

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
        for (const statement of statements) {
          sqlite.prepare(statement.sql).run(...statement.params);
        }
      });
      apply();
    },
  };
}

export function openMigratedControlPlane(): {
  sqlite: Database.Database;
  db: ControlPlaneDb;
} {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(readFileSync(MIGRATION, "utf8"));
  return { sqlite, db: fromBetterSqlite(sqlite) };
}
