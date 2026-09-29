import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const CONTENT_CHUNK_BYTES = 200 * 1024;

export function publicReadingUrl(webBaseUrl: string | undefined, id: string): string | undefined {
  const raw = webBaseUrl?.trim();
  if (!raw) return undefined;
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

function utf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function utf8SeqLen(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

export function sliceUtf8(text: string, offsetBytes: number, maxBytes: number): Utf8Slice {
  const bytes = new TextEncoder().encode(text);
  let start = Math.max(0, Math.min(offsetBytes, bytes.length));
  while (start < bytes.length && utf8Continuation(bytes[start]!)) {
    start += 1;
  }
  const budget = Math.max(0, maxBytes);
  const limit = Math.min(bytes.length, start + budget);
  let end = start;
  if (budget > 0) {
    while (end < bytes.length) {
      const next = end + utf8SeqLen(bytes[end]!);
      if (next > bytes.length) break;
      if (next > limit && end > start) break;
      end = next;
      if (end >= limit) break;
    }
  }
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
