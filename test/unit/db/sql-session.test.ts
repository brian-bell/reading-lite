import { describe, expect, it } from "vitest";
import { sqlSession, type Sql } from "../../../src/modules/db/sql";

// A fake client per open: records its queries and whether it was ended.
function fakeOpener(opts: { failOn?: string } = {}) {
  const clients: { queries: string[]; ended: boolean }[] = [];
  const open = (): Sql => {
    const client = { queries: [] as string[], ended: false };
    clients.push(client);
    const query = async (text: string) => {
      client.queries.push(text);
      if (text === opts.failOn) throw new Error("connection terminated");
      return [];
    };
    return {
      query: query as Sql["query"],
      transaction: async (run) => run({ query: query as Sql["query"] }),
      end: async () => {
        client.ended = true;
      },
    };
  };
  return { open, clients };
}

describe("sqlSession", () => {
  it("reuses one client while it keeps being used, and closes it on end", async () => {
    const { open, clients } = fakeOpener();
    const sql = sqlSession(open, { maxIdleMs: 10_000, now: () => 0 });

    await sql.query("a");
    await sql.transaction((tx) => tx.query("b"));
    await sql.query("c");
    await sql.end();

    expect(clients).toHaveLength(1);
    expect(clients[0]).toEqual({ queries: ["a", "b", "c"], ended: true });
  });

  it("opens nothing when never used", async () => {
    const { open, clients } = fakeOpener();
    await sqlSession(open).end();
    expect(clients).toHaveLength(0);
  });

  // The consumer idles across provider calls that can run for minutes; a
  // connection left that long must not be trusted.
  it("replaces a client that sat idle longer than the limit", async () => {
    const { open, clients } = fakeOpener();
    let t = 0;
    const sql = sqlSession(open, { maxIdleMs: 10_000, now: () => t });

    await sql.query("before");
    t = 10_001;
    await sql.query("after");

    expect(clients.map((c) => c.queries)).toEqual([["before"], ["after"]]);
    expect(clients[0]!.ended).toBe(true);
  });

  it("drops a client after an error, so the next operation reconnects", async () => {
    const { open, clients } = fakeOpener({ failOn: "boom" });
    const sql = sqlSession(open, { now: () => 0 });

    await expect(sql.query("boom")).rejects.toThrow("connection terminated");
    await sql.query("next");

    expect(clients).toHaveLength(2);
    expect(clients[0]!.ended).toBe(true);
    expect(clients[1]!.queries).toEqual(["next"]);
  });

  // One client runs one operation at a time.
  it("serializes concurrent operations on the shared client", async () => {
    const { open, clients } = fakeOpener();
    const sql = sqlSession(open, { now: () => 0 });

    await Promise.all([sql.query("1"), sql.transaction((tx) => tx.query("2")), sql.query("3")]);

    expect(clients).toHaveLength(1);
    expect(clients[0]!.queries).toEqual(["1", "2", "3"]);
  });
});
