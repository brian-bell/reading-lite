import { describe, expect, it, vi } from "vitest";
import {
  systemPolicyCommand,
  type PolicyDeps,
} from "../../../scripts/ops-lib/commands/system-policy";
import type { ControlPlaneDb } from "../../../src/control-plane/db";
import { UsageError } from "../../../scripts/ops-lib/contract";
import { useControlPlane } from "../../helpers/control-plane-pg";
import { mintUserId } from "../../../src/control-plane/ids";

// The command runs against the migrated control-plane schema (migration 0003):
// `updated_at` timestamptz, `paid_work_enabled` boolean, and tenant_limits
// rows that need their user. Each test's writes roll back.
//
// The tenants are minted per test, and their rows are written before the
// system_policy singleton: the shared test users (usr_550e8400-…) are locked
// by other files that then touch system_policy, and taking the two in the
// opposite order deadlocks their rolled-back transactions against ours.
const openControlPlane = useControlPlane();
const SEEDED_AT = "2026-01-01T00:00:00.000Z";

async function fixture() {
  const { db: base, raw } = openControlPlane();
  const TENANT_A = String(mintUserId());
  const TENANT_B = String(mintUserId());
  for (const [tenant, version, budget] of [[TENANT_A, 7, 100000], [TENANT_B, 11, 300000]] as const) {
    await raw.run(
      `INSERT INTO users (id, email_canonical, email_display, status, email_verified_at, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
      tenant, `${tenant}@test.example`, `${tenant}@test.example`, SEEDED_AT, SEEDED_AT, SEEDED_AT,
    );
    await raw.run(
      `INSERT INTO tenant_limits (tenant_id, policy_version, submissions_per_hour, monthly_readings, max_concurrent_work, daily_spend_microdollars, created_at, updated_at)
       VALUES (?, ?, 10, 100, 3, ?, ?, ?)`,
      tenant, version, budget, SEEDED_AT, SEEDED_AT,
    );
  }
  await raw.run(
    `INSERT INTO system_policy (id, signup_mode, paid_work_enabled, policy_version, catalog_version, updated_at, daily_spend_microdollars)
     VALUES (1, 'closed', true, 3, 1, ?, 1000000)
     ON CONFLICT (id) DO UPDATE SET signup_mode = excluded.signup_mode, paid_work_enabled = excluded.paid_work_enabled,
       policy_version = excluded.policy_version, catalog_version = excluded.catalog_version,
       updated_at = excluded.updated_at, daily_spend_microdollars = excluded.daily_spend_microdollars`,
    SEEDED_AT,
  );
  const db: ControlPlaneDb = { ...base, run: vi.fn(base.run) };
  const deps: PolicyDeps = {
    io: { stdout: vi.fn(), stderr: vi.fn() },
    connect: vi.fn(() => ({ db, close: async () => {} })),
    now: () => 123,
  };
  const row = async () =>
    (await raw.first<Record<string, unknown>>("SELECT * FROM system_policy WHERE id = 1"))!;
  const limits = (tenant: string) =>
    raw.first("SELECT policy_version, daily_spend_microdollars FROM tenant_limits WHERE tenant_id = ?", tenant);
  return { db, deps, row, limits, raw, TENANT_A, TENANT_B };
}
const base = ["--env", "staging", "--paid-work", "disabled"];
const execute = ["--execute", "--acknowledge-guard-version", "3"];
describe("system policy", () => {
  it("plans without writing and reports before/after", async () => {
    const { deps, db } = await fixture();
    expect(await systemPolicyCommand.run(base, deps)).toBe(0);
    expect(db.run).not.toHaveBeenCalled();
    expect(deps.io.stdout).toHaveBeenCalledWith(
      expect.stringContaining('"paid_work_enabled": 0'),
    );
  });
  it("uses a versioned update, preserves unrelated fields, and refuses stale replay", async () => {
    const { deps, row } = await fixture();
    await systemPolicyCommand.run([...base, ...execute], deps);
    expect(await row()).toMatchObject({
      policy_version: 4,
      paid_work_enabled: false,
      signup_mode: "closed",
      daily_spend_microdollars: 1000000,
    });
    expect(Date.parse(String((await row()).updated_at))).toBe(123);
    await expect(
      systemPolicyCommand.run([...base, ...execute], deps),
    ).rejects.toBeInstanceOf(UsageError);
    await systemPolicyCommand.run(
      [...base, "--execute", "--acknowledge-guard-version", "4"],
      deps,
    );
    expect((await row()).policy_version).toBe(4);
  });
  it("detects an edit between read and write", async () => {
    const { deps, db, raw, row } = await fixture();
    const run = db.run;
    db.run = async (query, ...params) => {
      await raw.run("UPDATE system_policy SET policy_version = 4 WHERE id = 1");
      return run(query, ...params);
    };
    await expect(
      systemPolicyCommand.run([...base, ...execute], deps),
    ).rejects.toThrow(/changed/);
    expect((await row()).paid_work_enabled).toBe(true);
  });
  it("changes only the selected tenant's budget, under its own version", async () => {
    const { deps, row, limits, TENANT_A, TENANT_B } = await fixture();
    await systemPolicyCommand.run(
      [
        "--env", "staging", "--tenant", TENANT_A,
        "--daily-spend-microdollars", "200000", "--execute",
        "--acknowledge-guard-version", "7",
      ],
      deps,
    );
    expect(await limits(TENANT_A)).toEqual({ policy_version: 8, daily_spend_microdollars: 200000 });
    expect(await limits(TENANT_B)).toEqual({ policy_version: 11, daily_spend_microdollars: 300000 });
    expect((await row()).policy_version).toBe(3);
  });
  it.each(["0", "-1", "1.5", "1e6", "9007199254740992", "nope"])(
    "refuses budget %s before connecting",
    async (value) => {
      const { deps } = await fixture();
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
    const { deps, raw } = await fixture();
    await raw.run(
      "UPDATE system_policy SET daily_spend_microdollars = NULL, catalog_version = 0 WHERE id = 1",
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
    const { deps, db } = await fixture();
    db.first = async () => {
      throw new Error("secret-token");
    };
    await expect(systemPolicyCommand.run(base, deps)).rejects.toThrow(
      "Policy read failed",
    );
  });
});
