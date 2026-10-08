// The queue limit a Markdown import must fit (#408), kept free of imports.
// It must equal the operator tooling's own constant so the browser and the
// operator gates refuse the same pastes; no test pins the two together.

/** Cloudflare Queues' message limit, as the operator tooling spells it (scripts/import-markdown-lib/parse.ts). */
export const MARKDOWN_IMPORT_MAX_BYTES = 128_000;

/**
 * Headroom for the rest of the queue envelope — ids, keys, the tenant — which
 * the body does not carry (scripts/youtube-import-lib/parse.ts).
 */
export const QUEUE_ENVELOPE_RESERVE = 1024;

/** What the body may cost inside the queue message. */
export const MARKDOWN_IMPORT_BUDGET_BYTES = MARKDOWN_IMPORT_MAX_BYTES - QUEUE_ENVELOPE_RESERVE;
