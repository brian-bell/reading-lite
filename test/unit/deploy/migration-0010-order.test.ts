// Migration 0010 (`vector_ledger`) must apply cleanly whichever side of 0011
// (S4's `account_deletions` audit table) it lands on.
//
// The two slices are being built in parallel on separate branches, and merges to
// `main` auto-deploy the production Worker, which applies pending remote D1
// migrations in numeric order and then uploads. Whichever merges first, the
// other applies on top of a schema it did not expect. "It looked independent"
// is not evidence; applying it both ways against a real SQLite is.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function read(name: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
}

/**
 * The same file with `--` comments stripped.
 *
 * These migrations carry long rationale comments that discuss the very phrases
 * this test looks for — 0009's header explains at length why it does NOT
 * cascade. Matching raw text would fail on the explanation rather than on the
 * schema, which is the opposite of what the assertions mean.
 */
function statementsOnly(name: string): string {
  return read(name)
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/**
 * A stand-in for 0011, spelled from design §4.3's sketch.
 *
 * Still a local fixture now that the real 0011 has landed, and deliberately so:
 * the reverse-order case has to build a database where `account_deletions`
 * exists *before* 0010 runs, which applying the real files in numeric order
 * cannot produce. The forward order below uses the real file. That the fixture
 * has since diverged from 0011 (which grew two first-completion columns and two
 * indexes) does not matter here — the claim under test is that 0010 needs
 * nothing from whatever S4 added, so the cruder the stand-in, the stronger the
 * result.
 */
const ACCOUNT_DELETIONS_0011 = `
CREATE TABLE account_deletions (
  tenant_id TEXT PRIMARY KEY,
  deleting_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER NOT NULL,
  residue INTEGER NOT NULL
);
`;

function applyThrough(db: Database.Database, upTo: string): void {
  for (const name of migrationFiles()) {
    if (name > upTo) break;
    db.exec(read(name));
  }
}

describe("migration 0010 — vector_ledger", () => {
  // Both slices have now landed, so the numbering question this file was
  // written to guard is settled rather than open: 0010 is the ledger, 0011 is
  // S4's audit table, and no third file has claimed either number. The
  // reverse-order case below still runs against the local fixture, which is
  // what the original comment said to keep once 0011 arrived.
  it("is 0010, with 0011 taken by exactly one file — S4's audit table", () => {
    const files = migrationFiles();
    expect(files.filter((n) => n.startsWith("0010"))).toEqual(["0010_vector_ledger.sql"]);
    expect(files.filter((n) => n.startsWith("0011"))).toEqual(["0011_account_deletions.sql"]);
  });

  it("declares no cascade anywhere", () => {
    // A cascade would destroy the ledger — and with it the only id source for a
    // tenant's vectors — at the moment S4's teardown deletes the users row.
    // Not just this file: the rule is the whole schema's.
    for (const name of migrationFiles()) {
      expect(statementsOnly(name).toUpperCase()).not.toContain("ON DELETE CASCADE");
    }
  });

  it("applies after every migration present, in order", () => {
    const db = new Database(":memory:");
    try {
      applyThrough(db, "9999");
      const cols = db.prepare("PRAGMA table_info(vector_ledger)").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name).sort()).toEqual([
        "absent_streak",
        "deleted_at_ms",
        "last_absent_at_ms",
        "reading_id",
        "state",
        "tenant_id",
        "upserted_at_ms",
      ]);
      // The composite primary key the design specified.
      const pk = (db.prepare("PRAGMA table_info(vector_ledger)").all() as Array<{
        name: string;
        pk: number;
      }>)
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      expect(pk).toEqual(["tenant_id", "reading_id"]);
      // `vector_cursor` SURVIVES as an unread column — dropping it would break
      // the previous Worker for a deploy window and, with no reverse migration,
      // break a rollback permanently — but its data is cleared, so no reading
      // id can linger on a record that outlives the account.
      const wipeCols = (db.prepare("PRAGMA table_info(wipe_progress)").all() as Array<{
        name: string;
      }>).map((c) => c.name);
      expect(wipeCols).toContain("vector_cursor");
      expect(wipeCols).toContain("r2_cursor");
      // The seed step's own resume state.
      expect(wipeCols).toContain("seed_cursor");
      expect(wipeCols).toContain("seed_completed_at_ms");
    } finally {
      db.close();
    }
  });

  it("applies whether or not 0011's account_deletions table already exists", () => {
    // Order A: 0010 first, then 0011 — now the real file, applied by
    // `applyThrough` in numeric order the way wrangler would. This is the
    // ordering production actually gets.
    const a = new Database(":memory:");
    try {
      applyThrough(a, "9999");
      expect(a.prepare("SELECT count(*) AS n FROM vector_ledger").get()).toEqual({ n: 0 });
      expect(a.prepare("SELECT count(*) AS n FROM account_deletions").get()).toEqual({ n: 0 });
    } finally {
      a.close();
    }

    // Order B: 0011 first, then 0010. This is the one that would fail if 0010
    // referenced anything of S4's, or if S4 had rebuilt a table 0010 alters.
    const b = new Database(":memory:");
    try {
      applyThrough(b, "0009_zzz");
      b.exec(ACCOUNT_DELETIONS_0011);
      b.exec(read("0010_vector_ledger.sql"));
      expect(b.prepare("SELECT count(*) AS n FROM vector_ledger").get()).toEqual({ n: 0 });
      expect(b.prepare("SELECT count(*) AS n FROM account_deletions").get()).toEqual({ n: 0 });
    } finally {
      b.close();
    }
  });

  it("references only users, so it depends on nothing a parallel slice adds", () => {
    const sql = statementsOnly("0010_vector_ledger.sql");
    const referenced = [...sql.matchAll(/REFERENCES\s+(\w+)/gi)].map((m) => m[1]);
    expect(referenced).toEqual(["users"]);
    expect(sql).not.toMatch(/account_deletions/);
  });

  it("enforces the two states the ledger has, and rejects a third", () => {
    const db = new Database(":memory:");
    try {
      applyThrough(db, "9999");
      db.prepare(
        "INSERT INTO users (id, email_canonical, email_display, status, created_at_ms, updated_at_ms)" +
          " VALUES ('usr_1', 'a@b.example', 'a@b.example', 'active', 1, 1)",
      ).run();
      const insert = (state: string) =>
        db
          .prepare(
            "INSERT INTO vector_ledger (tenant_id, reading_id, state, upserted_at_ms)" +
              " VALUES ('usr_1', 'rd_0123456789', ?, 1)",
          )
          .run(state);
      insert("live");
      expect(() => insert("deleted")).toThrow(/CHECK constraint/i);
      db.prepare("DELETE FROM vector_ledger").run();
      insert("delete_submitted");
    } finally {
      db.close();
    }
  });
});
