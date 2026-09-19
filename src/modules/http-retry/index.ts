export interface RetryDeps {
  sleep: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  now?: () => number;
}

export class RateLimitedError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs: number | null,
    public readonly url: string,
  ) {
    super(`rate limited by ${url} (status ${status}, retry after ${retryAfterMs ?? "unknown"}ms)`);
    this.name = "RateLimitedError";
  }
}

export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  input: URL | string,
  init: RequestInit,
  deps: RetryDeps,
): Promise<Response> {
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  let lastError: unknown;
  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt < deps.maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(input, init);
      if (response.status < 400) return response;

      // 429s do not retry in-process — sleeping inside a queue consumer would
      // hold a concurrency slot for the entire Retry-After window. Surface a
      // typed error so the queue handler can msg.retry({ delaySeconds }) and
      // free the slot for other work while we wait.
      if (response.status === 429) {
        const retryAfter = parseRateLimitDelayMs(response.headers, now);
        response.body?.cancel().catch(() => {});
        throw new RateLimitedError(429, retryAfter, urlToString(input));
      }

      if (response.status < 500) return response;

      lastResponse = response;
      if (attempt === deps.maxAttempts - 1) return response;

      response.body?.cancel().catch(() => {});
      const wait = jitteredBackoff(attempt, deps.baseDelayMs, deps.maxDelayMs, random);
      await sleepWithAbort(wait, deps.sleep, init.signal);
    } catch (e) {
      if (e instanceof RateLimitedError) throw e;
      // Admission/lease failures are not provider transport failures. The queue
      // defers (or fails) the existing attempt; retrying here would reserve repeatedly.
      if (
        ["SpendAdmissionError", "DeferPaidWorkError", "StaleProcessingLeaseError", "ReadingReservationExpiredError"].includes(
          errorName(e) ?? "",
        )
      ) throw e;
      // AbortError signals caller-driven cancellation (e.g. an AbortSignal
      // tripping). Retrying would mask the cancellation intent, so surface it.
      if (isAbortError(e)) throw e;
      // A rejected destination is a verdict about attacker-controlled egress:
      // the guard already decided this URL (or its redirect chain) must not be
      // reached, so retrying would only re-hit the attacker's first hop.
      //
      // DestinationResolutionError is deliberately NOT in that set. workerd's
      // DoH collapses SERVFAIL, NXDOMAIN and no-records onto one code (see
      // lookupFromResolvers), so an unresolvable destination may be a blip, and
      // refusing to retry it turns one into a terminal `failed` manifest. The
      // cost is that when the failure lands on a redirect hop the whole chain
      // replays from the original URL — bounded by maxAttempts and by the
      // caller's extraction timeout, and paid only on chains that were already
      // failing.
      if (isRejectedDestinationError(e)) throw e;
      lastError = e;
      if (attempt === deps.maxAttempts - 1) throw e;
      const wait = jitteredBackoff(attempt, deps.baseDelayMs, deps.maxDelayMs, random);
      await sleepWithAbort(wait, deps.sleep, init.signal);
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError;
}

export function parseRateLimitDelayMs(headers: Headers, now: () => number): number | null {
  const retryAfter = parseRetryAfterMs(headers.get("retry-after"), now);
  if (retryAfter !== null) return retryAfter;

  const reset = headers.get("x-rate-limit-reset")?.trim();
  if (!reset || !/^\d+$/.test(reset)) return null;
  const resetMs = Number(reset) * 1_000;
  if (!Number.isSafeInteger(resetMs)) return null;
  return Math.max(0, resetMs - now());
}

function urlToString(input: URL | string): string {
  return input instanceof URL ? input.toString() : input;
}

function isAbortError(e: unknown): boolean {
  return errorName(e) === "AbortError";
}

const REJECTED_DESTINATION_ERROR_NAMES = new Set([
  "BlockedHostError",
  "TooManyRedirectsError",
]);

function isRejectedDestinationError(e: unknown): boolean {
  const name = errorName(e);
  return name !== undefined && REJECTED_DESTINATION_ERROR_NAMES.has(name);
}

function errorName(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || !("name" in e)) return undefined;
  return typeof (e as { name: unknown }).name === "string" ? (e as { name: string }).name : undefined;
}

async function sleepWithAbort(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal | null,
): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) throw abortError();

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function jitteredBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const computed = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * computed);
}

export function parseRetryAfterMs(
  raw: string | null | undefined,
  now: () => number,
): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now());
}

export function retryDepsFromEnv(env: { RETRY_MAX_ATTEMPTS?: string; RETRY_BASE_DELAY_MS?: string; RETRY_MAX_DELAY_MS?: string }): RetryDeps {
  return {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxAttempts: parseRetryInt(env.RETRY_MAX_ATTEMPTS, 3),
    baseDelayMs: parseRetryInt(env.RETRY_BASE_DELAY_MS, 500),
    maxDelayMs: parseRetryInt(env.RETRY_MAX_DELAY_MS, 8_000),
  };
}

function parseRetryInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) ? n : fallback;
}
