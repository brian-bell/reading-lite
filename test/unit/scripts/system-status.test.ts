import { describe, expect, it, vi } from "vitest";
import {
  systemStatusCommand,
  type StatusDeps,
} from "../../../scripts/ops-lib/commands/system-status";
import type { ControlPlaneDb } from "../../../src/control-plane/db";
import { UsageError } from "../../../scripts/ops-lib/contract";
const tenant = "usr_550e8400-e29b-41d4-a716-446655440000";
function fixture() {
  const deps: StatusDeps = {
    io: { stdout: vi.fn(), stderr: vi.fn() },
    connect: vi.fn(() => ({
      close: async () => {},
      db: {
        first: async () => ({
          policy_version: 3,
          daily_spend_microdollars: 1000,
          paid_work_enabled: 0,
          catalog_version: 1,
        }),
      } as unknown as ControlPlaneDb,
    })),
    accounting: vi.fn(async () => ({
      dayKey: "2026-09-05",
      observedAtMs: 100,
      resetAtMs: 200,
      globalChargedMicrodollars: 500,
    })),
  };
  return deps;
}
describe("system status", () => {
  it("requires complete details and propagates the requested mode",async()=>{
    const deps=fixture();
    expect(await systemStatusCommand.run(["--env","staging","--details"],deps)).toBe(1);
    expect(deps.accounting).toHaveBeenCalledWith("staging",undefined,true);
    expect(deps.io.stderr).toHaveBeenCalledWith(expect.stringContaining("Inspection incomplete"));
  });
  it("reads the requested environment and tenant", async () => {
    const deps = fixture();
    expect(
      await systemStatusCommand.run(
        ["--env", "production", "--tenant", tenant],
        deps,
      ),
    ).toBe(0);
    expect(deps.connect).toHaveBeenCalledWith("production");
    expect(deps.accounting).toHaveBeenCalledWith("production", tenant);
    expect(deps.io.stdout).toHaveBeenCalledWith(
      expect.stringContaining('"globalChargedMicrodollars": 500'),
    );
  });
  it("shows policy but never reports zero when the guard is unavailable", async () => {
    const deps = fixture();
    deps.accounting = async () => {
      throw new Error("secret-token");
    };
    expect(await systemStatusCommand.run(["--env", "staging"], deps)).toBe(1);
    expect(deps.io.stdout).toHaveBeenCalledTimes(1);
    expect(deps.io.stderr).toHaveBeenCalledWith(
      expect.stringContaining("Accounting unavailable"),
    );
    expect(
      JSON.stringify([
        vi.mocked(deps.io.stdout).mock.calls,
        vi.mocked(deps.io.stderr).mock.calls,
      ]),
    ).not.toContain("secret-token");
  });
  it.each(
    [
      [],
      ["--env", "typo"],
      ["--env", "staging", "--execute"],
      ["--env", "staging", "--tenant", "bad"],
    ].map((argv) => ({ argv })),
  )("rejects invalid invocation $argv before connecting", async ({ argv }) => {
    const deps = fixture();
    await expect(systemStatusCommand.run(argv, deps)).rejects.toBeInstanceOf(
      UsageError,
    );
    expect(deps.connect).not.toHaveBeenCalled();
  });
});
