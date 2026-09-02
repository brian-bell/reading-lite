// Retry policy for the refresh judgement calls (tiers 2 and 3).
//
// Both judges accept `deps.retry` and neither command used to pass it, so a
// single 500 from the provider ended that action: one reading skipped, one
// non-zero exit, and — on a long run — a sole-writer window spent on a rerun.
// fetchWithRetry retries 5xx and network faults with jittered backoff, and
// converts a 429 into a typed RateLimitedError instead of an opaque "429
// provider error", which is what tells an operator to slow the run down rather
// than re-run it immediately.
//
// The numbers mirror the Worker's defaults (RETRY_MAX_ATTEMPTS and friends in
// process-reading.ts), because it is the same provider under the same account.

import type { RetryDeps } from "../../src/modules/http-retry";

export const JUDGE_RETRY_ATTEMPTS = 3;
export const JUDGE_RETRY_BASE_DELAY_MS = 500;
export const JUDGE_RETRY_MAX_DELAY_MS = 8_000;

export function judgeRetryDeps(
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): RetryDeps {
  return {
    sleep,
    maxAttempts: JUDGE_RETRY_ATTEMPTS,
    baseDelayMs: JUDGE_RETRY_BASE_DELAY_MS,
    maxDelayMs: JUDGE_RETRY_MAX_DELAY_MS,
  };
}
