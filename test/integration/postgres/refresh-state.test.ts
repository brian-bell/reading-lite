// The operator marker has no users foreign key, so its writer must coordinate
// with teardown's user-row lock. Real sessions pin both orders of that race.
import { afterEach, describe, expect, it } from "vitest";
import { readRefreshState, writeRefreshState } from "../../../scripts/pg-lib/operator-corpus";
import type { Sql } from "../../../src/modules/db/sql";
import { mintTenant, mintTenantWithoutUser, testSql } from "../../helpers/pg-fixtures";

const NOW = "2026-09-22T00:00:00.000Z";
const STATE = { version: 3, last_run_at: NOW, list_ids: ["rd_deleted"] };
const clients: Sql[] = [];
function open(): Sql {
  const sql = testSql();
  clients.push(sql);
  return sql;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
afterEach(async () => { await Promise.all(clients.splice(0).map((sql) => sql.end())); });

describe("operator refresh marker deletion fence", () => {
  it.each(["missing", "deleting", "suspended"])("refuses a %s account without changing its marker", async (status) => {
    const sql = open();
    const tenant = status === "missing" ? mintTenantWithoutUser() : await mintTenant();
    const id = String(tenant.tenantId);
    if (status !== "missing") {
      await writeRefreshState(sql, id, STATE, NOW);
      await sql.execute("UPDATE users SET status = $2 WHERE id = $1", [id, status]);
    }
    const before = await readRefreshState(sql, id);
    await expect(writeRefreshState(sql, id, { ...STATE, list_ids: [] }, NOW)).rejects.toThrow("account is not active");
    expect(await readRefreshState(sql, id)).toEqual(before);
  });

  it("waits for teardown and cannot recreate its deleted marker", async () => {
    const tenant = await mintTenant();
    const id = String(tenant.tenantId);
    const teardownSql = open();
    const markerSql = open();
    await writeRefreshState(markerSql, id, STATE, NOW);
    const locked = gate();
    const finish = gate();
    const teardown = teardownSql.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [id]);
      locked.release();
      await finish.promise;
      await tx.execute("DELETE FROM corpus_refresh_state WHERE tenant_id = $1", [id]);
      await tx.execute("DELETE FROM users WHERE id = $1", [id]);
    });
    await locked.promise;
    let settled = false;
    const write = writeRefreshState(markerSql, id, STATE, NOW).then(
      () => { settled = true; return null; },
      (error: Error) => { settled = true; return error; },
    );
    let waited: boolean;
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      waited = !settled;
    } finally { finish.release(); }
    await teardown;
    const error = await write;
    expect(waited).toBe(true);
    expect(error?.message).toContain("account is not active");
    expect(await readRefreshState(markerSql, id)).toBeNull();
  });

  it("holds the user lock until the marker commits so teardown removes it afterwards", async () => {
    const tenant = await mintTenant();
    const id = String(tenant.tenantId);
    const markerSql = open();
    const teardownSql = open();
    const written = gate();
    const finish = gate();
    // Pause the real transaction after its statements but before its commit.
    const held: Sql = {
      ...markerSql,
      transaction: (run, opts) => markerSql.transaction(async (tx) => {
        const result = await run(tx);
        written.release();
        await finish.promise;
        return result;
      }, opts),
    };
    const write = writeRefreshState(held, id, STATE, NOW);
    await written.promise;
    let acquired = false;
    const teardown = teardownSql.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [id]);
      acquired = true;
      await tx.execute("DELETE FROM corpus_refresh_state WHERE tenant_id = $1", [id]);
      await tx.execute("DELETE FROM users WHERE id = $1", [id]);
    });
    let waited: boolean;
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      waited = !acquired;
    } finally { finish.release(); }
    await Promise.all([write, teardown]);
    expect(waited).toBe(true);
    expect(await readRefreshState(markerSql, id)).toBeNull();
  });
});
