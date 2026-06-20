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
        const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"), now);
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
      // AbortError signals caller-driven cancellation (e.g. an AbortSignal
      // tripping). Retrying would mask the cancellation intent, so surface it.
      if (isAbortError(e)) throw e;
      lastError = e;
      if (attempt === deps.maxAttempts - 1) throw e;
      const wait = jitteredBackoff(attempt, deps.baseDelayMs, deps.maxDelayMs, random);
      await sleepWithAbort(wait, deps.sleep, init.signal);
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError;
}

function urlToString(input: URL | string): string {
  return input instanceof URL ? input.toString() : input;
}

function isAbortError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as { name: unknown }).name === "AbortError"
  );
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
