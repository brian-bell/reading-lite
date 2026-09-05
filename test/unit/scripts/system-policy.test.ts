import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  systemPolicyCommand,
  type PolicyDeps,
} from "../../../scripts/ops-lib/commands/system-policy";
import type { ControlPlaneDb } from "../../../src/control-plane/db";
import { UsageError } from "../../../scripts/ops-lib/contract";

function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE system_policy (id INTEGER PRIMARY KEY, policy_version INTEGER, paid_work_enabled INTEGER, daily_spend_microdollars INTEGER, catalog_version INTEGER, updated_at_ms INTEGER, signup_mode TEXT);
    INSERT INTO system_policy VALUES (1, 3, 1, 1000000, 1, 0, 'closed');
    CREATE TABLE tenant_limits (tenant_id TEXT PRIMARY KEY, policy_version INTEGER, daily_spend_microdollars INTEGER, updated_at_ms INTEGER);
    INSERT INTO tenant_limits VALUES ('usr_550e8400-e29b-41d4-a716-446655440000', 7, 100000, 0);`);
  const db: ControlPlaneDb = {
    first: async <T>(query: string, ...args: unknown[]) =>
      (sql.prepare(query).get(...args) as T) ?? null,
    all: async <T>(query: string, ...args: unknown[]) =>
      sql.prepare(query).all(...args) as T[],
    run: vi.fn(async (query: string, ...args: unknown[]) => ({
      changes: sql.prepare(query).run(...args).changes,
    })),
    batch: async () => {
      throw new Error("unexpected batch");
    },
  };
  const deps: PolicyDeps = {
    io: { stdout: vi.fn(), stderr: vi.fn() },
    connect: vi.fn(() => db),
    now: () => 123,
  };
  const row = () =>
    sql.prepare("SELECT * FROM system_policy").get() as Record<string, unknown>;
  return { db, deps, row, sql };
}
const base = ["--env", "staging", "--paid-work", "disabled"];
const execute = ["--execute", "--acknowledge-guard-version", "3"];
describe("system policy", () => {
  it("plans without writing and reports before/after", async () => {
    const { deps, db } = fixture();
    expect(await systemPolicyCommand.run(base, deps)).toBe(0);
    expect(db.run).not.toHaveBeenCalled();
    expect(deps.io.stdout).toHaveBeenCalledWith(
      expect.stringContaining('"paid_work_enabled": 0'),
    );
  });
  it("uses a versioned update, preserves unrelated fields, and refuses stale replay", async () => {
    const { deps, row } = fixture();
    await systemPolicyCommand.run([...base, ...execute], deps);
    expect(row()).toMatchObject({
      policy_version: 4,
      paid_work_enabled: 0,
      signup_mode: "closed",
      updated_at_ms: 123,
    });
    await expect(
      systemPolicyCommand.run([...base, ...execute], deps),
    ).rejects.toBeInstanceOf(UsageError);
    await systemPolicyCommand.run(
      [...base, "--execute", "--acknowledge-guard-version", "4"],
      deps,
    );
    expect(row().policy_version).toBe(4);
  });
  it("detects an edit between read and write", async () => {
    const { deps, db, sql } = fixture();
    const run = db.run;
    db.run = async (query, ...params) => {
      sql.exec("UPDATE system_policy SET policy_version = 4");
      return run(query, ...params);
    };
    await expect(
      systemPolicyCommand.run([...base, ...execute], deps),
    ).rejects.toThrow(/changed/);
    expect(
      sql.prepare("SELECT paid_work_enabled FROM system_policy").get(),
    ).toEqual({ paid_work_enabled: 1 });
  });
  it("changes one tenant budget using its own version", async () => {
    const { deps, row, sql } = fixture();
    await systemPolicyCommand.run(
      [
        "--env",
        "staging",
        "--tenant",
        "usr_550e8400-e29b-41d4-a716-446655440000",
        "--daily-spend-microdollars",
        "200000",
        "--execute",
        "--acknowledge-guard-version",
        "7",
      ],
      deps,
    );
    expect(sql.prepare("SELECT * FROM tenant_limits").get()).toMatchObject({
      policy_version: 8,
      daily_spend_microdollars: 200000,
    });
    expect(row().policy_version).toBe(3);
  });
  it.each(["0", "-1", "1.5", "1e6", "9007199254740992", "nope"])(
    "refuses budget %s before connecting",
    async (value) => {
      const { deps } = fixture();
      await expect(
        systemPolicyCommand.run(
          ["--env", "staging", "--daily-spend-microdollars", value],
          deps,
        ),
      ).rejects.toBeInstanceOf(UsageError);
      expect(deps.connect).not.toHaveBeenCalled();
    },
  );
  it("can disable an unconfigured policy but refuses enabling without a budget/catalog", async () => {
    const { deps, sql } = fixture();
    sql.exec(
      "UPDATE system_policy SET daily_spend_microdollars = NULL, catalog_version = 0",
    );
    await systemPolicyCommand.run([...base, ...execute], deps);
    await expect(
      systemPolicyCommand.run(
        ["--env", "staging", "--paid-work", "enabled"],
        deps,
      ),
    ).rejects.toThrow(/budget|catalog/);
  });
  it("redacts underlying adapter errors", async () => {
    const { deps, db } = fixture();
    db.first = async () => {
      throw new Error("secret-token");
    };
    await expect(systemPolicyCommand.run(base, deps)).rejects.toThrow(
      "Policy read failed",
    );
  });
});
