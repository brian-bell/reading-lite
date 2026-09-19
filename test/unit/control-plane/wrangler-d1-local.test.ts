import { describe, expect, it, vi } from "vitest";
import { makeWranglerD1 } from "../../../scripts/lib/founder-bootstrap";

const block = (results: unknown[] = []) => ({ success: true, results, meta: { duration: 1 } });
const response = (body: unknown) => ({ code: 0, stderr: "", stdout: JSON.stringify(body) });
const writeResponse = (changes: number) => response([block(), block([{ changes }])]);

describe("makeWranglerD1 local writes", () => {
  it.each([0, 1, 7])("obtains %i changes in the write's invocation", async (changes) => {
    const run = vi.fn().mockResolvedValue(writeResponse(changes));
    const db = makeWranglerD1({ database: "local-test", local: true, run });
    await expect(db.run("UPDATE example SET n = ?; -- trailing comment", 2)).resolves.toEqual({ changes });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith([
      "d1", "execute", "local-test", "--command",
      "UPDATE example SET n = 2; -- trailing comment\n;\nSELECT changes() AS changes;", "--json", "--local",
    ]);
  });

  it("preserves local batch order and actual zero counts", async () => {
    const run = vi.fn().mockResolvedValueOnce(writeResponse(2)).mockResolvedValueOnce(writeResponse(0)).mockResolvedValueOnce(writeResponse(1));
    const db = makeWranglerD1({ database: "local-test", local: true, run });
    await expect(db.batch([2, 0, 1].map((n) => ({ sql: "UPDATE example SET n = ?", params: [n] })))).resolves.toEqual([
      { changes: 2 }, { changes: 0 }, { changes: 1 },
    ]);
    expect(run.mock.calls.map(([args]) => args[4])).toEqual([2, 0, 1].map((n) => `UPDATE example SET n = ${n}\n;\nSELECT changes() AS changes;`));
  });

  it.each([
    [], [block()], [block(), block(), block()],
    [{ ...block(), success: false }, block([{ changes: 1 }])],
    [block(), { ...block([{ changes: 1 }]), success: false }],
    [block(), { results: [{ changes: 1 }] }],
    [block(), block()], [block(), block([{ changes: 1 }, { changes: 2 }])],
    ...[null, {}, { changes: "1" }, { changes: -1 }, { changes: 1.5 }, { changes: null }, { changes: Number.MAX_SAFE_INTEGER + 1 }].map((row) => [block(), block([row])]),
  ].map((body) => ({ body })))("rejects invalid local count response $body", async ({ body }) => {
    const run = vi.fn().mockResolvedValue(response(body));
    const db = makeWranglerD1({ database: "local-test", local: true, run });
    await expect(db.run("UPDATE example SET n = 1")).rejects.toThrow(/wrangler d1/i);
    run.mockClear();
    await expect(db.batch([1, 2].map((n) => ({ sql: "UPDATE example SET n = ?", params: [n] })))).rejects.toThrow(/wrangler d1/i);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("leaves local read commands and duration-only responses unchanged", async () => {
    const run = vi.fn().mockResolvedValue(response([block([{ n: 2 }])]));
    const db = makeWranglerD1({ database: "local-test", local: true, run });
    await expect(db.first("SELECT n FROM example")).resolves.toEqual({ n: 2 });
    await expect(db.all("SELECT n FROM example")).resolves.toEqual([{ n: 2 }]);
    expect(run.mock.calls.map(([args]) => args[4])).toEqual(["SELECT n FROM example", "SELECT n FROM example"]);
    run.mockClear();
    await expect(db.batch([])).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
