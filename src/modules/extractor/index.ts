// HTML / YouTube / X extraction. Fetch is always wrapped with safeFetch so
// every hop shares scheme, DNS-vs-private, redirect, byte, and time limits.
// LookupFn is injected; this module does not import node:dns.

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { ContentStatus, EnrichmentDegradation } from "../../schemas/manifest";
import {
  fetchWithRetry,
  parseRateLimitDelayMs,
  RateLimitedError,
  type RetryDeps,
} from "../http-retry";
import {
  BadStatusError,
  BlockedHostError,
  FetchTimeoutError,
  normalizeEnrichmentError,
  OversizedResponseError,
  RedditManualImportError,
  YoutubeEnrichmentParseError,
} from "./errors";
import { isRedditThreadUrl } from "./reddit";
import { readBoundedBody, sha256Bytes } from "./response-bytes";
import { assertSafeUrl, safeFetch, type LookupFn } from "./safe-fetch";
import { sourceDateFromPublishedTime } from "./source-date";
import { extractXThread, isXPostUrl } from "./x";
import {
  buildYoutubeMarkdown,
  canonicalWatchUrl,
  isYoutubeFetchableHost,
  isYoutubeWatchUrl,
  oembedUrl,
  parseOembed,
  parsePlayerResponse,
  parseVideoId,
  timedtextJson3Url,
  timedtextToText,
} from "./youtube";

export {
  BadStatusError,
  BlockedHostError,
  FetchTimeoutError,
  normalizeEnrichmentError,
  OversizedResponseError,
  redactDurableErrorText,
  redactUrlUserinfo,
  RedditManualImportError,
  XApiConfigError,
  XApiError,
  XThreadIncompleteError,
  XThreadOutsideRecentWindowError,
} from "./errors";
export {
  assertSafeUrl,
  DestinationResolutionError,
  isBlockedHost,
  safeFetch,
  TooManyRedirectsError,
  type LookupFn,
  type ResolvedAddress,
  type SafeFetchDeps,
} from "./safe-fetch";
export { sourceDateFromExtractOrPrior, sourceDateFromPublishedTime } from "./source-date";

export interface ExtractorDeps {
  fetch: typeof fetch;
  lookup: LookupFn;
  timeoutMs: number;
  maxBytes: number;
  retry?: RetryDeps;
  xBearerToken?: string;
  now?: () => number;
}

export interface ExtractedContent {
  raw: Uint8Array;
  content_type: string;
  content_status: ContentStatus;
  content_bytes: number;
  content_sha256: string;
  markdown?: string;
  title?: string;
  // Publication date of the source (UTC YYYY-MM-DD). HTML branch only, from
  // Readability's publishedTime. Absent when missing or implausible.
  source_date?: string;
  // Which path produced `markdown` on the HTML branch: true when Readability
  // crashed and the raw-DOM salvage recovered the text. Absent for every other
  // content type — a text/JSON capture has no Readability verdict to report.
  // The Worker ignores it; the local extraction agent tiers on it (a
  // salvage-only static extraction is what earns a headless render).
  salvaged?: boolean;
  // YouTube only: a swallowed watch-page or transcript miss. Absent when
  // enrichment succeeded or the URL was not a YouTube watch page.
  enrichment_degradation?: EnrichmentDegradation;
}

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export async function extractFromUrl(url: string, deps: ExtractorDeps): Promise<ExtractedContent> {
  // Fail closed on the submitted URL (scheme / userinfo / literal host) before
  // routing. HTML, YouTube, and X then share one per-hop DNS / redirect envelope
  // via safeFetch. lookup is required and injected — this module does not import
  // node:dns.
  assertSafeUrl(url);
  const fetch = safeFetch(deps.fetch, { lookup: deps.lookup });
  const guarded = { ...deps, fetch };
  if (isXPostUrl(url)) {
    return extractXThread(url, {
      fetch,
      bearerToken: deps.xBearerToken,
      timeoutMs: deps.timeoutMs,
      maxBytes: deps.maxBytes,
      retry: deps.retry,
      now: deps.now ?? Date.now,
    });
  }
  // Reddit thread JSON can't be fetched from datacenter egress (bot-challenge),
  // so fail with guidance toward the local reddit-import skill instead of
  // burning a generic fetch that would only capture the challenge page.
  if (isRedditThreadUrl(url)) throw new RedditManualImportError(url);
  // YouTube watch pages are JS shells with no article body. Build markdown from
  // the public oEmbed metadata (reliable floor) plus best-effort description +
  // transcript scraped from the watch page (issue #17).
  if (isYoutubeWatchUrl(url)) return extractYoutube(url, guarded);

  const { raw, contentType } = await fetchBounded(url, guarded);
  const content_sha256 = await sha256Bytes(raw);
  const base = {
    raw,
    content_type: contentType,
    content_bytes: raw.byteLength,
    content_sha256,
  };

  const major = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (major === "text/html" || major === "application/xhtml+xml") {
    const html = new TextDecoder("utf-8").decode(raw);
    const article = readabilityFromHtml(html, url);
    if (article && article.markdown.trim().length > 0) {
      const source_date = sourceDateFromPublishedTime(
        article.publishedTime,
        deps.now?.() ?? Date.now(),
      );
      return {
        ...base,
        content_status: "captured",
        markdown: article.markdown,
        title: article.title,
        salvaged: article.salvaged,
        ...(source_date === undefined ? {} : { source_date }),
      };
    }
    return { ...base, content_status: "raw_only" };
  }

  if (major === "text/plain" || major.startsWith("text/")) {
    const text = new TextDecoder("utf-8").decode(raw);
    return { ...base, content_status: "captured", markdown: text };
  }

  if (major === "application/json") {
    const text = new TextDecoder("utf-8").decode(raw);
    let pretty: string;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      pretty = text;
    }
    return { ...base, content_status: "captured", markdown: pretty };
  }

  return { ...base, content_status: "raw_only" };
}

// A desktop browser UA + consent cookie cut down on the consent-wall / bot
// friction the worker hits when fetching the watch page directly.
const YOUTUBE_WATCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  cookie: "CONSENT=YES+cb",
} as const;

// Tiered YouTube extraction: oEmbed is the required floor (title + author, and a
// 429 here surfaces RateLimitedError so the queue retries); the watch-page
// description/captions and the timedtext transcript are best-effort enrichment
// that degrade to the floor rather than fail the reading.
//
// The one exception is BlockedHostError: a tampered player response steering
// egress at a private address is a finding worth surfacing, not an enrichment
// miss to swallow. Everything else — hop caps, resolution failures, oversized
// pages, or a 200 consent/bot page with no player response — degrades like a
// 429 or a 5xx does, because losing the description is always cheaper than
// losing the reading. Soft parse misses (null player response, empty timedtext)
// are recorded the same way. Those swallowed misses land on
// ExtractedContent.enrichment_degradation so a ready floor reading is still
// findable for later re-enrichment (issue #254).
async function extractYoutube(url: string, deps: ExtractorDeps): Promise<ExtractedContent> {
  const videoId = parseVideoId(url);
  if (!videoId) throw new BadStatusError(url, 400);
  const watchUrl = canonicalWatchUrl(videoId);

  // Tier 1 — oEmbed floor. Let RateLimitedError / BadStatusError propagate.
  const oembedRaw = await fetchBounded(oembedUrl(videoId), deps);
  const oembed = parseOembed(new TextDecoder("utf-8").decode(oembedRaw.raw));
  if (!oembed) throw new BadStatusError(oembedUrl(videoId), 502);

  // Tier 2 — watch page (best-effort): description + caption tracks.
  let description: string | undefined;
  let captionBaseUrl: string | undefined;
  let watchRaw: Uint8Array | undefined;
  let enrichment_degradation: EnrichmentDegradation | undefined;
  try {
    const watch = await fetchBounded(watchUrl, deps, { headers: { ...YOUTUBE_WATCH_HEADERS } });
    watchRaw = watch.raw;
    const player = parsePlayerResponse(new TextDecoder("utf-8").decode(watch.raw));
    if (!player) {
      throw new YoutubeEnrichmentParseError("watch page did not contain a player response");
    }
    description = player.shortDescription;
    captionBaseUrl = player.captionTracks[0]?.baseUrl;
  } catch (e) {
    if (isTerminalFetchGuardError(e)) throw e;
    console.warn(`youtube watch-page enrichment failed for ${watchUrl}:`, e);
    enrichment_degradation = { source: "youtube", tier: "watch_page", ...normalizeEnrichmentError(e) };
  }

  // Tier 3 — transcript (best-effort): first caption track, json3.
  let transcript: string | undefined;
  if (captionBaseUrl && isYoutubeFetchableHost(captionBaseUrl)) {
    try {
      const tt = await fetchBounded(timedtextJson3Url(captionBaseUrl), deps);
      const text = timedtextToText(new TextDecoder("utf-8").decode(tt.raw));
      if (!text) {
        throw new YoutubeEnrichmentParseError("timedtext response was empty or unparseable");
      }
      transcript = text;
    } catch (e) {
      if (isTerminalFetchGuardError(e)) throw e;
      console.warn(`youtube transcript fetch failed for ${watchUrl}:`, e);
      enrichment_degradation ??= { source: "youtube", tier: "transcript", ...normalizeEnrichmentError(e) };
    }
  }

  const markdown = buildYoutubeMarkdown({
    title: oembed.title,
    authorName: oembed.authorName,
    authorUrl: oembed.authorUrl,
    watchUrl,
    description,
    transcript,
  });

  // Persist the richest bytes we actually fetched as `raw` so the R2 raw.{ext}
  // write stays meaningful and the sha covers real fetched content.
  const raw = watchRaw ?? oembedRaw.raw;
  const content_type = watchRaw ? "text/html; charset=utf-8" : "application/json; charset=utf-8";
  return {
    raw,
    content_type,
    content_bytes: raw.byteLength,
    content_sha256: await sha256Bytes(raw),
    content_status: "captured",
    markdown,
    title: oembed.title,
    ...(enrichment_degradation === undefined ? {} : { enrichment_degradation }),
  };
}

async function fetchBounded(
  url: string,
  deps: ExtractorDeps,
  init: RequestInit = {},
): Promise<{ raw: Uint8Array; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  let response: Response;
  try {
    const requestInit: RequestInit = { ...init, signal: controller.signal };
    response = deps.retry
      ? await fetchWithRetry(deps.fetch, url, requestInit, deps.retry)
      : await deps.fetch(url, requestInit);

    if (response.status === 429) {
      const retryAfterMs = parseRateLimitDelayMs(response.headers, Date.now);
      response.body?.cancel().catch(() => {});
      throw new RateLimitedError(429, retryAfterMs, url);
    }
    if (!response.ok) throw new BadStatusError(url, response.status);

    const contentType = response.headers.get("content-type") ?? DEFAULT_CONTENT_TYPE;
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > deps.maxBytes) {
        throw new OversizedResponseError(url, deps.maxBytes);
      }
    }

    const raw = await readBoundedBody(response, deps.maxBytes, url);
    return { raw, contentType };
  } catch (e) {
    if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
      throw new FetchTimeoutError(url, deps.timeoutMs);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

interface Article {
  markdown: string;
  title?: string;
}

export interface ArticleFromHtml extends Article {
  // false: Readability parsed the article. true: Readability threw and the
  // raw-DOM salvage below recovered the text, boilerplate and all.
  salvaged: boolean;
  // Readability's publishedTime string when present. Not normalized; callers
  // that persist a date run it through sourceDateFromPublishedTime.
  publishedTime?: string;
}

// The HTML→markdown rules, single-homed. Exported for the local extraction
// agent's headless tier, which runs this identical function against a
// Playwright-rendered DOM (plus that page's final URL) — the whole point of the
// tier is that a rendered JS shell goes through the same extractor the Worker
// uses, not a second copy of it. `salvaged` is the tiering signal: see
// ExtractedContent.salvaged.
export function readabilityFromHtml(html: string, url: string): ArticleFromHtml | null {
  // Readability/Turndown can throw on pathological documents — e.g. a page with
  // no <body> (the docs.spring.io case in issue #18, where the static fetch is a
  // script-only JS shell): Readability._grabArticle walks the topCandidate's
  // ancestor chain toward BODY, runs off the top of the tree to null, and reads
  // `null.tagName`. Rather than discard the page, salvage its text by
  // turndown-ing the raw parsed DOM. Only the throw path falls back — a clean
  // "no article" verdict still degrades to raw_only (we don't want to summarize
  // boilerplate from pages Readability deliberately rejected).
  try {
    const article = readabilityFromHtmlUnsafe(html, url);
    return article ? { ...article, salvaged: false } : null;
  } catch (e) {
    console.warn(`readability/turndown threw on ${url}, trying raw-DOM fallback:`, e);
    const salvaged = rawDomToMarkdown(html);
    if (salvaged) {
      console.warn(`raw-DOM fallback salvaged ${salvaged.markdown.length} chars for ${url}`);
      return { ...salvaged, salvaged: true };
    }
    return null;
  }
}

// Last-resort salvage when Readability crashes: turndown the raw DOM directly.
// Loses Readability's boilerplate stripping, but recovers the text of pages it
// can't parse at all (issue #18). Returns null when there's nothing to salvage.
function rawDomToMarkdown(html: string): Article | null {
  // Re-parse the ORIGINAL html — Readability mutates the document during
  // parse(), so the post-crash tree is unreliable.
  const { document } = parseHTML(html);
  // Capture the title before stripping <head> — it's metadata, not content.
  const title = document.querySelector("title")?.textContent?.trim() || undefined;
  // Strip <head> along with non-content nodes: when we fall back to
  // documentElement (empty-body case), turndown-ing the whole <html> would
  // otherwise pull <head><title>/<meta> text into the markdown, which could make
  // a content-less JS shell look `captured` (a title-only page) instead of
  // staying `raw_only`.
  for (const el of document.querySelectorAll("head, script, style, noscript, template")) {
    el.remove();
  }
  // The issue-#18 tree has an empty <body> with the real content hoisted as a
  // sibling under documentElement, so prefer <body> only when it holds text;
  // otherwise turndown the whole documentElement.
  const body = document.body;
  const root =
    body && body.textContent && body.textContent.trim().length > 0 ? body : document.documentElement;
  if (!root) return null;
  const markdown = makeTurndown()
    .turndown(root as unknown as Parameters<TurndownService["turndown"]>[0])
    .trim();
  if (markdown.length === 0) return null;
  return { markdown, title };
}

function readabilityFromHtmlUnsafe(html: string, url: string): (Article & { publishedTime?: string }) | null {
  // Inject a <base> into <head> so Readability resolves relative links against
  // the source URL. Skip the injection when the page already has its own
  // <base> (so we don't override the page's intent) or has no <head> at all.
  const needsBase = !/<base[\s>]/i.test(html) && /<head[\s>]/i.test(html);
  const htmlWithBase = needsBase
    ? html.replace(/<head([^>]*)>/i, `<head$1><base href="${escapeAttr(url)}">`)
    : html;
  const { document } = parseHTML(htmlWithBase);
  // linkedom Document is structurally compatible with what Readability needs at
  // runtime, but Workers types don't include the DOM lib so we bridge via `any`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reader = new Readability(document as any, { charThreshold: 100 });
  const article = reader.parse();
  if (!article || !article.content) return null;

  const turndown = makeTurndown();
  const { document: contentDoc } = parseHTML(
    `<!doctype html><html><body>${article.content}</body></html>`,
  );
  // Turndown accepts either a string or a DOM Node; pass the linkedom body so we
  // bypass turndown's internal DOMParser (which requires a `document` global).
  const markdown = turndown.turndown(contentDoc.body as unknown as Parameters<TurndownService["turndown"]>[0]).trim();
  if (markdown.length === 0) return null;

  const publishedTime = article.publishedTime?.trim() || undefined;
  return {
    markdown,
    title: article.title?.trim() || undefined,
    ...(publishedTime === undefined ? {} : { publishedTime }),
  };
}

function makeTurndown(): TurndownService {
  return new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function isTerminalFetchGuardError(error: unknown): boolean {
  return error instanceof BlockedHostError;
}
