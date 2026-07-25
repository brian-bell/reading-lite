// Submit gates. Every submit triggers paid Anthropic + OpenAI work, so a
// rejected gate costs nothing while a bad submit costs money — reject freely.

import { MARKDOWN_IMPORT_MAX_BYTES } from "../import-markdown-lib/parse";
import { QUEUE_ENVELOPE_RESERVE } from "../youtube-import-lib/parse";
import type { SubmitBody } from "./submit";

// The size ceiling is a queue constraint, not a summarize one: both submit
// paths inline the markdown in the ProcessReadingArgs queue message, and
// Cloudflare Queues caps the serialized message at 128 KB. Reserve the same
// envelope headroom youtube-import does (single-homed constants, no copies).
export const MARKDOWN_SUBMIT_BUDGET_BYTES = MARKDOWN_IMPORT_MAX_BYTES - QUEUE_ENVELOPE_RESERVE;

export type GateVerdict = { ok: true } | { ok: false; why: "too_short" | "over_ceiling" };

// Cost of `text` inside the serialized queue message: JSON-escaped UTF-8 bytes,
// less the two quote delimiters (fixed framing the envelope reserve covers).
// Escaping is what makes this more than a byte count — a body full of quotes or
// backslashes serializes to nearly twice its raw size, and the 1 KB reserve only
// covers fixed envelope overhead, not unbounded per-character expansion.
function serializedBytes(text: string): number {
  return new TextEncoder().encode(JSON.stringify(text)).byteLength - 2;
}

// Takes the whole submit body rather than the markdown alone: the Worker
// forwards every variable field of it — markdown, title, source_url — inside
// one ProcessReadingArgs queue message, so anything the caller sends but the
// gate doesn't measure can pass here and then 503 at `queue.send` *after* the
// eager artifact/manifest/list writes, rolling a recoverable failed reading
// into a QueueSendError at `queued`. Gating the exact object that gets
// submitted is what keeps that class of gap from reopening field by field.
export function markdownGate(body: SubmitBody, cfg: { minArticleChars: number }): GateVerdict {
  if (body.markdown.trim().length < cfg.minArticleChars) return { ok: false, why: "too_short" };
  const bytes = (Object.values(body) as string[])
    .filter((value) => typeof value === "string")
    .reduce((total, value) => total + serializedBytes(value), 0);
  if (bytes > MARKDOWN_SUBMIT_BUDGET_BYTES) {
    return { ok: false, why: "over_ceiling" };
  }
  return { ok: true };
}

// Hard per-run cap on paid actions; only actual submits consume it. The slot is
// reserved *before* the submit (never overshoot the cap on an in-flight call)
// and released again when the response proves no paid work was enqueued.
export interface Budget {
  tryConsume(): boolean;
  release(): void;
  readonly consumed: number;
}

export function makeBudget(cap: number): Budget {
  let consumed = 0;
  return {
    tryConsume() {
      if (consumed >= cap) return false;
      consumed += 1;
      return true;
    },
    release() {
      if (consumed > 0) consumed -= 1;
    },
    get consumed() {
      return consumed;
    },
  };
}
