import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("migration 0012 — retain vector repair evidence after teardown", () => {
  it("preserves populated ledgers and their constraints while allowing user deletion", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      const dir = path.join(process.cwd(), "migrations");
      for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".sql") && f < "0012").sort()) {
        db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
      }
      db.exec(`INSERT INTO users (id, email_canonical, email_display, status, created_at_ms, updated_at_ms)
        VALUES ('usr_1', 'one@example.com', 'one@example.com', 'deleting', 1, 1),
               ('usr_2', 'two@example.com', 'two@example.com', 'active', 1, 1);
        INSERT INTO vector_ledger VALUES
          ('usr_1', 'rd_a', 'delete_submitted', 100, 200, 1, 300),
          ('usr_2', 'rd_b', 'live', 400, NULL, 0, NULL);`);
      const before = db.prepare("SELECT * FROM vector_ledger ORDER BY tenant_id").all();
      expect(() => db.exec("DELETE FROM users WHERE id = 'usr_1'")).toThrow(/FOREIGN KEY/);

      // D1 applies a migration transactionally with foreign keys enabled.
      db.transaction(() => db.exec(fs.readFileSync(path.join(dir, "0012_vector_ledger_retention.sql"), "utf8")))();

      expect(db.prepare("SELECT * FROM vector_ledger ORDER BY tenant_id").all()).toEqual(before);
      db.exec("DELETE FROM users WHERE id = 'usr_1'");
      expect(db.prepare("SELECT * FROM vector_ledger ORDER BY tenant_id").all()).toEqual(before);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'vector_ledger_tenant_state'").get()).toBeDefined();
      expect(() => db.exec("INSERT INTO vector_ledger VALUES ('usr_1', 'rd_a', 'live', 1, NULL, 0, NULL)")).toThrow(/UNIQUE/);
      expect(() => db.exec("INSERT INTO vector_ledger VALUES ('usr_1', 'rd_c', 'invalid', 1, NULL, 0, NULL)")).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });
});
