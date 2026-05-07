export interface RetryDeps {
  sleep: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  now?: () => number;
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
      if (response.status !== 429 && response.status < 500) return response;

      lastResponse = response;
      if (attempt === deps.maxAttempts - 1) return response;

      const retryAfter =
        response.status === 429
          ? parseRetryAfterMs(response.headers.get("retry-after"), now)
          : null;
      const wait =
        retryAfter !== null
          ? Math.min(retryAfter, deps.maxDelayMs)
          : jitteredBackoff(attempt, deps.baseDelayMs, deps.maxDelayMs, random);

      response.body?.cancel().catch(() => {});
      await deps.sleep(wait);
    } catch (e) {
      lastError = e;
      if (attempt === deps.maxAttempts - 1) throw e;
      const wait = jitteredBackoff(attempt, deps.baseDelayMs, deps.maxDelayMs, random);
      await deps.sleep(wait);
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError;
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
