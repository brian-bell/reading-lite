// The queue limit a Markdown import must fit (#408), kept free of imports so
// the root Worker suite can pin it to the operator tooling's own constants
// (test/unit/import-markdown/app-limit.test.ts): the browser and the operator
// gates refuse the same pastes, and neither drifts from the other.

/** Cloudflare Queues' message limit, as the operator tooling spells it (scripts/import-markdown-lib/parse.ts). */
export const MARKDOWN_IMPORT_MAX_BYTES = 128_000;

/**
 * Headroom for the rest of the queue envelope — ids, keys, the tenant — which
 * the body does not carry (scripts/youtube-import-lib/parse.ts).
 */
export const QUEUE_ENVELOPE_RESERVE = 1024;

/** What the body may cost inside the queue message. */
export const MARKDOWN_IMPORT_BUDGET_BYTES = MARKDOWN_IMPORT_MAX_BYTES - QUEUE_ENVELOPE_RESERVE;
