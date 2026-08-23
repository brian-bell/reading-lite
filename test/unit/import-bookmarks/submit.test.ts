import { describe, expect, it, vi } from "vitest";
import { submitAll, type SubmitResult } from "../../../scripts/import-bookmarks-lib/submit";
import type { ReadingApiOutcome } from "../../../scripts/lib/reading-api";

// The loop owns orchestration only; HTTP mechanics (auth, retry, decoding)
// live behind the injected Reading API client and are tested with it.
function apiStub(outcomes: ReadingApiOutcome[]) {
  let i = 0;
  return {
    submit: vi.fn(async (_url: string) => outcomes[Math.min(i++, outcomes.length - 1)]!),
  };
}

describe("submitAll", () => {
  it("classifies activated/existing/error outcomes and skips non-http schemes", async () => {
    const api = apiStub([
      { kind: "activated", id: "rd_new" },
      { kind: "existing", id: "rd_old" },
      { kind: "http_error", status: 500, message: "boom" },
    ]);
    const results: SubmitResult[] = [];
    const summary = await submitAll(
      [
        "https://new.test/",
        "https://old.test/",
        "https://broken.test/",
        "chrome://settings",
        "javascript:void(0)",
      ],
      { api, onResult: async (r) => void results.push(r) },
    );

    expect(api.submit).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ new: 1, existing: 1, errors: 1, skipped: 2 });

    const byUrl = Object.fromEntries(results.map((r) => [r.url, r]));
    expect(byUrl["https://new.test/"]!.classification).toBe("new");
    expect(byUrl["https://new.test/"]!.id).toBe("rd_new");
    expect(byUrl["https://old.test/"]!.classification).toBe("existing");
    expect(byUrl["https://old.test/"]!.id).toBe("rd_old");
    expect(byUrl["https://broken.test/"]!.classification).toBe("error");
    expect(byUrl["https://broken.test/"]!.error).toMatch(/500/);
    expect(byUrl["chrome://settings"]!.classification).toBe("skipped");
    expect(byUrl["javascript:void(0)"]!.classification).toBe("skipped");
  });

  it("counts an initializing owner as existing, not an error", async () => {
    const api = apiStub([{ kind: "initializing", id: "rd_racing" }]);
    const results: SubmitResult[] = [];
    const summary = await submitAll(["https://racing.test/"], {
      api,
      onResult: async (r) => void results.push(r),
    });
    expect(summary).toMatchObject({ existing: 1, errors: 0 });
    expect(results[0]!.classification).toBe("existing");
    expect(results[0]!.id).toBe("rd_racing");
  });

  it("counts a transport_error as an error with its message", async () => {
    const api = apiStub([
      { kind: "transport_error", message: "fetch failed / UND_ERR_SOCKET: Other side closed" },
    ]);
    const results: SubmitResult[] = [];
    const summary = await submitAll(["https://x.test/"], {
      api,
      onResult: async (r) => void results.push(r),
    });
    expect(summary.errors).toBe(1);
    expect(results[0]!.error).toBe("fetch failed / UND_ERR_SOCKET: Other side closed");
  });

  it("processes URLs serially (one submit in flight at a time)", async () => {
    let inFlight = 0;
    let peak = 0;
    const api = {
      submit: vi.fn(async (): Promise<ReadingApiOutcome> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { kind: "activated", id: "rd_x" };
      }),
    };
    await submitAll(
      Array.from({ length: 5 }, (_, i) => `https://${i}.test/`),
      { api, onResult: async () => {} },
    );
    expect(peak).toBe(1);
    expect(api.submit).toHaveBeenCalledTimes(5);
  });

  it("calls onResult once per URL with index/total set", async () => {
    const api = apiStub([{ kind: "activated", id: "rd_x" }]);
    const indices: number[] = [];
    const totals: number[] = [];
    await submitAll(["https://a.test/", "https://b.test/", "https://c.test/"], {
      api,
      onResult: async (r) => {
        indices.push(r.index);
        totals.push(r.total);
      },
    });
    expect(indices).toEqual([1, 2, 3]);
    expect(totals).toEqual([3, 3, 3]);
  });

  describe("beforeSubmit hook", () => {
    it("submits when the hook returns 'submit'", async () => {
      const api = apiStub([{ kind: "activated", id: "rd_x" }]);
      const summary = await submitAll(["https://a.test/", "https://b.test/"], {
        api,
        beforeSubmit: async () => "submit",
        onResult: async () => {},
      });
      expect(api.submit).toHaveBeenCalledTimes(2);
      expect(summary).toMatchObject({ new: 2, skipped: 0, errors: 0 });
    });

    it("counts a 'skip' decision as skipped without submitting", async () => {
      const api = apiStub([{ kind: "activated", id: "rd_x" }]);
      const decisions = ["submit", "skip", "submit"] as const;
      let i = 0;
      const summary = await submitAll(["https://a.test/", "https://b.test/", "https://c.test/"], {
        api,
        beforeSubmit: async () => decisions[i++]!,
        onResult: async () => {},
      });
      expect(api.submit).toHaveBeenCalledTimes(2);
      expect(summary).toMatchObject({ new: 2, skipped: 1, errors: 0 });
    });

    it("stops processing when the hook returns 'quit'", async () => {
      const api = apiStub([{ kind: "activated", id: "rd_x" }]);
      const decisions = ["submit", "quit", "submit"] as const;
      let i = 0;
      const calls: string[] = [];
      const summary = await submitAll(["https://a.test/", "https://b.test/", "https://c.test/"], {
        api,
        beforeSubmit: async (ctx) => {
          calls.push(ctx.url);
          return decisions[i++]!;
        },
        onResult: async () => {},
      });
      expect(calls).toEqual(["https://a.test/", "https://b.test/"]);
      expect(api.submit).toHaveBeenCalledTimes(1);
      expect(summary).toMatchObject({ new: 1, skipped: 0, errors: 0 });
    });

    it("skips non-http URLs without calling the hook", async () => {
      const api = apiStub([{ kind: "activated", id: "rd_x" }]);
      const seen: string[] = [];
      const summary = await submitAll(["chrome://settings", "https://x.test/"], {
        api,
        beforeSubmit: async (ctx) => {
          seen.push(ctx.url);
          return "submit";
        },
        onResult: async () => {},
      });
      expect(seen).toEqual(["https://x.test/"]);
      expect(summary).toMatchObject({ skipped: 1, new: 1 });
    });
  });
});
