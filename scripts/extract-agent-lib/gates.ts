// Submit gates. Every submit triggers paid Anthropic + OpenAI work, so a
// rejected gate costs nothing while a bad submit costs money — reject freely.

import { MARKDOWN_IMPORT_MAX_BYTES } from "../import-markdown-lib/parse";
import { QUEUE_ENVELOPE_RESERVE } from "../youtube-import-lib/parse";

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

// `title` is measured alongside the markdown because the submit sends both in
// the same import body, and the Worker forwards both in the same queue message.
// A long Readability title on a body sitting at the ceiling would otherwise pass
// here and 503 the send *after* the eager manifest/list writes, replacing the
// recoverable failure with a QueueSendError at `queued`.
export function markdownGate(
  markdown: string,
  cfg: { minArticleChars: number },
  title?: string,
): GateVerdict {
  if (markdown.trim().length < cfg.minArticleChars) return { ok: false, why: "too_short" };
  const bytes = serializedBytes(markdown) + (title ? serializedBytes(title) : 0);
  if (bytes > MARKDOWN_SUBMIT_BUDGET_BYTES) {
    return { ok: false, why: "over_ceiling" };
  }
  return { ok: true };
}

// Hard per-run cap on paid actions; only actual submits consume it.
export interface Budget {
  tryConsume(): boolean;
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
    get consumed() {
      return consumed;
    },
  };
}
