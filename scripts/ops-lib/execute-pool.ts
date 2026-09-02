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

/**
 * Consecutive backoff windows — with no judgement succeeding in between —
 * after which the gate stops pausing at all.
 *
 * Per-window capping alone does not bound the total stall: against a provider
 * that is hard-limited, every round of workers would walk into the limit and
 * re-open a window, and a long pass would sit on the sole-writer window for
 * hours where the old sequential pass burned through the failures in seconds
 * and exited 1. Past this many rounds the limit is not transient, so the pass
 * stops paying for waits and fails the rest fast, exactly as it would have
 * without the flag.
 */
export const RATE_LIMIT_CONSECUTIVE_LIMIT = 5;

/**
 * Ceiling on `--concurrency`. The default of 4 was chosen for the shared
 * provider org; a mistyped `--concurrency 400` would fan four hundred paid
 * calls at that same org, which is the thing the default is protecting. Well
 * above any figure the plan contemplates, and low enough to catch a typo.
 */
export const MAX_EXECUTE_CONCURRENCY = 16;

export function parseConcurrencyFlag(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_EXECUTE_CONCURRENCY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`--concurrency ${JSON.stringify(raw)} is not a positive integer`);
  }
  if (value > MAX_EXECUTE_CONCURRENCY) {
    throw new UsageError(
      `--concurrency ${value} is above the ${MAX_EXECUTE_CONCURRENCY} this command allows`,
    );
  }
  return value;
}

export interface RateLimitGate {
  /** Resolves once no rate-limit window is in force. */
  wait(): Promise<void>;
  /** Holds every worker back for `retryAfterMs`, or the default when null. */
  close(retryAfterMs: number | null): void;
  /** Records that a judgement came back, so the limit is not a wall. */
  succeeded(): void;
}

export interface RateLimitGateDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Called once per window opened or extended, with the wait it imposes. */
  onPause: (ms: number) => void;
  /** Called once, when the pass gives up on waiting out the limit. */
  onGiveUp: (consecutive: number) => void;
}

export function createRateLimitGate(deps: RateLimitGateDeps): RateLimitGate {
  let openAt = 0;
  let countedAt = Number.NEGATIVE_INFINITY;
  let consecutive = 0;
  let gaveUp = false;
  return {
    succeeded() {
      countedAt = Number.NEGATIVE_INFINITY;
      // Any judgement getting through means the pass is still making progress
      // between windows, which is what the pauses are for; the breaker is only
      // defending against a wall nothing gets past. Clearing the give-up as
      // well keeps a limit early in a long pass from leaving the rest of it
      // unwilling to wait out a later, genuinely transient one.
      consecutive = 0;
      gaveUp = false;
    },
    close(retryAfterMs) {
      if (gaveUp) return;
      const now = deps.now();
      // A limit reported while the previous window is still open is the rest
      // of that same round of workers, not a new one: one window, one count.
      // The elapsed floor is the same idea for a short Retry-After: workers
      // report independently and seconds apart, so a one-second window would
      // otherwise let each 429 of one round open and count its own.
      if (now >= openAt && now - countedAt >= RATE_LIMIT_DEFAULT_BACKOFF_MS) {
        countedAt = now;
        consecutive++;
        if (consecutive > RATE_LIMIT_CONSECUTIVE_LIMIT) {
          gaveUp = true;
          openAt = 0;
          deps.onGiveUp(consecutive);
          return;
        }
      }
      // A non-positive Retry-After is no Retry-After: a header naming a reset
      // already in the past would otherwise open a zero-length window, which
      // paces nothing and makes every 429 in a burst look like its own round.
      const requested =
        retryAfterMs === null || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0
          ? RATE_LIMIT_DEFAULT_BACKOFF_MS
          : retryAfterMs;
      const until = now + Math.min(requested, RATE_LIMIT_MAX_BACKOFF_MS);
      // A second 429 inside an open window extends it rather than stacking a
      // second wait on top of the first.
      if (until <= openAt) return;
      openAt = until;
      deps.onPause(until - now);
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
