import { z } from "zod";
import { fetchWithRetry, parseRetryAfterMs, RateLimitedError, type RetryDeps } from "../http-retry";
import { BadStatusError } from "./index";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
export const REDDIT_UA = "web:reading-lite:1.0 (by /u/<owner>)";

export interface RedditAuthDeps {
  fetch: typeof fetch;
  clientId: string;
  clientSecret: string;
  retry?: RetryDeps;
}

export async function fetchRedditToken(deps: RedditAuthDeps): Promise<string> {
  const basic = btoa(`${deps.clientId}:${deps.clientSecret}`);
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": REDDIT_UA,
    },
    body: "grant_type=client_credentials",
  };
  const res = deps.retry
    ? await fetchWithRetry(deps.fetch, TOKEN_URL, init, deps.retry)
    : await deps.fetch(TOKEN_URL, init);
  if (res.status === 429) {
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), Date.now);
    res.body?.cancel().catch(() => {});
    throw new RateLimitedError(429, retryAfterMs, TOKEN_URL);
  }
  if (!res.ok) throw new BadStatusError(TOKEN_URL, res.status);
  const json = z.object({ access_token: z.string() }).parse(await res.json());
  return json.access_token;
}
