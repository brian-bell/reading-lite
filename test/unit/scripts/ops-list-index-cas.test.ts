import { describe, expect, it } from "vitest";
import {
  casMergeListIndex,
  mergeListRows,
  type ListIndexCasClient,
  type ListRowPatch,
} from "../../../scripts/ops-lib/list-index-cas";

const KEY = "index/list.json";

function row(
  id: string,
  extra: Record<string, unknown> = {},
): { id: string } & Record<string, unknown> {
  return {
    id,
    key_prefix: `readings/2026/${id}`,
    url: `https://example.com/${id}`,
    status: "ready",
    title: id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

const SNAPSHOT = { count: 2, max: 0.81, mean: 0.7, computed_at: "2026-09-01T00:00:00.000Z" };

interface FakeOpts {
  /** Documents returned by successive reads. The last one repeats. */
  reads: Array<Array<Record<string, unknown>>>;
  /** How many putIfMatch calls answer 412 (false) before one succeeds. */
  conflicts?: number;
  missing?: boolean;
  etag?: (attempt: number) => string;
}

function fakeClient(opts: FakeOpts) {
  const calls: string[] = [];
  const writes: Array<{ body: string; etag: string }> = [];
  let reads = 0;
  let conflicts = opts.conflicts ?? 0;
  const client: ListIndexCasClient = {
    async getWithEtag(key) {
      calls.push(`get ${key}`);
      if (opts.missing) return null;
      const items = opts.reads[Math.min(reads, opts.reads.length - 1)]!;
      const etag = opts.etag?.(reads) ?? `e${reads}`;
      reads++;
      return { body: JSON.stringify({ version: 1, items }), etag };
    },
    async putIfMatch(key, body, etag) {
      calls.push(`put ${key} ${etag}`);
      writes.push({ body, etag });
      if (conflicts > 0) {
        conflicts--;
        return false;
      }
      return true;
    },
  };
  const written = () =>
    writes.map((write) => JSON.parse(write.body) as { version: number; items: Array<Record<string, unknown>> });
  return { client, calls, writes, written };
}

function noWait() {
  const sleeps: number[] = [];
  return {
    sleeps,
    deps: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      baseDelayMs: 20,
    },
  };
}

describe("mergeListRows", () => {
  it("writes only the mergeable fields of the rows a run touched", () => {
    const items = [row("rd_a", { title: "Live title" }), row("rd_b")];
    const merged = mergeListRows(items, [{ id: "rd_a", similarity: SNAPSHOT }]);

    // The refresh owns `similarity`; a concurrently rewritten title is not
    // reverted, and an unmeasured row is not rewritten at all.
    expect(merged[0]).toEqual({ ...items[0], similarity: SNAPSHOT });
    expect(merged[1]).toBe(items[1]);
  });

  it("removes a field whose patch value is undefined", () => {
    const items = [row("rd_a", { novelty_verdict: "novel", similarity: SNAPSHOT })];
    const patch: ListRowPatch = { id: "rd_a", novelty_verdict: undefined };

    const merged = mergeListRows(items, [patch]);

    expect(merged[0]).not.toHaveProperty("novelty_verdict");
    expect(merged[0]!.similarity).toEqual(SNAPSHOT);
  });

  it("drops a patch whose row is gone rather than resurrecting it", () => {
    const merged = mergeListRows([row("rd_b")], [{ id: "rd_a", similarity: SNAPSHOT }]);
    expect(merged.map((item) => item.id)).toEqual(["rd_b"]);
  });
});

describe("casMergeListIndex", () => {
  it("re-reads and re-applies after a 412, then succeeds", async () => {
    const fake = fakeClient({ reads: [[row("rd_a")]], conflicts: 1 });
    const wait = noWait();

    await casMergeListIndex(fake.client, KEY, [{ id: "rd_a", similarity: SNAPSHOT }], wait.deps);

    expect(fake.calls).toEqual([`get ${KEY}`, `put ${KEY} e0`, `get ${KEY}`, `put ${KEY} e1`]);
    // The second attempt is built from the second read, not from the body the
    // lost put had already serialized.
    expect(fake.written()[1]!.items[0]!.similarity).toEqual(SNAPSHOT);
    expect(wait.sleeps).toEqual([10]);
  });

  it("keeps a row inserted while the run was measuring", async () => {
    // The corpus gained rd_new between the run's read and the flush's retry.
    const fake = fakeClient({
      reads: [[row("rd_a")], [row("rd_a"), row("rd_new")]],
      conflicts: 1,
    });

    await casMergeListIndex(
      fake.client,
      KEY,
      [{ id: "rd_a", similarity: SNAPSHOT }],
      noWait().deps,
    );

    const final = fake.written()[1]!;
    expect(final.items.map((item) => item.id)).toEqual(["rd_a", "rd_new"]);
    expect(final.items[1]).toEqual(row("rd_new"));
    expect(final.items[0]!.similarity).toEqual(SNAPSHOT);
  });

  it("gives up after the attempt budget rather than clobbering", async () => {
    const fake = fakeClient({ reads: [[row("rd_a")]], conflicts: 99 });
    const wait = noWait();

    await expect(
      casMergeListIndex(fake.client, KEY, [{ id: "rd_a", similarity: SNAPSHOT }], {
        ...wait.deps,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/exhausted 3 CAS attempts/);
    expect(fake.writes).toHaveLength(3);
    // No sleep after the final attempt.
    expect(wait.sleeps).toEqual([10, 20]);
  });

  it("refuses to recreate a list index that is gone", async () => {
    const fake = fakeClient({ reads: [], missing: true });

    await expect(
      casMergeListIndex(fake.client, KEY, [{ id: "rd_a", similarity: SNAPSHOT }], noWait().deps),
    ).rejects.toThrow(/not found/);
    expect(fake.writes).toHaveLength(0);
  });

  it("refuses a read that carried no ETag", async () => {
    const fake = fakeClient({ reads: [[row("rd_a")]], etag: () => "" });

    await expect(
      casMergeListIndex(fake.client, KEY, [{ id: "rd_a", similarity: SNAPSHOT }], noWait().deps),
    ).rejects.toThrow(/without an ETag/);
    expect(fake.writes).toHaveLength(0);
  });

  it("re-reads after a transient write failure and reports it if it never lands", async () => {
    // The transport refuses to retry a conditional PUT, so a 500 arrives as a
    // throw. Re-reading is safe here, and a permanent error must not be
    // reported as contention.
    let puts = 0;
    const client: ListIndexCasClient = {
      getWithEtag: async () => ({
        body: JSON.stringify({ version: 1, items: [row("rd_a")] }),
        etag: "e0",
      }),
      putIfMatch: async () => {
        puts++;
        if (puts === 1) throw new Error("R2 PUT failed: 500");
        return puts > 2;
      },
    };

    await casMergeListIndex(client, KEY, [{ id: "rd_a", similarity: SNAPSHOT }], noWait().deps);
    // Throw, lost CAS, then the write that lands.
    expect(puts).toBe(3);
  });

  it("reports the transport failure rather than blaming contention", async () => {
    const client: ListIndexCasClient = {
      getWithEtag: async () => ({
        body: JSON.stringify({ version: 1, items: [row("rd_a")] }),
        etag: "e0",
      }),
      putIfMatch: async () => {
        throw new Error("R2 PUT failed: 503");
      },
    };

    await expect(
      casMergeListIndex(client, KEY, [{ id: "rd_a", similarity: SNAPSHOT }], {
        ...noWait().deps,
        maxAttempts: 2,
      }),
    ).rejects.toThrow(/last failure: R2 PUT failed: 503/);
  });

  it("rejects a row that carries no id", async () => {
    const client: ListIndexCasClient = {
      getWithEtag: async () => ({
        body: JSON.stringify({ version: 1, items: [row("rd_a"), null] }),
        etag: "e0",
      }),
      putIfMatch: async () => true,
    };

    await expect(
      casMergeListIndex(client, KEY, [{ id: "rd_a", similarity: SNAPSHOT }], noWait().deps),
    ).rejects.toThrow(/has a row with no string id/);
  });

  it("rejects a document with no items array", async () => {
    const client: ListIndexCasClient = {
      getWithEtag: async () => ({ body: JSON.stringify({ version: 1 }), etag: "e0" }),
      putIfMatch: async () => true,
    };

    await expect(
      casMergeListIndex(client, KEY, [{ id: "rd_a", similarity: SNAPSHOT }], noWait().deps),
    ).rejects.toThrow(/has no items array/);
  });

  it("makes no request when nothing was measured", async () => {
    const fake = fakeClient({ reads: [[row("rd_a")]] });
    await casMergeListIndex(fake.client, KEY, [], noWait().deps);
    expect(fake.calls).toEqual([]);
  });
});
