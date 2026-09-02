// The `--concurrency` policy the tier-2 and tier-3 execute passes share.
//
// Both passes spend almost all of their wall time inside one provider call per
// action, issued one at a time, so a full tier is ~25 minutes of a sole-writer
// window in which the process is idle on the network. Running a few actions at
// once divides that, and the two things that must survive it are the plan
// ordering of the output and the accounting — which is why the pool emits
// results in plan order (see `runKeyedPool`) and the counters are folded in
// that same order rather than as each call lands.
//
// The other thing that must survive it is the provider's rate limit. A 429
// that outlives the judge's own retry surfaces as a typed RateLimitedError,
// and under concurrency the wrong reaction is for each worker to independently
// walk into the same wall. `createRateLimitGate` is the one place that knows a
// limit is in force: a worker that sees a 429 closes it, and every worker
// checks it before its next provider call, so the whole pass backs off
// together and then resumes. The action that hit the limit is counted as a
// failure exactly as it is today; the pass does not abort and does not silently
// re-bill a judgement.

import { UsageError } from "./contract";

/**
 * Provider calls in flight per execute pass. Four is the captain's decision
 * for the shared OpenAI org, against the ingest queue's own concurrency of 3.
 */
export const DEFAULT_EXECUTE_CONCURRENCY = 4;

/** Backoff when a 429 arrives without a usable Retry-After. */
export const RATE_LIMIT_DEFAULT_BACKOFF_MS = 8_000;

/**
 * Ceiling on an honoured Retry-After. A sole-writer window is a scarce, held
 * resource, so an implausible header parks the pass for a minute at most
 * rather than for the hour it asked for.
 */
export const RATE_LIMIT_MAX_BACKOFF_MS = 60_000;

export function parseConcurrencyFlag(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_EXECUTE_CONCURRENCY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`--concurrency ${JSON.stringify(raw)} is not a positive integer`);
  }
  return value;
}

export interface RateLimitGate {
  /** Resolves once no rate-limit window is in force. */
  wait(): Promise<void>;
  /** Holds every worker back for `retryAfterMs`, or the default when null. */
  close(retryAfterMs: number | null): void;
}

export interface RateLimitGateDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Called once per window opened or extended, with the wait it imposes. */
  onPause: (ms: number) => void;
}

export function createRateLimitGate(deps: RateLimitGateDeps): RateLimitGate {
  let openAt = 0;
  return {
    close(retryAfterMs) {
      const requested =
        retryAfterMs === null || !Number.isFinite(retryAfterMs) || retryAfterMs < 0
          ? RATE_LIMIT_DEFAULT_BACKOFF_MS
          : retryAfterMs;
      const until = deps.now() + Math.min(requested, RATE_LIMIT_MAX_BACKOFF_MS);
      // A second 429 inside an open window extends it rather than stacking a
      // second wait on top of the first.
      if (until <= openAt) return;
      openAt = until;
      deps.onPause(Math.max(0, until - deps.now()));
    },
    async wait() {
      // Serve each deadline once, so a window another worker extended while
      // this one was already waiting is honoured too. Looping on the clock
      // instead would spin whenever `sleep` and `now` disagree — which is
      // exactly what a fake clock in a test does.
      let served = 0;
      for (;;) {
        const deadline = openAt;
        const remaining = deadline - deps.now();
        if (remaining <= 0 || deadline <= served) return;
        await deps.sleep(remaining);
        served = deadline;
      }
    },
  };
}

export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
