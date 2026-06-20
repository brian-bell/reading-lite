import { z } from "zod";
import { fetchWithRetry, parseRetryAfterMs, RateLimitedError, type RetryDeps } from "../http-retry";
import { BadStatusError, FetchTimeoutError, OversizedResponseError } from "./errors";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
export const DEFAULT_REDDIT_UA = "web:reading-lite:1.0 (contact: reading-lite)";
const DEFAULT_TOKEN_TIMEOUT_MS = 20_000;
const DEFAULT_TOKEN_MAX_BYTES = 1_000_000;

export interface RedditAuthDeps {
  fetch: typeof fetch;
  clientId: string;
  clientSecret: string;
  retry?: RetryDeps;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
}

export function redditUserAgent(value?: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_REDDIT_UA;
}

export async function fetchRedditToken(deps: RedditAuthDeps): Promise<string> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_TOKEN_MAX_BYTES;
  const userAgent = redditUserAgent(deps.userAgent);
  const basic = btoa(`${deps.clientId}:${deps.clientSecret}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": userAgent,
    },
    body: "grant_type=client_credentials",
    signal: controller.signal,
  };
  let res: Response;
  try {
    res = deps.retry
      ? await fetchWithRetry(deps.fetch, TOKEN_URL, init, deps.retry)
      : await deps.fetch(TOKEN_URL, init);

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), Date.now);
      res.body?.cancel().catch(() => {});
      throw new RateLimitedError(429, retryAfterMs, TOKEN_URL);
    }
    if (!res.ok) throw new BadStatusError(TOKEN_URL, res.status);

    const raw = await readBoundedBody(res, maxBytes, TOKEN_URL);
    const json = z.object({ access_token: z.string() }).parse(JSON.parse(new TextDecoder("utf-8").decode(raw)));
    return json.access_token;
  } catch (e) {
    if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
      throw new FetchTimeoutError(TOKEN_URL, timeoutMs);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(response: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new OversizedResponseError(url, maxBytes);
    }
  }

  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new OversizedResponseError(url, maxBytes);
    return buf;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new OversizedResponseError(url, maxBytes);
      }
      chunks.push(value);
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
