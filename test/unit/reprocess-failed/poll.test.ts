import { describe, expect, it, vi } from "vitest";
import { pollReadingTerminal } from "../../../scripts/reprocess-failed-lib/poll";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(responses: Response[]): typeof fetch {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("fake fetch exhausted");
    return next;
  }) as unknown as typeof fetch;
}

const baseOpts = {
  base: "http://127.0.0.1:8787",
  headers: { authorization: "Bearer t" },
  id: "rd_ONE",
  intervalMs: 10,
  timeoutMs: 1000,
};

describe("pollReadingTerminal", () => {
  it("returns ready when status flips to ready", async () => {
    const fetchFn = fakeFetch([
      jsonRes({ status: "pending" }),
      jsonRes({ status: "ready", id: "rd_ONE" }),
    ]);
    let nowMs = 0;
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms;
    });
    const outcome = await pollReadingTerminal(baseOpts, {
      fetch: fetchFn,
      sleep,
      now: () => nowMs,
    });
    expect(outcome.kind).toBe("ready");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("returns failed when status flips to failed and surfaces the error", async () => {
    const fetchFn = fakeFetch([
      jsonRes({ status: "pending" }),
      jsonRes({
        status: "failed",
        error: { code: "BadStatusError", message: "bad response status 500" },
      }),
    ]);
    let nowMs = 0;
    const outcome = await pollReadingTerminal(baseOpts, {
      fetch: fetchFn,
      sleep: async (ms) => {
        nowMs += ms;
      },
      now: () => nowMs,
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.error?.code).toBe("BadStatusError");
    }
  });

  it("returns timeout when status stays pending past the deadline", async () => {
    const fetchFn = fakeFetch([
      jsonRes({ status: "pending" }),
      jsonRes({ status: "pending" }),
      jsonRes({ status: "pending" }),
    ]);
    let nowMs = 0;
    const outcome = await pollReadingTerminal(
      { ...baseOpts, intervalMs: 100, timeoutMs: 150 },
      {
        fetch: fetchFn,
        sleep: async (ms) => {
          nowMs += ms;
        },
        now: () => nowMs,
      },
    );
    expect(outcome.kind).toBe("timeout");
    if (outcome.kind === "timeout") {
      expect(outcome.lastStatus).toBe("pending");
    }
  });

  it("throws when the GET fails with a non-2xx", async () => {
    const fetchFn = fakeFetch([new Response("nope", { status: 500 })]);
    await expect(
      pollReadingTerminal(baseOpts, {
        fetch: fetchFn,
        sleep: async () => {},
        now: () => 0,
      }),
    ).rejects.toThrow(/-> 500/);
  });
});
