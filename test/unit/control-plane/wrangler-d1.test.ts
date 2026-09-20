import { describe, expect, it, vi } from "vitest";
import { makeWranglerD1 } from "../../../scripts/lib/founder-bootstrap";

const block = (changes: number, results: unknown[] = []) => ({ success: true, results, meta: { changes } });
const response = (body: unknown) => ({ stdout: JSON.stringify(body), stderr: "", code: 0 });
const adapter = (body: unknown) => makeWranglerD1({ database: "test", local: false, run: async () => response(body) });

describe("makeWranglerD1", () => {
  it.each([0, 1, 7])("preserves %i affected rows in array and object envelopes", async (changes) => {
    for (const body of [block(changes), [block(changes)]]) {
      await expect(adapter(body).run("UPDATE example SET n = 1")).resolves.toEqual({ changes });
    }
  });

  it("returns each batch statement's count in execution order", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(response([block(3)]))
      .mockResolvedValueOnce(response([block(0)]))
      .mockResolvedValueOnce(response([block(1)]));
    const db = makeWranglerD1({ database: "test", local: false, run });
    await expect(db.batch([3, 0, 1].map((n) => ({ sql: "UPDATE example SET n = ?", params: [n] })))).resolves.toEqual([
      { changes: 3 }, { changes: 0 }, { changes: 1 },
    ]);
    expect(run.mock.calls.map(([args]) => args[4])).toEqual([
      "UPDATE example SET n = 3", "UPDATE example SET n = 0", "UPDATE example SET n = 1",
    ]);
  });

  it.each([
    null, [], {}, { results: [], meta: { changes: 1 } },
    { ...block(1), success: false }, { ...block(1), success: "true" },
    { ...block(1), meta: undefined }, { ...block(1), meta: null },
    { ...block(1), meta: {} }, ...[null, "1", -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((changes) => ({ ...block(1), meta: { changes } })),
    { ...block(1), results: null }, [block(1), block(2)],
  ].map((body) => ({ body })))("rejects invalid write response $body in run and batch", async ({ body }) => {
    await expect(adapter(body).run("UPDATE example SET n = 1")).rejects.toThrow(/wrangler d1/i);
    await expect(adapter(body).batch([{ sql: "UPDATE example SET n = 1", params: [] }])).rejects.toThrow(/wrangler d1/i);
  });

  it("rejects invalid JSON explicitly", async () => {
    const db = makeWranglerD1({ database: "test", local: false, run: async () => ({ stdout: "not json", stderr: "", code: 0 }) });
    await expect(db.run("UPDATE example SET n = 1")).rejects.toThrow(/wrangler d1/i);
  });

  it.each(["database unavailable", ""])("rejects command failures and stops a batch: %s", async (stderr) => {
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify([block(1)]), code: 1, stderr });
    const db = makeWranglerD1({ database: "test", local: false, run });
    await expect(db.run("UPDATE example SET n = 1")).rejects.toThrow(stderr || /failed \(1\)/);
    run.mockClear();
    await expect(db.batch([{ sql: "UPDATE example SET n = 1", params: [] }, { sql: "DELETE FROM example", params: [] }])).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("preserves first/all rows and empty reads without requiring write metadata", async () => {
    for (const wrap of [(value: unknown) => value, (value: unknown) => [value]]) {
      const db = adapter(wrap({ success: true, results: [{ n: 1 }, { n: 2 }] }));
      await expect(db.first("SELECT n FROM example")).resolves.toEqual({ n: 1 });
      await expect(db.all("SELECT n FROM example")).resolves.toEqual([{ n: 1 }, { n: 2 }]);
      await expect(adapter(wrap({ success: true, results: [] })).first("SELECT n FROM example")).resolves.toBeNull();
      await expect(adapter(wrap({ success: true, results: [] })).all("SELECT n FROM example")).resolves.toEqual([]);
    }
  });

  it.each([null, [], {}, { results: [] }, { success: false, results: [] },
    { success: "true", results: [] }, { success: true }, { success: true, results: {} },
    { success: true, results: null }, [block(0), block(0)],
  ])("rejects malformed first/all responses %j", async (body) => {
    await expect(adapter(body).first("SELECT n FROM example")).rejects.toThrow(/wrangler d1/i);
    await expect(adapter(body).all("SELECT n FROM example")).rejects.toThrow(/wrangler d1/i);
  });
  it("rejects invalid JSON in first/all", async () => {
    const db = makeWranglerD1({ database: "test", local: false, run: async () => ({ stdout: "not json", stderr: "", code: 0 }) });
    await expect(db.first("SELECT n FROM example")).rejects.toThrow(/wrangler d1/i);
    await expect(db.all("SELECT n FROM example")).rejects.toThrow(/wrangler d1/i);
  });

  it("does not execute an empty batch", async () => {
    const run = vi.fn();
    await expect(makeWranglerD1({ database: "test", local: false, run }).batch([])).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("stops a batch when a statement has missing write metadata", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(response([block(1)]))
      .mockResolvedValueOnce(response([{ success: true, results: [], meta: {} }]));
    const db = makeWranglerD1({ database: "test", local: false, run });
    await expect(db.batch([1, 2, 3].map((n) => ({ sql: "UPDATE example SET n = ?", params: [n] })))).rejects.toThrow(/meta.changes/);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([
    { local: true, wranglerEnv: undefined, flags: ["--local"] },
    { local: false, wranglerEnv: undefined, flags: ["--remote"] },
    { local: false, wranglerEnv: "staging" as const, flags: ["--remote", "--env", "staging"] },
    { local: false, wranglerEnv: "production" as const, flags: ["--remote", "--env", "production"] },
  ])("preserves routing and parameter rendering: %j", async ({ local, wranglerEnv, flags }) => {
    const run = vi.fn().mockResolvedValue(response([block(1)]));
    await makeWranglerD1({ database: "test-db", local, wranglerEnv, run }).all("SELECT * FROM example WHERE name = ?", "O'Brien");
    expect(run).toHaveBeenCalledWith(["d1", "execute", "test-db", "--command", "SELECT * FROM example WHERE name = 'O''Brien'", "--json", ...flags]);
  });
});
