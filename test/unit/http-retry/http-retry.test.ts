import { describe, expect, it, vi } from "vitest";
import {
  fetchWithRetry,
  parseRetryAfterMs,
  RateLimitedError,
} from "../../../src/modules/http-retry";

function res(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

const baseDeps = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
};

function recordingSleep() {
  const sleeps: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    sleeps.push(ms);
  });
  return { sleep, sleeps };
}

describe("fetchWithRetry", () => {
  it("returns immediately on 2xx without sleeping", async () => {
    const fetchFn = vi.fn(async () => res(200, "ok"));
    const { sleep } = recordingSleep();
    const out = await fetchWithRetry(fetchFn as unknown as typeof fetch, "https://x", { method: "GET" }, {
      ...baseDeps,
      sleep,
      random: () => 1,
    });
    expect(out.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns non-429 4xx without retrying", async () => {
    const fetchFn = vi.fn(async () => res(401, "no"));
    const { sleep } = recordingSleep();
    const out = await fetchWithRetry(fetchFn as unknown as typeof fetch, "https://x", {}, {
      ...baseDeps,
      sleep,
      random: () => 1,
    });
    expect(out.status).toBe(401);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws RateLimitedError immediately on 429 with Retry-After", async () => {
    const fetchFn = vi.fn(async () => res(429, "slow", { "retry-after": "30" }));
    const { sleep } = recordingSleep();
    const err = await fetchWithRetry(
      fetchFn as unknown as typeof fetch,
      "https://x",
      {},
      { ...baseDeps, sleep, random: () => 1 },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).status).toBe(429);
    expect((err as RateLimitedError).retryAfterMs).toBe(30_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws RateLimitedError with retryAfterMs=null when header is missing", async () => {
    const fetchFn = vi.fn(async () => res(429, "no header"));
    const { sleep } = recordingSleep();
    const err = await fetchWithRetry(
      fetchFn as unknown as typeof fetch,
      "https://x",
      {},
      { ...baseDeps, sleep, random: () => 1 },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBeNull();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not clamp Retry-After when surfacing it via RateLimitedError", async () => {
    const fetchFn = vi.fn(async () => res(429, "slow", { "retry-after": "600" }));
    const { sleep } = recordingSleep();
    const err = await fetchWithRetry(
      fetchFn as unknown as typeof fetch,
      "https://x",
      {},
      { ...baseDeps, maxDelayMs: 8_000, sleep, random: () => 1 },
    ).catch((e) => e);
    expect((err as RateLimitedError).retryAfterMs).toBe(600_000);
  });

  it("retries on 500 then 503 then 200", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(500))
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200, "ok"));
    const { sleep, sleeps } = recordingSleep();
    const out = await fetchWithRetry(fetchFn as unknown as typeof fetch, "https://x", {}, {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 1_000,
      sleep,
      random: () => 1,
    });
    expect(out.status).toBe(200);
    expect(sleeps).toEqual([50, 100]);
  });

  it("returns the last 5xx response after maxAttempts", async () => {
    const fetchFn = vi.fn(async () => res(503, "still down"));
    const { sleep, sleeps } = recordingSleep();
    const out = await fetchWithRetry(fetchFn as unknown as typeof fetch, "https://x", {}, {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 1_000,
      sleep,
      random: () => 1,
    });
    expect(out.status).toBe(503);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([50, 100]);
  });

  it("retries on transport (network) errors", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network unreachable"))
      .mockResolvedValueOnce(res(200, "ok"));
    const { sleep, sleeps } = recordingSleep();
    const out = await fetchWithRetry(fetchFn as unknown as typeof fetch, "https://x", {}, {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 1_000,
      sleep,
      random: () => 1,
    });
    expect(out.status).toBe(200);
    expect(sleeps).toEqual([50]);
  });

  it("rethrows the last network error after maxAttempts", async () => {
    const err = new TypeError("dns");
    const fetchFn = vi.fn(async () => {
      throw err;
    });
    const { sleep } = recordingSleep();
    await expect(
      fetchWithRetry(fetchFn as unknown as typeof fetch, "https://x", {}, {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 1_000,
        sleep,
        random: () => 1,
      }),
    ).rejects.toBe(err);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("does not retry AbortError (caller-driven cancellation)", async () => {
    const abortErr = new DOMException("aborted", "AbortError");
    const fetchFn = vi.fn(async () => {
      throw abortErr;
    });
    const { sleep, sleeps } = recordingSleep();
    await expect(
      fetchWithRetry(fetchFn as unknown as typeof fetch, "https://x", {}, {
        maxAttempts: 3,
        baseDelayMs: 50,
        maxDelayMs: 1_000,
        sleep,
        random: () => 1,
      }),
    ).rejects.toBe(abortErr);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("does not retry errors whose name is AbortError on a generic Error", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const fetchFn = vi.fn(async () => {
      throw abortErr;
    });
    const { sleep } = recordingSleep();
    await expect(
      fetchWithRetry(fetchFn as unknown as typeof fetch, "https://x", {}, {
        maxAttempts: 3,
        baseDelayMs: 50,
        maxDelayMs: 1_000,
        sleep,
        random: () => 1,
      }),
    ).rejects.toBe(abortErr);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("applies jitter as random * computed (random=0 → no sleep)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200, "ok"));
    const { sleep, sleeps } = recordingSleep();
    await fetchWithRetry(fetchFn as unknown as typeof fetch, "https://x", {}, {
      maxAttempts: 3,
      baseDelayMs: 200,
      maxDelayMs: 1_000,
      sleep,
      random: () => 0,
    });
    expect(sleeps).toEqual([0]);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfterMs("2", () => 0)).toBe(2_000);
    expect(parseRetryAfterMs("0", () => 0)).toBe(0);
  });

  it("parses HTTP-date relative to now()", () => {
    const now = Date.parse("2026-05-06T12:00:00Z");
    const future = "Wed, 06 May 2026 12:00:30 GMT";
    expect(parseRetryAfterMs(future, () => now)).toBe(30_000);
  });

  it("returns null for malformed values", () => {
    expect(parseRetryAfterMs("not a number", () => 0)).toBeNull();
    expect(parseRetryAfterMs("", () => 0)).toBeNull();
    expect(parseRetryAfterMs(null, () => 0)).toBeNull();
  });

  it("clamps negative values to 0", () => {
    const now = Date.parse("2026-05-06T12:00:30Z");
    const past = "Wed, 06 May 2026 12:00:00 GMT";
    expect(parseRetryAfterMs(past, () => now)).toBe(0);
  });
});
