// Anonymous Reddit route boundary. This module only turns a recognized public
// thread URL into a bounded, SSRF-guarded JSON fetch and a route-specific
// outcome; orchestration, gating, and submission remain in run.ts.

import {
  BadStatusError,
  BlockedHostError,
  FetchTimeoutError,
  OversizedResponseError,
} from "../../src/modules/extractor";
import { isRedditThreadUrl } from "../../src/modules/extractor/reddit";
import { makeBrowserFetch } from "../corpus-lib/browser-fetch";
import { buildRedditImport } from "../reddit-import-lib/parse";
import { safeFetch, type LookupFn } from "./safe-fetch";
import type { SubmitBody } from "./submit";

export type RedditOutcome =
  | { kind: "extracted"; body: SubmitBody }
  | { kind: "manual"; detail: string }
  | { kind: "dead"; detail: string }
  | { kind: "error"; code: string; detail: string };

export interface RedditDeps {
  fetch: typeof fetch;
  lookup: LookupFn;
  maxBytes: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
// One message per challenge condition, all ending in the skill pointer: a 403
// edge wall and a transient-looking 429 read very differently in a run report,
// and an operator scanning the manual queue deserves to know which fired.
const MANUAL_DETAIL = {
  status: (status: number) =>
    `anonymous Reddit access was challenged (HTTP ${status}); use the reddit-import skill`,
  html: "anonymous Reddit access was challenged (served HTML); use the reddit-import skill",
} as const;

export function redditJsonUrl(sourceUrl: string): string {
  if (!isRedditThreadUrl(sourceUrl)) {
    throw new BlockedHostError(sourceUrl, "not a recognized public Reddit thread URL");
  }
  const url = new URL(sourceUrl);
  if (url.username || url.password) {
    const safeUrl = new URL(url);
    safeUrl.username = "";
    safeUrl.password = "";
    throw new BlockedHostError(safeUrl.href, "URL credentials are not allowed");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.toLowerCase().endsWith(".json")) url.pathname += ".json";
  // The query is the exact one the reddit-import skill fetches. `raw_json=1`
  // is load-bearing: without it Reddit HTML-escapes entities in
  // title/selftext/body, and the shared parser does no unescaping, so markdown
  // would land in the corpus as `&gt;`/`&amp;` literals. `limit=20&sort=top`
  // bounds the listing and keeps the recovered markdown aligned with a skill
  // import of the same thread.
  url.searchParams.set("raw_json", "1");
  url.searchParams.set("limit", "20");
  url.searchParams.set("sort", "top");
  return url.href;
}

type ResponseAction = "consume" | "manual" | "dead" | "error";

// 429 joins 401/403 as a terminal manual outcome on purpose: Reddit's
// anonymous edge serves rate-limit and bot-wall responses interchangeably, and
// the phase spec names the logged-in skill as the one fallback for all of them.
// A retryable 429 would burn the attempt ceiling over hours and then strand the
// row as generic backoff — outside the manual queue an operator actually reads.
const RESPONSE_POLICY: ReadonlyArray<{
  matches: (status: number) => boolean;
  action: ResponseAction;
}> = [
  { matches: (status) => status >= 200 && status < 300, action: "consume" },
  { matches: (status) => status === 401 || status === 403 || status === 429, action: "manual" },
  { matches: (status) => status === 404 || status === 410, action: "dead" },
  { matches: () => true, action: "error" },
];

export async function extractReddit(sourceUrl: string, deps: RedditDeps): Promise<RedditOutcome> {
  let jsonUrl: string;
  try {
    jsonUrl = redditJsonUrl(sourceUrl);
  } catch (error) {
    return errorOutcome(error);
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const guardedFetch = makeBrowserFetch(
    safeFetch(deps.fetch, { lookup: deps.lookup, rewriteRedirect: redditRedirectTarget }),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await guardedFetch(jsonUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const action = RESPONSE_POLICY.find(({ matches }) => matches(response.status))!.action;

    switch (action) {
      case "manual":
        await cancelBody(response);
        return { kind: "manual", detail: MANUAL_DETAIL.status(response.status) };
      case "dead":
        await cancelBody(response);
        return { kind: "dead", detail: `Reddit thread returned HTTP ${response.status}` };
      case "error":
        await cancelBody(response);
        throw new BadStatusError(jsonUrl, response.status);
      case "consume":
        break;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (isHtmlContentType(contentType)) {
      await cancelBody(response);
      return { kind: "manual", detail: MANUAL_DETAIL.html };
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > deps.maxBytes) {
      await cancelBody(response);
      throw new OversizedResponseError(jsonUrl, deps.maxBytes);
    }

    const text = new TextDecoder().decode(await readBounded(response, deps.maxBytes, jsonUrl));
    if (looksLikeHtml(text)) return { kind: "manual", detail: MANUAL_DETAIL.html };

    const body = buildRedditImport(sourceUrl, text);
    if (!body) {
      return {
        kind: "error",
        code: "InvalidRedditListingError",
        detail: "Reddit response was not a valid thread listing",
      };
    }
    return { kind: "extracted", body };
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) {
      return errorOutcome(new FetchTimeoutError(jsonUrl, timeoutMs));
    }
    return errorOutcome(error);
  } finally {
    clearTimeout(timer);
  }
}

function isHtmlContentType(contentType: string): boolean {
  return /(?:^|;|\s)(?:text\/html|application\/xhtml\+xml)(?:;|\s|$)/i.test(contentType);
}

// Reddit's redirectors (redd.it, /s/ share links) resolve to the canonical
// thread page URL — the Location carries neither the .json suffix nor the
// raw_json query. Re-apply the thread-JSON shape to any redirect target that
// is itself a recognized thread URL; anything else (a login wall, an off-site
// hop) follows untouched under the same per-hop guards and lands on the normal
// response policy.
function redditRedirectTarget(target: string): string {
  try {
    return redditJsonUrl(target);
  } catch {
    return target;
  }
}

function looksLikeHtml(text: string): boolean {
  return /^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(text.trimStart());
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is cleanup only; the response classification still wins.
  }
}

async function readBounded(response: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  if (!response.body) {
    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.byteLength > maxBytes) throw new OversizedResponseError(url, maxBytes);
    return raw;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the meaningful size error.
      }
      throw new OversizedResponseError(url, maxBytes);
    }
    chunks.push(value);
  }

  const raw = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function errorOutcome(error: unknown): Extract<RedditOutcome, { kind: "error" }> {
  if (error instanceof Error) {
    return {
      kind: "error",
      code: error.name || "Error",
      detail: redactCredentials(error.message),
    };
  }
  return { kind: "error", code: "UnknownError", detail: "unknown Reddit extraction error" };
}

function redactCredentials(detail: string): string {
  return detail.replace(/\b(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@");
}
