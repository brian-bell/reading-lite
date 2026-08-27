import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const DEFAULT_WEB_BASE_URL = "https://reading-lite.bbell.dev";
export const CONTENT_CHUNK_BYTES = 200 * 1024;
export const POLL_INTERVAL_MS = 2_000;
export const POLL_MAX_WAIT_MS = 25_000;

export function publicReadingUrl(webBaseUrl: string | undefined, id: string): string {
  const raw = webBaseUrl && webBaseUrl.trim().length > 0 ? webBaseUrl : DEFAULT_WEB_BASE_URL;
  const origin = raw.replace(/\/+$/, "");
  return `${origin}/readings/${id}`;
}

export function publicMarkdownLink(title: string | undefined, url: string): string {
  const label = title && title.trim().length > 0 ? title.trim() : url;
  return `[${label}](${url})`;
}

export interface Utf8Slice {
  text: string;
  bytes_total: number;
  bytes_returned: number;
  offset: number;
  truncated: boolean;
  next_offset: number | null;
}

export function sliceUtf8(text: string, offsetBytes: number, maxBytes: number): Utf8Slice {
  const bytes = new TextEncoder().encode(text);
  const start = Math.max(0, Math.min(offsetBytes, bytes.length));
  const end = Math.min(bytes.length, start + Math.max(0, maxBytes));
  const chunk = bytes.subarray(start, end);
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  const truncated = end < bytes.length;
  return {
    text: decoder.decode(chunk),
    bytes_total: bytes.length,
    bytes_returned: chunk.byteLength,
    offset: start,
    truncated,
    next_offset: truncated ? end : null,
  };
}

export function jsonToolResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function errorToolResult(httpStatus: number, error: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ http_status: httpStatus, error }, null, 2),
      },
    ],
  };
}

export function mapHttpError(status: number, bodyError: string | undefined): string {
  if (status === 401 || status === 403) {
    if (bodyError && /1010/.test(bodyError)) {
      return "rate limited; back off and retry";
    }
    return "bad or missing token";
  }
  if (status === 404 && (!bodyError || bodyError === "not found")) {
    return "unknown id";
  }
  if (status === 1010 || (bodyError && /1010/.test(bodyError))) {
    return "rate limited; back off and retry";
  }
  return bodyError && bodyError.length > 0 ? bodyError : "request failed";
}

export function maxPolls(maxWaitMs: number, intervalMs: number): number {
  return Math.max(1, Math.ceil(maxWaitMs / intervalMs) + 1);
}
