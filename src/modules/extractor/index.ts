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
  // Inject a <base> into <head> so Readability resolves relative links against the
  // source URL. If <head> is missing, fall back to parsing the html as-is.
  const htmlWithBase = html.includes("<head")
    ? html.replace(/<head([^>]*)>/i, `<head$1><base href="${escapeAttr(url)}">`)
    : html;
  const { document } = parseHTML(htmlWithBase);
  // linkedom Document is structurally compatible with what Readability needs at
  // runtime, but Workers types don't include the DOM lib so we bridge via `any`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reader = new Readability(document as any, { charThreshold: 100 });
  const article = reader.parse();
  if (!article || !article.content) return null;

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  const { document: contentDoc } = parseHTML(
    `<!doctype html><html><body>${article.content}</body></html>`,
  );
  // Turndown accepts either a string or a DOM Node; pass the linkedom body so we
  // bypass turndown's internal DOMParser (which requires a `document` global).
  const markdown = turndown.turndown(contentDoc.body as unknown as Parameters<TurndownService["turndown"]>[0]).trim();
  if (markdown.length === 0) return null;

  return { markdown, title: article.title?.trim() || undefined };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
