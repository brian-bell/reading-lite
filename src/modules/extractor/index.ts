import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { ContentStatus } from "../../schemas/manifest";

export class FetchTimeoutError extends Error {
  constructor(public readonly url: string, public readonly timeoutMs: number) {
    super(`fetch timed out after ${timeoutMs}ms: ${url}`);
    this.name = "FetchTimeoutError";
  }
}

export class OversizedResponseError extends Error {
  constructor(public readonly url: string, public readonly maxBytes: number) {
    super(`response exceeded maxBytes=${maxBytes}: ${url}`);
    this.name = "OversizedResponseError";
  }
}

export class BadStatusError extends Error {
  constructor(public readonly url: string, public readonly status: number) {
    super(`bad response status ${status}: ${url}`);
    this.name = "BadStatusError";
  }
}

export class BlockedHostError extends Error {
  constructor(public readonly url: string, public readonly reason: string) {
    super(`blocked host (${reason}): ${url}`);
    this.name = "BlockedHostError";
  }
}

export interface ExtractorDeps {
  fetch: typeof fetch;
  timeoutMs: number;
  maxBytes: number;
}

export interface ExtractedContent {
  raw: Uint8Array;
  content_type: string;
  content_status: ContentStatus;
  content_bytes: number;
  content_sha256: string;
  markdown?: string;
  title?: string;
}

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export async function extractFromUrl(url: string, deps: ExtractorDeps): Promise<ExtractedContent> {
  assertSafeUrl(url);
  const { raw, contentType } = await fetchBounded(url, deps);
  const content_sha256 = await sha256Hex(raw);
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
      return { ...base, content_status: "captured", markdown: article.markdown, title: article.title };
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

async function fetchBounded(
  url: string,
  deps: ExtractorDeps,
): Promise<{ raw: Uint8Array; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  let response: Response;
  try {
    response = await deps.fetch(url, { signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
      throw new FetchTimeoutError(url, deps.timeoutMs);
    }
    throw e;
  } finally {
    clearTimeout(timer);
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
}

async function readBoundedBody(response: Response, maxBytes: number, url: string): Promise<Uint8Array> {
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

interface Article {
  markdown: string;
  title?: string;
}

function readabilityFromHtml(html: string, url: string): Article | null {
  // Readability/Turndown can throw on pathological documents — e.g. a page with
  // no <body> (the docs.spring.io case in issue #18, where the static fetch is a
  // script-only JS shell): Readability._grabArticle walks the topCandidate's
  // ancestor chain toward BODY, runs off the top of the tree to null, and reads
  // `null.tagName`. Rather than discard the page, salvage its text by
  // turndown-ing the raw parsed DOM. Only the throw path falls back — a clean
  // "no article" verdict still degrades to raw_only (we don't want to summarize
  // boilerplate from pages Readability deliberately rejected).
  try {
    return readabilityFromHtmlUnsafe(html, url);
  } catch (e) {
    console.warn(`readability/turndown threw on ${url}, trying raw-DOM fallback:`, e);
    const salvaged = rawDomToMarkdown(html);
    if (salvaged) {
      console.warn(`raw-DOM fallback salvaged ${salvaged.markdown.length} chars for ${url}`);
      return salvaged;
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
  for (const el of document.querySelectorAll("script, style, noscript, template")) {
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
  const title = document.querySelector("title")?.textContent?.trim() || undefined;
  return { markdown, title };
}

function readabilityFromHtmlUnsafe(html: string, url: string): Article | null {
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

  return { markdown, title: article.title?.trim() || undefined };
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

function assertSafeUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BlockedHostError(rawUrl, "invalid url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BlockedHostError(rawUrl, `non-http(s) scheme: ${parsed.protocol}`);
  }
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (isBlockedHostname(host)) {
    throw new BlockedHostError(rawUrl, `private/loopback/link-local: ${host}`);
  }
}

function isBlockedHostname(host: string): boolean {
  if (host === "localhost" || host === "localhost.") return true;
  if (host.endsWith(".local") || host.endsWith(".local.")) return true;

  if (isBlockedV4(host)) return true;

  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) decode to
    // the embedded IPv4; re-run the v4 rules against that address.
    const embedded = embeddedIPv4(host);
    if (embedded && isBlockedV4(embedded)) return true;
    const head = host.split(":")[0] ?? "";
    if (head.startsWith("fc") || head.startsWith("fd")) return true;
    if (/^fe[89ab][0-9a-f]{0,2}$/.test(head)) return true;
  }
  return false;
}

function isBlockedV4(host: string): boolean {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function embeddedIPv4(host: string): string | null {
  // host is bracket-stripped, lowercased. WHATWG URL canonicalizes
  // "[::ffff:127.0.0.1]" to "[::ffff:7f00:1]" so we need to expand "::" and
  // decode the trailing 32 bits.
  let segments: string[];
  if (host.includes("::")) {
    const [left, right] = host.split("::", 2) as [string, string];
    const leftParts = left === "" ? [] : left.split(":");
    const rightParts = right === "" ? [] : right.split(":");
    const fill = 8 - leftParts.length - rightParts.length;
    if (fill < 0) return null;
    segments = [...leftParts, ...Array<string>(fill).fill("0"), ...rightParts];
  } else {
    segments = host.split(":");
  }
  if (segments.length !== 8) return null;
  for (let i = 0; i < 5; i++) {
    if (segments[i] !== "0") return null;
  }
  if (segments[5] !== "0" && segments[5] !== "ffff") return null;
  const hi = parseInt(segments[6]!, 16);
  const lo = parseInt(segments[7]!, 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
