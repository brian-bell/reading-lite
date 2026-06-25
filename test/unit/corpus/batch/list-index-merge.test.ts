import { describe, expect, it, vi } from "vitest";
import { mergeListIndex, LIST_INDEX_KEY } from "../../../../scripts/corpus-lib/batch/list-index-merge";
import { PointerExistsError } from "../../../../scripts/lib/cf-clients";
import type { ListIndexItem } from "../../../../src/schemas/api";

function row(id: string, status: ListIndexItem["status"] = "pending"): ListIndexItem {
  return {
    id,
    key_prefix: `readings/2026/01/01T000000Z-${id}`,
    url: `https://example.com/${id}`,
    status,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

// A CAS-aware in-memory index/list.json fake with a settable "concurrent writer"
// hook that mutates the object (and bumps the etag) between our read and our write.
function fakeR2(seedItems: ListIndexItem[] | null = null) {
  let body: string | null = seedItems ? JSON.stringify({ version: 1, items: seedItems }) : null;
  let etag = 1;
  let onNextWrite: (() => void) | null = null;
  return {
    setConcurrentWriter: (fn: () => void) => {
      onNextWrite = fn;
    },
    // Inject a competing write that lands between this caller's getWithEtag and put.
    injectConcurrent: (items: ListIndexItem[]) => {
      body = JSON.stringify({ version: 1, items });
      etag += 1;
    },
    currentItems: () => (body ? (JSON.parse(body).items as ListIndexItem[]) : []),
    getWithEtag: vi.fn(async () => (body === null ? null : { body, etag: String(etag) })),
    put: vi.fn(async (_key: string, b: string, opts?: { ifNoneMatch?: "*"; ifMatch?: string }) => {
      // Fire the concurrent writer hook once, simulating an interleaved write that
      // changes the etag before our conditional PUT is evaluated.
      if (onNextWrite) {
        const fn = onNextWrite;
        onNextWrite = null;
        fn();
      }
      if (opts?.ifNoneMatch === "*" && body !== null) throw new PointerExistsError(LIST_INDEX_KEY);
      if (opts?.ifMatch !== undefined && opts.ifMatch !== String(etag)) throw new PointerExistsError(LIST_INDEX_KEY);
      body = b;
      etag += 1;
    }),
    // Unused by mergeListIndex but part of R2Client.
    get: vi.fn(async () => body),
    head: vi.fn(async () => body !== null),
    delete: vi.fn(async () => {
      body = null;
    }),
    listKeys: vi.fn(async () => (body === null ? [] : [LIST_INDEX_KEY])),
  };
}

const casDeps = (r2: ReturnType<typeof fakeR2>) => ({
  r2: r2 as any,
  baseDelayMs: 0,
  sleep: vi.fn(async () => {}),
  random: () => 0,
});

describe("mergeListIndex (CAS)", () => {
  it("creates index/list.json with If-None-Match: * when absent", async () => {
    const r2 = fakeR2(null);
    await mergeListIndex(casDeps(r2), [row("rd_a")]);
    expect(r2.currentItems().map((i) => i.id)).toEqual(["rd_a"]);
    expect(r2.put.mock.calls[0]![2]).toMatchObject({ ifNoneMatch: "*" });
  });

  it("updates with If-Match on the read etag, replacing same-id and same-key_prefix rows", async () => {
    const r2 = fakeR2([row("rd_a", "pending"), row("rd_b", "ready")]);
    await mergeListIndex(casDeps(r2), [row("rd_a", "ready")]);
    const items = r2.currentItems();
    expect(items.filter((i) => i.id === "rd_a")).toHaveLength(1);
    expect(items.find((i) => i.id === "rd_a")?.status).toBe("ready");
    expect(items.find((i) => i.id === "rd_b")?.status).toBe("ready"); // untouched
    expect(r2.put.mock.calls[0]![2]).toMatchObject({ ifMatch: "1" });
  });

  it("retries on a lost CAS and re-merges against the concurrent writer's rows (no lost row)", async () => {
    const r2 = fakeR2([row("rd_a")]);
    // Between our read and our write, an unrelated online submit writes rd_ONLINE.
    r2.setConcurrentWriter(() => r2.injectConcurrent([row("rd_a"), row("rd_ONLINE", "ready")]));

    await mergeListIndex(casDeps(r2), [row("rd_BATCH", "ready")]);

    // First PUT 412s (etag moved), we re-read and re-merge: the concurrent
    // rd_ONLINE row survives AND our rd_BATCH row lands. Nothing is clobbered.
    const ids = r2.currentItems().map((i) => i.id).sort();
    expect(ids).toEqual(["rd_BATCH", "rd_ONLINE", "rd_a"]);
    expect(r2.put).toHaveBeenCalledTimes(2); // first lost, second won
  });

  it("throws after exhausting CAS attempts under sustained contention", async () => {
    const r2 = fakeR2([row("rd_a")]);
    // Every attempt's write is preceded by a fresh concurrent bump → always 412.
    r2.put.mockImplementation(async () => {
      r2.injectConcurrent([row("rd_a")]);
      throw new PointerExistsError(LIST_INDEX_KEY);
    });
    await expect(
      mergeListIndex({ r2: r2 as any, maxAttempts: 3, baseDelayMs: 0, sleep: vi.fn(async () => {}), random: () => 0 }, [row("rd_b")]),
    ).rejects.toThrow(/exhausted 3 CAS attempts/);
  });

  it("is a no-op when there are no touched rows", async () => {
    const r2 = fakeR2([row("rd_a")]);
    await mergeListIndex(casDeps(r2), []);
    expect(r2.put).not.toHaveBeenCalled();
  });
});
