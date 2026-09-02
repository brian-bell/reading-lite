import { describe, expect, it } from "vitest";
import { UsageError } from "../../../scripts/ops-lib/contract";
import {
  DEFAULT_EXECUTE_CONCURRENCY,
  MAX_EXECUTE_CONCURRENCY,
  RATE_LIMIT_CONSECUTIVE_LIMIT,
  RATE_LIMIT_DEFAULT_BACKOFF_MS,
  RATE_LIMIT_MAX_BACKOFF_MS,
  createRateLimitGate,
  parseConcurrencyFlag,
} from "../../../scripts/ops-lib/execute-pool";

function gateHarness(startMs = 1_000) {
  let now = startMs;
  const sleeps: number[] = [];
  const pauses: number[] = [];
  const giveUps: number[] = [];
  const gate = createRateLimitGate({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    onPause: (ms) => pauses.push(ms),
    onGiveUp: (consecutive) => giveUps.push(consecutive),
  });
  return { gate, sleeps, pauses, giveUps, advance: (ms: number) => (now += ms) };
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

describe("createRateLimitGate", () => {
  it("lets every worker through until a limit is reported", async () => {
    const h = gateHarness();
    await h.gate.wait();
    await h.gate.wait();
    expect(h.sleeps).toEqual([]);
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

  it("stops pausing once the limit is plainly sustained", async () => {
    const h = gateHarness();
    for (let attempt = 0; attempt < RATE_LIMIT_CONSECUTIVE_LIMIT; attempt++) {
      h.gate.close(1_000);
      await h.gate.wait();
    }
    expect(h.pauses).toHaveLength(RATE_LIMIT_CONSECUTIVE_LIMIT);
    expect(h.giveUps).toEqual([]);

    h.gate.close(1_000);

    // One round past the limit the pass stops paying for waits and fails the
    // rest fast, rather than holding the sole-writer window indefinitely.
    expect(h.giveUps).toEqual([RATE_LIMIT_CONSECUTIVE_LIMIT + 1]);
    const before = h.sleeps.length;
    await h.gate.wait();
    expect(h.sleeps).toHaveLength(before);
    // And it stays given up, without repeating the notice.
    h.gate.close(1_000);
    await h.gate.wait();
    expect(h.giveUps).toEqual([RATE_LIMIT_CONSECUTIVE_LIMIT + 1]);
    expect(h.pauses).toHaveLength(RATE_LIMIT_CONSECUTIVE_LIMIT);
  });

  it("a judgement that comes back lets the pass back off again later", async () => {
    const h = gateHarness();
    for (let attempt = 0; attempt <= RATE_LIMIT_CONSECUTIVE_LIMIT; attempt++) {
      h.gate.close(1_000);
      await h.gate.wait();
    }
    expect(h.giveUps).toHaveLength(1);

    // The provider lifts the limit and the pass gets a judgement through: a
    // later, genuinely transient limit must be waited out, not ignored.
    h.gate.succeeded();
    const before = h.pauses.length;
    h.gate.close(1_000);
    await h.gate.wait();
    expect(h.pauses).toHaveLength(before + 1);
  });

  it("a judgement that comes back resets the run toward the limit", async () => {
    const h = gateHarness();
    for (let round = 0; round < 4; round++) {
      for (let attempt = 0; attempt < RATE_LIMIT_CONSECUTIVE_LIMIT; attempt++) {
        h.gate.close(1_000);
        await h.gate.wait();
      }
      h.gate.succeeded();
    }
    // Twenty rate limits, none of them consecutive past the run: still pausing.
    expect(h.giveUps).toEqual([]);
    expect(h.pauses).toHaveLength(4 * RATE_LIMIT_CONSECUTIVE_LIMIT);
  });
});

describe("createRateLimitGate window counting", () => {
  it("counts one window however many workers report the same limit", async () => {
    let now = 1_000;
    const pauses: number[] = [];
    const giveUps: number[] = [];
    const gate = createRateLimitGate({
      now: () => now,
      sleep: async () => {},
      onPause: (ms) => pauses.push(ms),
      onGiveUp: (consecutive) => giveUps.push(consecutive),
    });
    // Far more concurrent 429s than the give-up limit, all inside one window.
    for (let worker = 0; worker < RATE_LIMIT_CONSECUTIVE_LIMIT * 4; worker++) {
      gate.close(1_000);
    }
    expect(pauses).toEqual([1_000]);
    expect(giveUps).toEqual([]);
    // Only once the window has elapsed does the next limit start a new round.
    now += 1_000;
    gate.close(1_000);
    expect(pauses).toEqual([1_000, 1_000]);
  });
});
