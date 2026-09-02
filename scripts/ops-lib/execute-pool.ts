// The `--concurrency` and `--max-backoff` policy the tier-2 and tier-3 execute
// passes share.
//
// Both passes spend almost all of their wall time inside one provider call per
// action, issued one at a time, so a full tier is ~25 minutes of a sole-writer
// window in which the process is idle on the network. Running a few actions at
// once divides that, and the two things that must survive it are the plan
// ordering of the output and the accounting — which is why the pool emits
// results in plan order (see `runKeyedPool`) and the counters are folded in
// that same order rather than as each call lands.
//
// The other thing that must survive it is the provider's rate limit. The
// judge's own retry deliberately does not cover a 429 — it retries 5xx and
// network faults, and turns the first 429 into a typed RateLimitedError rather
// than sleeping inside the call — so pacing a rate limit is this pool's job and
// nobody else's. Under concurrency the wrong reaction is for each worker to
// independently walk into the same wall. `createRateLimitGate` is the one place
// that knows a limit is in force: a worker that sees a 429 closes it, and every
// worker checks it before its next provider call, so the whole pass backs off
// together and then resumes.
//
// The action that hit the limit gets exactly one more attempt, after the window
// it opened has cleared (`judgeWithRateLimitRetry`). A second 429 on the same
// action is not a transient blip, so it is counted as a failure exactly as it is
// today rather than retried again.
//
// The gate also holds the pass's whole backoff budget. Per-window capping alone
// does not bound the total stall: against a provider that is hard-limited, every
// round of workers would walk into the limit and re-open a window, and a long
// pass would sit on the scarce sole-writer window for hours. Once the cumulative
// pause this pass has committed to reaches `--max-backoff`, the gate reports
// itself `stopped()`: the commands dispatch no further judgements, let the ones
// in flight finish and write, report the rest as skipped, and exit non-zero.
// What it bounds is the paid work only, on the same rule `--limit` follows — a
// list heal or an integrity repair makes no provider call and cannot be rate
// limited, so it still runs behind the ceiling.

import { RateLimitedError } from "../../src/modules/http-retry";
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

/** Cumulative backoff one pass will pay before it stops dispatching judgements. */
export const DEFAULT_MAX_BACKOFF_MS = 600_000;

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

const DURATION_UNITS_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * `--max-backoff 10m`, `600s`, `600000ms`, or a bare `600` for seconds.
 *
 * Seconds is the bare unit because the value being named is a wait an operator
 * sits through, and the flag's own default is stated in minutes.
 */
export function parseMaxBackoffFlag(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_BACKOFF_MS;
  const match = /^(\d+)(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) {
    throw new UsageError(
      `--max-backoff ${JSON.stringify(raw)} is not a duration (e.g. 10m, 600s, 600000ms)`,
    );
  }
  const ms = Number(match[1]) * DURATION_UNITS_MS[match[2] ?? "s"]!;
  // Enough digits, or a finite magnitude times a unit, can overflow Number to
  // Infinity. That still passes `ms <= 0`, and then every later
  // `spentMs + added > maxBackoffMs` is false, so the ceiling is silently off.
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new UsageError(
      `--max-backoff ${JSON.stringify(raw)} must be a finite positive duration`,
    );
  }
  return ms;
}

export interface RateLimitGate {
  /** Resolves once no rate-limit window is in force. */
  wait(): Promise<void>;
  /** Holds every worker back for `retryAfterMs`, or the default when null. */
  close(retryAfterMs: number | null): void;
  /**
   * True once the pass has committed its whole backoff budget. Callers stop
   * dispatching paid judgements and report the rest of them as skipped.
   */
  stopped(): boolean;
}

export interface RateLimitGateDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Cumulative pause this pass will commit to before it stops judging. */
  maxBackoffMs: number;
  /** Called once per window opened or extended, with the wait it imposes. */
  onPause: (ms: number) => void;
  /** Called once, when the budget is spent, with the total it committed. */
  onCeiling: (totalMs: number) => void;
}

export function createRateLimitGate(deps: RateLimitGateDeps): RateLimitGate {
  let openAt = 0;
  let spentMs = 0;
  let ceilingReached = false;
  return {
    stopped() {
      return ceilingReached;
    },
    close(retryAfterMs) {
      if (ceilingReached) return;
      const now = deps.now();
      // A non-positive Retry-After is no Retry-After: a header naming a reset
      // already in the past would otherwise open a zero-length window, which
      // paces nothing.
      const requested =
        retryAfterMs === null || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0
          ? RATE_LIMIT_DEFAULT_BACKOFF_MS
          : retryAfterMs;
      const until = now + Math.min(requested, RATE_LIMIT_MAX_BACKOFF_MS);
      // Only the stall this limit adds counts against the budget. A second 429
      // inside an open window extends it rather than stacking a second wait on
      // top of the first, and a limit that lands entirely inside one costs the
      // pass nothing at all — which is what makes a whole round of workers
      // reporting the same wall a single charge against the budget.
      const from = Math.max(now, openAt);
      const added = until - from;
      if (added <= 0) return;
      if (spentMs + added > deps.maxBackoffMs) {
        // The budget cannot cover this window, so the pass stops rather than
        // opening it. Any window already open stands: it was paid for out of
        // the budget already, and the workers parked on it wake to find the
        // gate stopped and skip instead of calling the provider.
        ceilingReached = true;
        deps.onCeiling(spentMs);
        return;
      }
      spentMs += added;
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

/**
 * One judgement, with one retry after a 429's window clears.
 *
 * The caller has already waited out any open window and re-read the manifests
 * it is about to write, so the ETags this retry writes against are still the
 * ones it validated: `--sole-writer` means nothing else moved them.
 *
 * A 429 on the retry is reported to the gate — the rest of the pass still wants
 * to know the wall is there — and then thrown, so the action is counted as a
 * failure exactly as an un-retried one is.
 */
export async function judgeWithRateLimitRetry<T>(
  gate: RateLimitGate,
  judge: () => Promise<T>,
): Promise<T> {
  try {
    return await judge();
  } catch (error) {
    if (!(error instanceof RateLimitedError)) throw error;
    gate.close(error.retryAfterMs);
    // Nothing is gained by retrying into a wall the pass has already given up
    // waiting out; the first 429 stands as this action's failure.
    if (gate.stopped()) throw error;
    await gate.wait();
    if (gate.stopped()) throw error;
    try {
      return await judge();
    } catch (retryError) {
      if (retryError instanceof RateLimitedError) gate.close(retryError.retryAfterMs);
      throw retryError;
    }
  }
}

export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
