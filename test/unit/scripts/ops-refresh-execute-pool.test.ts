import { describe, expect, it } from "vitest";
import { UsageError } from "../../../scripts/ops-lib/contract";
import { RateLimitedError } from "../../../src/modules/http-retry";
import {
  DEFAULT_EXECUTE_CONCURRENCY,
  DEFAULT_MAX_BACKOFF_MS,
  MAX_EXECUTE_CONCURRENCY,
  MAX_MAX_BACKOFF_MS,
  MIN_MAX_BACKOFF_MS,
  RATE_LIMIT_DEFAULT_BACKOFF_MS,
  RATE_LIMIT_MAX_BACKOFF_MS,
  createRateLimitGate,
  judgeWithRateLimitRetry,
  parseConcurrencyFlag,
  parseMaxBackoffFlag,
} from "../../../scripts/ops-lib/execute-pool";

function gateHarness(options: { startMs?: number; maxBackoffMs?: number } = {}) {
  let now = options.startMs ?? 1_000;
  const sleeps: number[] = [];
  const pauses: number[] = [];
  const ceilings: number[] = [];
  const gate = createRateLimitGate({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    onPause: (ms) => pauses.push(ms),
    onCeiling: (totalMs) => ceilings.push(totalMs),
  });
  return { gate, sleeps, pauses, ceilings, advance: (ms: number) => (now += ms) };
}

describe("parseConcurrencyFlag", () => {
  it("defaults to the captain's four in flight", () => {
    expect(parseConcurrencyFlag(undefined)).toBe(DEFAULT_EXECUTE_CONCURRENCY);
    expect(DEFAULT_EXECUTE_CONCURRENCY).toBe(4);
  });

  it("accepts a positive integer", () => {
    expect(parseConcurrencyFlag("1")).toBe(1);
    expect(parseConcurrencyFlag("12")).toBe(12);
  });

  it("rejects anything else as a usage error", () => {
    for (const raw of ["0", "-1", "2.5", "many", ""]) {
      expect(() => parseConcurrencyFlag(raw)).toThrow(UsageError);
    }
  });

  it("refuses a figure that would fan a mistyped flag at the shared org", () => {
    expect(parseConcurrencyFlag(String(MAX_EXECUTE_CONCURRENCY))).toBe(
      MAX_EXECUTE_CONCURRENCY,
    );
    expect(() => parseConcurrencyFlag(String(MAX_EXECUTE_CONCURRENCY + 1))).toThrow(
      /above the 16 this command allows/,
    );
    expect(() => parseConcurrencyFlag("400")).toThrow(UsageError);
  });
});

describe("parseMaxBackoffFlag", () => {
  it("defaults to the captain's ten minutes", () => {
    expect(parseMaxBackoffFlag(undefined)).toBe(DEFAULT_MAX_BACKOFF_MS);
    expect(DEFAULT_MAX_BACKOFF_MS).toBe(10 * 60_000);
  });

  it("reads every unit it documents, and seconds when none is given", () => {
    expect(parseMaxBackoffFlag("90")).toBe(90_000);
    expect(parseMaxBackoffFlag("90s")).toBe(90_000);
    expect(parseMaxBackoffFlag("90000ms")).toBe(90_000);
    expect(parseMaxBackoffFlag("10m")).toBe(600_000);
  });

  // A budget under a single honoured window stops the pass on its first 429,
  // which reads as a dead provider; the unit confusion behind it (10 meaning
  // ten minutes) is the mistake this catches.
  it("rejects a budget below the 30s floor, naming the bare unit", () => {
    for (const raw of ["10", "29s", "1ms", "29999ms"]) {
      expect(() => parseMaxBackoffFlag(raw)).toThrow(UsageError);
      expect(() => parseMaxBackoffFlag(raw)).toThrow(/is below the 30s this command allows/);
    }
    expect(() => parseMaxBackoffFlag("10")).toThrow(/bare unit is seconds/);
    expect(parseMaxBackoffFlag("30s")).toBe(MIN_MAX_BACKOFF_MS);
  });

  // Above half an hour the budget has stopped bounding the sole-writer window
  // it exists to bound — `600m` for `600` is the other half of the same typo.
  it("rejects a budget above the 30m ceiling", () => {
    for (const raw of ["31m", "2h", "600m", "1801s"]) {
      expect(() => parseMaxBackoffFlag(raw)).toThrow(UsageError);
      expect(() => parseMaxBackoffFlag(raw)).toThrow(/is above the 30m this command allows/);
    }
    expect(() => parseMaxBackoffFlag("2h")).toThrow(/holds the sole-writer window/);
    expect(parseMaxBackoffFlag("30m")).toBe(MAX_MAX_BACKOFF_MS);
  });

  it("keeps the default inside its own bounds", () => {
    expect(DEFAULT_MAX_BACKOFF_MS).toBeGreaterThanOrEqual(MIN_MAX_BACKOFF_MS);
    expect(DEFAULT_MAX_BACKOFF_MS).toBeLessThanOrEqual(MAX_MAX_BACKOFF_MS);
  });

  it("rejects a non-duration or a zero as a usage error", () => {
    for (const raw of ["0", "0m", "-5", "5 m", "five", "", "5x", "1.5m"]) {
      expect(() => parseMaxBackoffFlag(raw)).toThrow(UsageError);
    }
  });

  it("rejects Infinity, NaN, and any other non-finite parsed wait", () => {
    // Enough digits that Number() is Infinity, and a finite magnitude whose
    // hours overflow the product. `ms <= 0` would still pass both, and the
    // hard ceiling would never trip.
    for (const raw of [
      `1${"0".repeat(400)}`,
      `1${"0".repeat(400)}ms`,
      `1${"0".repeat(400)}s`,
      `1${"0".repeat(304)}h`,
    ]) {
      expect(() => parseMaxBackoffFlag(raw)).toThrow(UsageError);
      expect(() => parseMaxBackoffFlag(raw)).toThrow(/finite positive duration/);
    }
  });
});

describe("createRateLimitGate", () => {
  it("lets every worker through until a limit is reported", async () => {
    const h = gateHarness();
    await h.gate.wait();
    await h.gate.wait();
    expect(h.sleeps).toEqual([]);
    expect(h.gate.stopped()).toBe(false);
  });

  it("holds a worker for the provider's Retry-After", async () => {
    const h = gateHarness();
    h.gate.close(2_500);
    await h.gate.wait();
    expect(h.sleeps).toEqual([2_500]);
    expect(h.pauses).toEqual([2_500]);
  });

  it("backs off by the default when the provider sends no Retry-After", async () => {
    const h = gateHarness();
    h.gate.close(null);
    await h.gate.wait();
    expect(h.sleeps).toEqual([RATE_LIMIT_DEFAULT_BACKOFF_MS]);
  });

  it("caps an implausible Retry-After rather than parking the sole-writer window", async () => {
    const h = gateHarness();
    h.gate.close(3_600_000);
    await h.gate.wait();
    expect(h.sleeps).toEqual([RATE_LIMIT_MAX_BACKOFF_MS]);
  });

  it("holds every worker for one window, not one window each", async () => {
    const h = gateHarness();
    h.gate.close(1_000);
    // Three workers walk into the same limit at the same moment.
    await Promise.all([h.gate.wait(), h.gate.wait(), h.gate.wait()]);
    // Each waits for the same deadline, so the window costs the run 1s in
    // total rather than 1s per worker. (The fake clock advances inside sleep,
    // so the later two find the deadline already passed and sleep for none.)
    expect(h.sleeps).toEqual([1_000]);
    expect(h.pauses).toEqual([1_000]);
  });

  it("extends an open window instead of stacking a second wait behind it", async () => {
    const h = gateHarness();
    h.gate.close(5_000);
    h.gate.close(1_000);
    await h.gate.wait();
    expect(h.sleeps).toEqual([5_000]);
    expect(h.pauses).toEqual([5_000]);
    // The shorter second limit lands inside the first, so it costs no extra
    // pause at all.
    await h.gate.wait();
    expect(h.sleeps).toEqual([5_000]);
  });

  it("honours a window opened while a worker was already waiting on an earlier one", async () => {
    const h = gateHarness();
    h.gate.close(1_000);
    const waiting = h.gate.wait();
    h.gate.close(4_000);
    await waiting;
    expect(h.sleeps.length).toBe(2);
    expect(h.sleeps[0]).toBe(1_000);
  });

  it("reopens once the window has passed", async () => {
    const h = gateHarness();
    h.gate.close(1_000);
    await h.gate.wait();
    h.advance(10_000);
    await h.gate.wait();
    expect(h.sleeps).toEqual([1_000]);
  });

  it("treats a nonsense Retry-After as no Retry-After", async () => {
    const h = gateHarness();
    h.gate.close(Number.NaN);
    await h.gate.wait();
    expect(h.sleeps).toEqual([RATE_LIMIT_DEFAULT_BACKOFF_MS]);
  });
});

describe("createRateLimitGate backoff ceiling", () => {
  it("charges the budget only what each limit actually adds to the stall", () => {
    const h = gateHarness({ maxBackoffMs: 25_000 });
    h.gate.close(10_000);
    // A whole round of workers reporting the same wall inside the open window
    // is one charge, not one per worker.
    for (let worker = 0; worker < 20; worker++) h.gate.close(10_000);
    expect(h.pauses).toEqual([10_000]);
    expect(h.gate.stopped()).toBe(false);

    // Extending a 10s window by 5s costs the budget the 5s, not another 10.
    h.gate.close(15_000);
    expect(h.pauses).toEqual([10_000, 15_000]);
    expect(h.gate.stopped()).toBe(false);
    expect(h.ceilings).toEqual([]);
  });

  it("stops the pass once the next window would overrun the ceiling", async () => {
    const h = gateHarness({ maxBackoffMs: 25_000 });
    for (let round = 0; round < 2; round++) {
      h.gate.close(10_000);
      await h.gate.wait();
    }
    expect(h.pauses).toEqual([10_000, 10_000]);
    expect(h.gate.stopped()).toBe(false);

    h.gate.close(10_000);
    // 20s spent, 10s more asked for, 25s allowed: the pass stops rather than
    // opening a window it cannot afford, and reports what it did spend.
    expect(h.gate.stopped()).toBe(true);
    expect(h.ceilings).toEqual([20_000]);
    expect(h.pauses).toEqual([10_000, 10_000]);

    // And it stays stopped, without pausing again or repeating the notice.
    const sleptBefore = h.sleeps.length;
    h.gate.close(10_000);
    await h.gate.wait();
    expect(h.sleeps).toHaveLength(sleptBefore);
    expect(h.ceilings).toEqual([20_000]);
  });

  it("leaves a window already open standing, so workers parked on it are not woken early", async () => {
    const h = gateHarness({ maxBackoffMs: 12_000 });
    h.gate.close(10_000);
    const parked = h.gate.wait();
    h.gate.close(RATE_LIMIT_MAX_BACKOFF_MS);
    expect(h.gate.stopped()).toBe(true);
    await parked;
    // The 10s it was already paying for, and nothing added on top.
    expect(h.sleeps).toEqual([10_000]);
  });
});

describe("judgeWithRateLimitRetry", () => {
  const limited = (retryAfterMs: number | null) =>
    new RateLimitedError(429, retryAfterMs, "https://api.example/judge");

  it("returns the first answer without touching the gate", async () => {
    const h = gateHarness();
    expect(await judgeWithRateLimitRetry(h.gate, async () => "ok")).toBe("ok");
    expect(h.pauses).toEqual([]);
  });

  it("retries once, after the window its own 429 opened has cleared", async () => {
    const h = gateHarness();
    let attempts = 0;
    const value = await judgeWithRateLimitRetry(h.gate, async () => {
      attempts++;
      if (attempts === 1) throw limited(3_000);
      return "second time";
    });
    expect(value).toBe("second time");
    expect(attempts).toBe(2);
    // The whole pass backed off for the window, and this action waited it out
    // before spending again.
    expect(h.pauses).toEqual([3_000]);
    expect(h.sleeps).toEqual([3_000]);
  });

  it("fails the action on a second 429 rather than retrying again", async () => {
    const h = gateHarness();
    let attempts = 0;
    await expect(
      judgeWithRateLimitRetry(h.gate, async () => {
        attempts++;
        throw limited(3_000);
      }),
    ).rejects.toThrow(RateLimitedError);
    expect(attempts).toBe(2);
    // The retry's own 429 still tells the rest of the pass the wall is there.
    expect(h.pauses).toEqual([3_000, 3_000]);
  });

  it("does not retry a failure that is not a rate limit", async () => {
    const h = gateHarness();
    let attempts = 0;
    await expect(
      judgeWithRateLimitRetry(h.gate, async () => {
        attempts++;
        throw new Error("provider returned nonsense");
      }),
    ).rejects.toThrow(/nonsense/);
    expect(attempts).toBe(1);
    expect(h.pauses).toEqual([]);
  });

  it("does not retry into a wall the pass has already given up waiting out", async () => {
    const h = gateHarness({ maxBackoffMs: 1_000 });
    let attempts = 0;
    await expect(
      judgeWithRateLimitRetry(h.gate, async () => {
        attempts++;
        throw limited(30_000);
      }),
    ).rejects.toThrow(RateLimitedError);
    expect(attempts).toBe(1);
    expect(h.gate.stopped()).toBe(true);
    expect(h.sleeps).toEqual([]);
  });
});
