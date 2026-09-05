import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { checkWipeDeployGate, UNFINISHED_WIPES_SQL } from "../../../scripts/lib/wipe-deploy-gate";

const queues = [
  { queue_name: "reading-lite-wipe", queue_id: "a".repeat(32) },
  { queue_name: "reading-lite-wipe-dlq", queue_id: "b".repeat(32) },
];
const ok = (result: unknown) => ({ success: true, result });
function fixture(overrides: Record<string, unknown> = {}) {
  const payloads: Record<string, unknown> = {
    d1: ok([{ success: true, results: [{ unfinished: 0 }] }]),
    list: { ...ok(queues), result_info: { page: 1, total_pages: 1 } },
    wipe: ok({ backlog_count: 0 }),
    dlq: ok({ backlog_count: 0 }),
    ...overrides,
  };
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const key = url.includes("/d1/") ? "d1" : url.includes("/metrics")
      ? url.includes("b".repeat(32)) ? "dlq" : "wipe" : "list";
    return Response.json(payloads[key]);
  });
  const run = () => checkWipeDeployGate({ accountId: "account", token: "secret", databaseId: "db", fetch: fetcher as typeof fetch });
  return { run, fetcher };
}

describe("production wipe deploy gate", () => {
  it("counts recent AND stale unfinished records, excluding completed records", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE wipe_progress (completed_at_ms INTEGER, updated_at_ms INTEGER)");
      db.exec("INSERT INTO wipe_progress VALUES (NULL, 1), (NULL, 9999999999999), (100, 9999999999999)");
      expect(db.prepare(UNFINISHED_WIPES_SQL).get()).toEqual({ unfinished: 2 });
    } finally { db.close(); }
  });
  it("passes only when D1 and both queues are clear", async () => {
    const { run, fetcher } = fixture();
    expect(await run()).toEqual({ unfinished: 0, queues: { "reading-lite-wipe": 0, "reading-lite-wipe-dlq": 0 } });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it.each([null, []])("accepts successful Cloudflare responses with errors=%j", async (errors) => {
    const { run, fetcher } = fixture({
      d1: { ...ok([{ success: true, results: [{ unfinished: 0 }] }]), errors },
      list: { ...ok(queues), result_info: { page: 1, total_pages: 1 }, errors },
      wipe: { ...ok({ backlog_count: 0 }), errors },
      dlq: { ...ok({ backlog_count: 0 }), errors },
    });
    await expect(run()).resolves.toEqual({ unfinished: 0, queues: { "reading-lite-wipe": 0, "reading-lite-wipe-dlq": 0 } });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it.each([
    { d1: ok([{ success: true, results: [{ unfinished: 1 }] }]) },
    { wipe: ok({ backlog_count: 1 }) },
    { dlq: ok({ backlog_count: 1 }) },
  ])("blocks unfinished work or either backlog: %j", async (override) => {
    await expect(fixture(override).run()).rejects.toThrow(/refusing/i);
  });
  it.each([
    { d1: { ...ok([{ success: true, results: [{ unfinished: 0 }] }]), errors: [{ message: "failed" }] } },
    { wipe: { ...ok({ backlog_count: 0 }), errors: "invalid" } },
    { dlq: { success: false, errors: null, result: { backlog_count: 0 } } },
    { d1: ok([{ success: false, results: [{ unfinished: 0 }] }]) },
    { d1: ok([]) },
    { d1: ok([{ success: true, results: [{ unfinished: "0" }] }]) },
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
  it("finds queues across pages", async () => {
    const { run, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(Response.json(ok([{ success: true, results: [{ unfinished: 0 }] }])));
    fetcher.mockResolvedValueOnce(Response.json({ ...ok([queues[0]]), result_info: { page: 1, total_pages: 2 } }));
    fetcher.mockResolvedValueOnce(Response.json({ ...ok([queues[1]]), result_info: { page: 2, total_pages: 2 } }));
    await run();
    expect(String(fetcher.mock.calls[2]![0])).toContain("page=2");
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
});
