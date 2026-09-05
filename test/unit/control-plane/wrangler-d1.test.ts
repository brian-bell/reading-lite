import { describe, expect, it, vi } from "vitest";
import { makeWranglerD1 } from "../../../scripts/lib/founder-bootstrap";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import { parseUserId } from "../../../src/control-plane/ids";
import { createApiToken } from "../../../src/control-plane/tokens";

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
      await expect(adapter(wrap(block(0))).first("SELECT n FROM example")).resolves.toBeNull();
      await expect(adapter(wrap(block(0))).all("SELECT n FROM example")).resolves.toEqual([]);
    }
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

  it.each([0, 1])("uses the token INSERT's actual count %i for admission", async (changes) => {
    const run = vi.fn().mockResolvedValueOnce(response([block(changes)])).mockResolvedValueOnce(response([block(changes)]));
    const db = makeWranglerD1({ database: "test", local: false, run });
    const result = await createApiToken(db, {
      userId: parseUserId("usr_550e8400-e29b-41d4-a716-446655440000")!,
      name: "ops", scopes: ["readings:read"], nowMs: 1000, userAgentLabel: null,
      authRoot: { secret: parseAuthRootSecret("01".repeat(32)), version: 1 },
      newUuid: () => "770e8400-e29b-41d4-a716-446655440000",
      randomBytes: () => new Uint8Array(32).fill(0xab),
    });
    if (changes === 0) expect(result).toEqual({ kind: "cap" });
    else expect(result).toMatchObject({ kind: "ok", created: { token: `tok_770e8400-e29b-41d4-a716-446655440000.${"ab".repeat(32)}` } });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0][4]).toContain("INSERT INTO api_tokens");
    expect(run.mock.calls[1][0][4]).toContain("INSERT INTO api_token_scopes");
  });
});
