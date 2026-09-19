import { describe, expect, it } from "vitest";
import { fromSql, isUniqueConstraintError, numberPlaceholders } from "../../../src/control-plane/db";
import { fromTimestamp, toTimestamp } from "../../../src/control-plane/pg-time";
import { parseInt8 } from "../../../src/modules/db/sql";
import { useRolledBackSql } from "../../helpers/pg-rollback";

const sql = useRolledBackSql();

const NOW_MS = 1_790_000_000_123;
const INSERT_USER = `INSERT INTO users (id, email_canonical, email_display, status, created_at, updated_at)
  VALUES (?, ?, ?, 'active', ?, ?)`;
const userParams = (id: string, email = `${id}@test.example`) => [
  id,
  email,
  email,
  toTimestamp(NOW_MS),
  toTimestamp(NOW_MS),
];

describe("numberPlaceholders", () => {
  it.each([
    ["SELECT 1 WHERE a = ? AND b = ?", "SELECT 1 WHERE a = $1 AND b = $2"],
    ["SELECT '?' AS q, 'it''s ?' AS r WHERE a = ?", "SELECT '?' AS q, 'it''s ?' AS r WHERE a = $1"],
    ['SELECT "odd?" FROM t WHERE a = ?', 'SELECT "odd?" FROM t WHERE a = $1'],
    ["SELECT 1 -- why?\nWHERE a = ?", "SELECT 1 -- why?\nWHERE a = $1"],
  ])("numbers %j", (input, expected) => {
    expect(numberPlaceholders(input)).toBe(expected);
  });
});

describe("fromSql", () => {
  it("reads one row, no row, and many rows", async () => {
    const db = fromSql(sql());
    await db.run(INSERT_USER, ...userParams("usr_a"));
    await db.run(INSERT_USER, ...userParams("usr_b"));

    expect(await db.first<{ id: string }>("SELECT id FROM users WHERE id = ?", "usr_a")).toEqual({ id: "usr_a" });
    expect(await db.first("SELECT id FROM users WHERE id = ?", "usr_missing")).toBeNull();
    expect(await db.all<{ id: string }>("SELECT id FROM users WHERE id IN (?, ?) ORDER BY id", "usr_a", "usr_b")).toEqual([
      { id: "usr_a" },
      { id: "usr_b" },
    ]);
  });

  it("reports how many rows a write touched, so a lost compare-and-set reads as zero", async () => {
    const db = fromSql(sql());
    await db.run(INSERT_USER, ...userParams("usr_a"));

    expect(await db.run("UPDATE users SET status = 'suspended' WHERE id = ? AND status = 'active'", "usr_a")).toEqual({
      changes: 1,
    });
    expect(await db.run("UPDATE users SET status = 'suspended' WHERE id = ? AND status = 'active'", "usr_a")).toEqual({
      changes: 0,
    });
  });

  it("applies a batch as one transaction: a failing statement undoes the ones before it", async () => {
    const db = fromSql(sql());
    await db.run(INSERT_USER, ...userParams("usr_taken", "taken@test.example"));

    const attempt = db.batch([
      { sql: INSERT_USER, params: userParams("usr_new") },
      { sql: INSERT_USER, params: userParams("usr_dupe", "taken@test.example") },
    ]);

    await expect(attempt).rejects.toSatisfy(isUniqueConstraintError);
    expect(await db.first("SELECT id FROM users WHERE id = ?", "usr_new")).toBeNull();
  });

  it("returns per-statement row counts from a batch", async () => {
    const db = fromSql(sql());
    const results = await db.batch([
      { sql: INSERT_USER, params: userParams("usr_a") },
      { sql: "UPDATE users SET status = 'suspended' WHERE id = ?", params: ["usr_missing"] },
    ]);
    expect(results).toEqual([{ changes: 1 }, { changes: 0 }]);
  });

  it("joins the caller's transaction when given a transaction handle", async () => {
    const boom = new Error("caller aborts");
    const attempt = sql().transaction(async (tx) => {
      await fromSql(tx).batch([{ sql: INSERT_USER, params: userParams("usr_a") }]);
      throw boom;
    });

    await expect(attempt).rejects.toBe(boom);
    expect(await fromSql(sql()).first("SELECT id FROM users WHERE id = ?", "usr_a")).toBeNull();
  });

  // PostgreSQL aborts a transaction on any failed statement; D1 did not. The
  // control plane catches unique violations and carries on (redeem's
  // email_taken, challenge issue's retry, the wipe lease race), so a caught
  // failure must not poison what follows.
  it("outside a transaction, keeps working after a caught unique violation", async () => {
    const db = fromSql(sql());
    await db.run(INSERT_USER, ...userParams("usr_a", "taken@test.example"));

    await expect(db.run(INSERT_USER, ...userParams("usr_b", "taken@test.example"))).rejects.toSatisfy(
      isUniqueConstraintError,
    );
    await expect(
      db.batch([{ sql: INSERT_USER, params: userParams("usr_c", "taken@test.example") }]),
    ).rejects.toSatisfy(isUniqueConstraintError);

    expect(await db.run(INSERT_USER, ...userParams("usr_d"))).toEqual({ changes: 1 });
  });

  it("inside the caller's transaction, undoes only the failed call and keeps the transaction usable", async () => {
    await sql().transaction(async (tx) => {
      const db = fromSql(tx);
      await db.run(INSERT_USER, ...userParams("usr_a", "taken@test.example"));

      await expect(db.run(INSERT_USER, ...userParams("usr_b", "taken@test.example"))).rejects.toSatisfy(
        isUniqueConstraintError,
      );
      // A batch stays all-or-nothing: its first insert goes with its failure.
      await expect(
        db.batch([
          { sql: INSERT_USER, params: userParams("usr_c") },
          { sql: INSERT_USER, params: userParams("usr_e", "taken@test.example") },
        ]),
      ).rejects.toSatisfy(isUniqueConstraintError);

      await db.run(INSERT_USER, ...userParams("usr_d"));
    });

    expect(await fromSql(sql()).all<{ id: string }>("SELECT id FROM users ORDER BY id")).toEqual([
      { id: "usr_a" },
      { id: "usr_d" },
    ]);
  });

  it("runs transaction work all-or-nothing, and a nested call joins the outer transaction", async () => {
    const db = fromSql(sql());
    const boom = new Error("abort");
    await expect(
      db.transaction(async (tx) => {
        await tx.run(INSERT_USER, ...userParams("usr_a"));
        await tx.transaction(async (inner) => {
          await inner.run(INSERT_USER, ...userParams("usr_b"));
        });
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await db.all("SELECT id FROM users")).toEqual([]);

    await db.transaction(async (tx) => {
      await tx.run(INSERT_USER, ...userParams("usr_a"));
      // A failed nested call undoes only itself.
      await expect(
        tx.transaction(async (inner) => {
          await inner.run(INSERT_USER, ...userParams("usr_b"));
          throw boom;
        }),
      ).rejects.toBe(boom);
    });
    expect(await db.all<{ id: string }>("SELECT id FROM users")).toEqual([{ id: "usr_a" }]);
  });

  it("does not mistake other constraint failures for a unique violation", async () => {
    const attempt = fromSql(sql()).run(
      `INSERT INTO sessions (id, user_id, secret_hmac, hash_key_version, created_at, authenticated_at,
         last_seen_at, idle_expires_at, absolute_expires_at, created_from_claim_id)
       VALUES ('ses_a', 'usr_missing', 'h', 1, now(), now(), now(), now(), now(), 'claim')`,
    );
    await expect(attempt).rejects.not.toSatisfy(isUniqueConstraintError);
  });
});

describe("control-plane column types at the boundary", () => {
  it("round-trips epoch milliseconds through timestamptz without losing the millisecond", async () => {
    const db = fromSql(sql());
    await db.run(INSERT_USER, ...userParams("usr_a"));
    const row = await db.first<{ created_at: string; suspended_at: string | null }>(
      "SELECT created_at, suspended_at FROM users WHERE id = ?",
      "usr_a",
    );
    expect(fromTimestamp(row!.created_at)).toBe(NOW_MS);
    expect(fromTimestamp(row!.suspended_at)).toBeNull();
    expect(toTimestamp(null)).toBeNull();
  });

  it("compares timestamps by instant", async () => {
    const db = fromSql(sql());
    await db.run(INSERT_USER, ...userParams("usr_a"));
    const found = (after: number) =>
      db.first("SELECT id FROM users WHERE id = ? AND created_at > ?", "usr_a", toTimestamp(after));
    expect(await found(NOW_MS - 1)).not.toBeNull();
    expect(await found(NOW_MS)).toBeNull();
  });

  it("returns booleans, bigint ceilings as numbers, and jsonb as values", async () => {
    const db = fromSql(sql());
    await db.run(INSERT_USER, ...userParams("usr_a"));
    await db.run(
      `INSERT INTO tenant_limits (tenant_id, policy_version, submissions_per_hour, monthly_readings,
         max_concurrent_work, daily_spend_microdollars, created_at, updated_at)
       VALUES (?, 1, 1, 1, 1, ?, ?, ?)`,
      "usr_a",
      100_000_000_000,
      toTimestamp(NOW_MS),
      toTimestamp(NOW_MS),
    );
    await db.run(
      `INSERT INTO relationship_refresh_jobs (tenant_id, reading_id, run_at, owner, source_etag, result_json)
       VALUES (?, 'rd_a', ?, 'owner', 'etag', ?)`,
      "usr_a",
      toTimestamp(NOW_MS),
      JSON.stringify({ kept: ["rd_b"] }),
    );
    await db.run(
      "INSERT INTO wipe_progress (tenant_id, phase, updated_at, force) VALUES (?, 'rows', ?, ?)",
      "usr_a",
      toTimestamp(NOW_MS),
      true,
    );

    expect(await db.first("SELECT daily_spend_microdollars FROM tenant_limits WHERE tenant_id = ?", "usr_a")).toEqual({
      daily_spend_microdollars: 100_000_000_000,
    });
    expect(await db.first("SELECT result_json FROM relationship_refresh_jobs WHERE tenant_id = ?", "usr_a")).toEqual({
      result_json: { kept: ["rd_b"] },
    });
    expect(await db.first("SELECT force, residue FROM wipe_progress WHERE tenant_id = ?", "usr_a")).toEqual({
      force: true,
      residue: false,
    });
  });

  it("refuses an int8 that a JavaScript number cannot hold", () => {
    expect(parseInt8("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseInt8("9007199254740993")).toThrow(RangeError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("refuses %s as a timestamp", (ms) => {
    expect(() => toTimestamp(ms)).toThrow(RangeError);
  });
});
