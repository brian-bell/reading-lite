// Transactions on one `Sql` are serialized (reading-lite-gh347.4.1).
//
// Against a real client, because the failure this pins is PostgreSQL's, not
// ours: BEGIN/COMMIT are connection state, so two overlapping callbacks on one
// client share a single transaction — the second BEGIN is a warning, the first
// COMMIT commits both halves, and either rollback discards the other's writes.
// A fake client cannot exhibit that, which is exactly why the guard was
// missing until the operator's refresh passes ran their judgements through a
// worker pool.
import { afterEach, describe, expect, it } from "vitest";
import { sqlFromConnectionString, type Sql } from "../../../src/modules/db/sql";
import { testDatabaseUrl } from "../../helpers/test-database";

let sql: Sql | null = null;
afterEach(async () => {
  await sql?.end().catch(() => undefined);
  sql = null;
});

describe("sqlFromConnectionString transactions", () => {
  it("does not let a rolled-back transaction discard a concurrent one's writes", async () => {
    sql = sqlFromConnectionString(testDatabaseUrl());
    // Session-scoped, so this test writes nothing another file can see.
    await sql.query("CREATE TEMP TABLE serialized_tx (v text)");

    let doomedInside: () => void;
    const entered = new Promise<void>((resolve) => {
      doomedInside = resolve;
    });
    const doomed = sql.transaction(async (tx) => {
      await tx.query("INSERT INTO serialized_tx VALUES ('rolled-back')");
      doomedInside();
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error("judgement failed");
    });
    await entered;
    const committed = sql.transaction((tx) => tx.query("INSERT INTO serialized_tx VALUES ('committed')"));

    await expect(doomed).rejects.toThrow("judgement failed");
    await committed;

    // Interleaved, both rows would be inside the first transaction and the
    // rollback would take the committed one with it.
    expect(await sql.query("SELECT v FROM serialized_tx")).toEqual([{ v: "committed" }]);
  });

  it("runs a transaction queued behind one that threw", async () => {
    sql = sqlFromConnectionString(testDatabaseUrl());
    await sql.query("CREATE TEMP TABLE queued_tx (v text)");
    const failed = sql.transaction(() => Promise.reject(new Error("first")));
    const after = sql.transaction((tx) => tx.query("INSERT INTO queued_tx VALUES ('after')"));
    await expect(failed).rejects.toThrow("first");
    await after;
    expect(await sql.query("SELECT v FROM queued_tx")).toEqual([{ v: "after" }]);
  });
});
