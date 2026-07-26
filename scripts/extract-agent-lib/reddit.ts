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
const MANUAL_DETAIL =
  "anonymous Reddit access was challenged; use the reddit-import skill";

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
  return url.href;
}

type ResponseAction = "consume" | "manual" | "dead" | "error";

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
  const guardedFetch = makeBrowserFetch(safeFetch(deps.fetch, { lookup: deps.lookup }));
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
        return { kind: "manual", detail: MANUAL_DETAIL };
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
      return { kind: "manual", detail: MANUAL_DETAIL };
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > deps.maxBytes) {
      await cancelBody(response);
      throw new OversizedResponseError(jsonUrl, deps.maxBytes);
    }

    const text = new TextDecoder().decode(await readBounded(response, deps.maxBytes, jsonUrl));
    if (looksLikeHtml(text)) return { kind: "manual", detail: MANUAL_DETAIL };

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
