import { describe, expect, it, vi } from "vitest";
import { checkWipeDeployGate, countUnfinishedWipes, UNFINISHED_WIPES_SQL } from "../../../scripts/lib/wipe-deploy-gate";
import { useRolledBackSql } from "../../helpers/pg-rollback";
import { testDatabaseUrl } from "../../helpers/test-database";

const queues = [
  { queue_name: "reading-lite-wipe", queue_id: "a".repeat(32) },
  { queue_name: "reading-lite-wipe-dlq", queue_id: "b".repeat(32) },
];
const ok = (result: unknown) => ({ success: true, result });
function fixture(overrides: Record<string, unknown> = {}, unfinished = 0) {
  const payloads: Record<string, unknown> = {
    list: { ...ok(queues), result_info: { page: 1, total_pages: 1 } },
    wipe: ok({ backlog_count: 0 }),
    dlq: ok({ backlog_count: 0 }),
    ...overrides,
  };
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const key = url.includes("/metrics")
      ? url.includes("b".repeat(32)) ? "dlq" : "wipe" : "list";
    return Response.json(payloads[key]);
  });
  const unfinishedWipes = vi.fn(async () => unfinished);
  const run = () => checkWipeDeployGate({
    accountId: "account", token: "secret", unfinishedWipes, fetch: fetcher as typeof fetch,
  });
  return { run, fetcher, unfinishedWipes };
}

describe("unfinished wipe records in PostgreSQL", () => {
  const sql = useRolledBackSql();

  const seedWipe = async (tenant: string, completed: string | null) => {
    await sql().query(
      `INSERT INTO users (id, email_canonical, email_display, status, created_at, updated_at)
       VALUES ($1, $2, $2, 'deleting', now(), now())`,
      [tenant, `${tenant}@test.example`],
    );
    await sql().query(
      "INSERT INTO wipe_progress (tenant_id, phase, updated_at, completed_at) VALUES ($1, 'rows', now(), $2)",
      [tenant, completed],
    );
  };

  it("counts recent AND stale unfinished records, excluding completed ones", async () => {
    await seedWipe("usr_stale", null);
    await seedWipe("usr_running", null);
    await seedWipe("usr_done", new Date().toISOString());
    const rows = await sql().query<{ unfinished: number }>(UNFINISHED_WIPES_SQL);
    expect(rows).toEqual([{ unfinished: 2 }]);
  });

  it("reads the count over a direct connection string, as a number", async () => {
    // The shared test database, outside this test's rolled-back transaction:
    // what matters is that a separate client parses count(*) into a number.
    await expect(countUnfinishedWipes(testDatabaseUrl())).resolves.toEqual(expect.any(Number));
  });
});

describe("production wipe deploy gate", () => {
  it("passes only when the control plane and both queues are clear", async () => {
    const { run, fetcher, unfinishedWipes } = fixture();
    expect(await run()).toEqual({ unfinished: 0, queues: { "reading-lite-wipe": 0, "reading-lite-wipe-dlq": 0 } });
    expect(unfinishedWipes).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([null, []])("accepts successful Cloudflare responses with errors=%j", async (errors) => {
    const { run, fetcher } = fixture({
      list: { ...ok(queues), result_info: { page: 1, total_pages: 1 }, errors },
      wipe: { ...ok({ backlog_count: 0 }), errors },
      dlq: { ...ok({ backlog_count: 0 }), errors },
    });
    await expect(run()).resolves.toEqual({ unfinished: 0, queues: { "reading-lite-wipe": 0, "reading-lite-wipe-dlq": 0 } });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("blocks unfinished wipe records", async () => {
    await expect(fixture({}, 1).run()).rejects.toThrow(/refusing/i);
  });
  it.each([
    { wipe: ok({ backlog_count: 1 }) },
    { dlq: ok({ backlog_count: 1 }) },
  ])("blocks either backlog: %j", async (override) => {
    await expect(fixture(override).run()).rejects.toThrow(/refusing/i);
  });
  it("fails closed when the control-plane count is unreadable", async () => {
    const { fetcher } = fixture();
    await expect(checkWipeDeployGate({
      accountId: "account",
      token: "secret",
      unfinishedWipes: async () => { throw new Error("missing DATABASE_URL"); },
      fetch: fetcher as typeof fetch,
    })).rejects.toThrow("missing DATABASE_URL");
  });
  it.each([
    { wipe: { ...ok({ backlog_count: 0 }), errors: "invalid" } },
    { dlq: { success: false, errors: null, result: { backlog_count: 0 } } },
    { list: { ...ok([]), result_info: { page: 1, total_pages: 1 } } },
    { list: { ...ok([queues[0], queues[0], queues[1]]), result_info: { page: 1, total_pages: 1 } } },
    { list: ok(queues) },
    { list: { ...ok(queues), result_info: { page: 2, total_pages: 2 } } },
    { wipe: ok({}) },
    { wipe: ok({ backlog_count: -1 }) },
    { wipe: ok({ backlog_count: 0.5 }) },
    { dlq: { success: false, result: { backlog_count: 0 } } },
  ])("fails closed on incomplete/invalid responses: %j", async (override) => {
    await expect(fixture(override).run()).rejects.toThrow();
  });
  it.each([-1, 0.5])("fails closed on an impossible record count: %s", async (unfinished) => {
    await expect(fixture({}, unfinished).run()).rejects.toThrow();
  });
  it("finds queues across pages", async () => {
    const { run, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(Response.json({ ...ok([queues[0]]), result_info: { page: 1, total_pages: 2 } }));
    fetcher.mockResolvedValueOnce(Response.json({ ...ok([queues[1]]), result_info: { page: 2, total_pages: 2 } }));
    await run();
    expect(String(fetcher.mock.calls[1]![0])).toContain("page=2");
  });
  it.each([403, 429, 500])("rejects HTTP %i without echoing upstream bodies", async (status) => {
    const { run, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(new Response("sensitive upstream text", { status }));
    await expect(run()).rejects.toThrow(`HTTP ${status}`);
  });
  it("rejects network errors and invalid JSON", async () => {
    const first = fixture();
    first.fetcher.mockRejectedValueOnce(new Error("network"));
    await expect(first.run()).rejects.toThrow();
    const second = fixture();
    second.fetcher.mockResolvedValueOnce(new Response("not json"));
    await expect(second.run()).rejects.toThrow();
  });
});

describe("wipe-check command override", () => {
  const sha = "a".repeat(40);
  it("bypasses reads only for the exact reviewed release and logs the bypass", async () => {
    const { deployWipeCheckCommand } = await import("../../../scripts/ops-lib/commands/deploy-wipe-check");
    const check = vi.fn();
    const stderr = vi.fn();
    expect(await deployWipeCheckCommand.run(["--release-sha", sha], {
      io: { stdout: vi.fn(), stderr }, overrideSha: sha, check,
    })).toBe(0);
    expect(check).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("OVERRIDDEN"));
  });
  it.each([undefined, "true", "b".repeat(40), ""])('does not bypass for override %s', async (overrideSha) => {
    const { deployWipeCheckCommand } = await import("../../../scripts/ops-lib/commands/deploy-wipe-check");
    const check = vi.fn().mockRejectedValue(new Error("blocked"));
    expect(await deployWipeCheckCommand.run(["--release-sha", sha], {
      io: { stdout: vi.fn(), stderr: vi.fn() }, overrideSha, check,
    })).toBe(1);
    expect(check).toHaveBeenCalledOnce();
  });
  it("requires a valid explicit release SHA for bypass", async () => {
    const { deployWipeCheckCommand } = await import("../../../scripts/ops-lib/commands/deploy-wipe-check");
    const deps = { io: { stdout: vi.fn(), stderr: vi.fn() }, overrideSha: sha, check: vi.fn().mockRejectedValue(new Error("blocked")) };
    expect(await deployWipeCheckCommand.run([], deps)).toBe(1);
    await expect(deployWipeCheckCommand.run(["--release-sha", "true"], deps)).rejects.toThrow("full lowercase");
  });
  it("returns success and emits counts for a clear snapshot", async () => {
    const { deployWipeCheckCommand } = await import("../../../scripts/ops-lib/commands/deploy-wipe-check");
    const stdout = vi.fn();
    expect(await deployWipeCheckCommand.run([], {
      io: { stdout, stderr: vi.fn() }, check: fixture().run,
    })).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"unfinished":0'));
  });
  it("names the connection-string variable it will read, defaulting to DATABASE_URL", async () => {
    const { deployWipeCheckCommand } = await import("../../../scripts/ops-lib/commands/deploy-wipe-check");
    const check = vi.fn(fixture().run);
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    expect(await deployWipeCheckCommand.run([], { io, check })).toBe(0);
    expect(check).toHaveBeenCalledWith("DATABASE_URL");
    expect(await deployWipeCheckCommand.run(["--database-url-env", "PRODUCTION_DATABASE_URL"], { io, check })).toBe(0);
    expect(check).toHaveBeenLastCalledWith("PRODUCTION_DATABASE_URL");
  });
});
