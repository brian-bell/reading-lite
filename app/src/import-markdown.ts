import { MARKDOWN_IMPORT_BUDGET_BYTES } from "./markdown-import-limit";
import { webUrlProblem } from "./save";

// Importing Markdown (#408, Phase 4 of #339): the rules the form applies
// before it asks, and the body it sends to POST /api/readings/import-markdown.
// Pure, so both are tested without a DOM; api/save.ts does the
// request, save.ts's submitFromResponse reads the answer (the import shares
// the URL save's outcomes), and MarkdownImportForm.tsx renders the fields.
//
// The rules mirror the backend's PostReadingsImportMarkdownBodySchema in
// src/schemas/api.ts: a web `source_url`, a non-empty `markdown`, and a
// `title` that is either absent or not blank. As with the URL save, they exist
// to save a round trip on an obvious mistake, not to replace the backend's
// judgement: a source URL this accepts can still come back 400.
//
// The size rule is the one the backend has no answer for. The whole request
// travels in one Cloudflare Queues message, capped at 128 KB, and an oversized
// one is only refused when it is sent — after the reading, its URL, and its
// content were written — as a 503 that reads like any queue outage and leaves
// a failed reading behind. So the form measures what it would send, the way
// the operator gate does (scripts/extract-agent-lib/gates.ts), and never sends
// a paste that cannot fit.

export interface MarkdownImportValues {
  sourceUrl: string;
  title: string;
  markdown: string;
}

/** The fields a rule can refuse, in the order the form shows them. */
export const MARKDOWN_IMPORT_FIELDS = ["sourceUrl", "markdown"] as const;
export type MarkdownImportField = (typeof MARKDOWN_IMPORT_FIELDS)[number];

export type MarkdownImportProblems = Partial<Record<MarkdownImportField, string>>;

/** The request body, in the backend's field names. */
export interface MarkdownImportBody {
  source_url: string;
  title?: string;
  markdown: string;
}

export const MARKDOWN_TOO_LARGE =
  "This Markdown is too large to import. Imports are limited to 128 KB; shorten the text and try again.";

/** What the form sends for these values: trimmed where the backend trims, untouched Markdown. */
export function markdownImportBody(values: MarkdownImportValues): MarkdownImportBody {
  const title = values.title.trim();
  return {
    source_url: values.sourceUrl.trim(),
    // A blank title is no title: the backend refuses one that trims to nothing.
    ...(title === "" ? {} : { title }),
    markdown: values.markdown,
  };
}

/**
 * What the body costs in the queue message: its JSON serialization in UTF-8
 * bytes. Escaping is why this is more than the Markdown's length — a body
 * full of quotes or backslashes serializes to nearly twice its raw size.
 */
export function markdownImportBytes(body: MarkdownImportBody): number {
  return new TextEncoder().encode(JSON.stringify(body)).byteLength;
}

/** Why these values cannot be imported, per field; empty when they can be tried. */
export function markdownImportProblems(values: MarkdownImportValues): MarkdownImportProblems {
  const problems: MarkdownImportProblems = {};
  const sourceUrl = webUrlProblem(values.sourceUrl, {
    empty: "Enter the URL the Markdown came from.",
    notWeb: "Only http and https source URLs can be imported.",
  });
  if (sourceUrl !== undefined) problems.sourceUrl = sourceUrl;
  if (values.markdown.trim() === "") {
    problems.markdown = "Paste the Markdown you want to import.";
  } else if (markdownImportBytes(markdownImportBody(values)) > MARKDOWN_IMPORT_BUDGET_BYTES) {
    problems.markdown = MARKDOWN_TOO_LARGE;
  }
  return problems;
}

/** The first field with a problem, in the order the form shows them: where focus goes. */
export function firstProblemField(problems: MarkdownImportProblems): MarkdownImportField | undefined {
  return MARKDOWN_IMPORT_FIELDS.find((field) => problems[field] !== undefined);
}
