import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiErrorResult, dispatchApi, jsonBody, type McpDispatch } from "./dispatch";
import {
  CONTENT_CHUNK_BYTES,
  errorToolResult,
  jsonToolResult,
  publicMarkdownLink,
  publicReadingUrl,
  sliceUtf8,
} from "./format";

export const MCP_TOOL_NAMES = [
  "list_readings",
  "search_readings",
  "get_reading",
  "get_reading_content",
  "submit_url",
  "import_markdown",
  "reprocess_reading",
  "delete_reading",
  "get_diagnostics",
  "list_inbox",
  "get_inbox_item",
  "discard_inbox_item",
] as const;

export interface McpToolContext {
  dispatch: McpDispatch;
  webBaseUrl: string;
}

// Agent-supplied Markdown reaches the corpus only through a person's review
// (reading-lite-gh423): import_markdown stages it in the inbox, promote is
// REST-only, and reprocess_reading refuses a Markdown source.
const STAGED_NOTE = "staged in your inbox; not in the library until a person promotes it";
const MARKDOWN_REPROCESS_REFUSED =
  "reprocess_reading does not accept a markdown source; stage the text with import_markdown for a person to review and promote";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readingIdOf(value: unknown): string | undefined {
  const rec = asRecord(value);
  const id = rec?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function readingStatusOf(value: unknown): string | undefined {
  const rec = asRecord(value);
  const status = rec?.status;
  return typeof status === "string" ? status : undefined;
}

function readingTitleOf(value: unknown): string | undefined {
  const rec = asRecord(value);
  const title = rec?.title;
  return typeof title === "string" ? title : undefined;
}

function listQuery(args: { q?: string; tag?: string; limit?: number; offset?: number }): string {
  const params = new URLSearchParams();
  if (args.q !== undefined) params.set("q", args.q);
  if (args.tag !== undefined) params.set("tag", args.tag);
  params.set("limit", String(args.limit ?? 20));
  params.set("offset", String(args.offset ?? 0));
  return `/api/readings?${params.toString()}`;
}

function ingestResult(
  ctx: McpToolContext,
  status: number,
  json: unknown,
  extra: Record<string, unknown> = {},
) {
  const id = readingIdOf(json);
  const readingStatus = readingStatusOf(json);
  const existing = status === 200;
  const publicUrl = id ? publicReadingUrl(ctx.webBaseUrl, id) : undefined;
  const title =
    readingTitleOf(json) ?? (typeof extra.title === "string" ? extra.title : undefined);
  return jsonToolResult({
    id,
    status: readingStatus,
    existing,
    note: existing
      ? "existing reading returned, no new stub"
      : "ingest is async; not ready until polled",
    ...(publicUrl ? { public_url: publicUrl } : {}),
    ...(publicUrl ? { public_markdown_link: publicMarkdownLink(title, publicUrl) } : {}),
    ...extra,
  });
}

export function registerMcpTools(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    "list_readings",
    {
      title: "List readings",
      description:
        "List corpus readings as metadata only (id, title, tldr, tags, status). Use for browsing or a full sweep via offset while has_more is true. Pass q to search. Does not return full bodies.",
      inputSchema: {
        q: z.string().optional().describe("Optional search substring across title, tldr, url, and keywords"),
        tag: z.string().optional().describe("Optional exact tag filter"),
        limit: z.number().int().min(1).max(50).optional().describe("Page size (default 20, cap 50)"),
        offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const out = await dispatchApi(ctx.dispatch, listQuery(args));
      if (!out.ok) return apiErrorResult(out);
      return jsonToolResult(out.json);
    },
  );

  server.registerTool(
    "search_readings",
    {
      title: "Search readings",
      description:
        "Search the corpus by required query string q. Same payload as list_readings (metadata only). Use get_reading_content to fetch a body by id.",
      inputSchema: {
        q: z.string().min(1).describe("Required search substring across title, tldr, url, and keywords"),
        tag: z.string().optional().describe("Optional exact tag filter"),
        limit: z.number().int().min(1).max(50).optional().describe("Page size (default 20, cap 50)"),
        offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const out = await dispatchApi(ctx.dispatch, listQuery(args));
      if (!out.ok) return apiErrorResult(out);
      return jsonToolResult(out.json);
    },
  );

  server.registerTool(
    "get_reading",
    {
      title: "Get reading",
      description:
        "Fetch one reading's metadata and summary_markdown by id. Includes public_url when WEB_BASE_URL is configured. Does not include the full extracted body — use get_reading_content for that.",
      inputSchema: {
        id: z.string().min(1).describe("Reading id (rd_…)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const out = await dispatchApi(ctx.dispatch, `/api/readings/${encodeURIComponent(args.id)}`);
      if (!out.ok) return apiErrorResult(out);
      // relationship_targets is HTTP-only enrichment for the web UI; MCP
      // reading output stays the manifest shape.
      const { relationship_targets: _targets, ...rec } = asRecord(out.json) ?? {};
      const publicUrl = publicReadingUrl(ctx.webBaseUrl, args.id);
      return jsonToolResult({
        ...rec,
        ...(publicUrl
          ? {
              public_url: publicUrl,
              public_markdown_link: publicMarkdownLink(readingTitleOf(out.json), publicUrl),
            }
          : {}),
      });
    },
  );

  server.registerTool(
    "get_reading_content",
    {
      title: "Get reading content",
      description:
        "Fetch the extracted markdown body for one reading id. Large bodies are truncated; inspect bytes_total/truncated and pass offset to continue. Do not request many bodies at once.",
      inputSchema: {
        id: z.string().min(1).describe("Reading id (rd_…)"),
        offset: z.number().int().min(0).optional().describe("Byte offset into the extracted markdown (default 0)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const out = await dispatchApi(
        ctx.dispatch,
        `/api/readings/${encodeURIComponent(args.id)}/content`,
      );
      if (!out.ok) return apiErrorResult(out);
      const markdown = out.text ?? "";
      const slice = sliceUtf8(markdown, args.offset ?? 0, CONTENT_CHUNK_BYTES);
      const publicUrl = publicReadingUrl(ctx.webBaseUrl, args.id);
      return jsonToolResult({
        id: args.id,
        ...(publicUrl ? { public_url: publicUrl } : {}),
        content_type: "text/markdown",
        bytes_total: slice.bytes_total,
        bytes_returned: slice.bytes_returned,
        offset: slice.offset,
        truncated: slice.truncated,
        next_offset: slice.next_offset,
        markdown: slice.text,
      });
    },
  );

  server.registerTool(
    "submit_url",
    {
      title: "Submit URL",
      description:
        "MUTATES the corpus. Ingest a URL via POST /api/readings. Returns id + status; do not claim ready until polled (or a later get_reading). If the URL is already owned, returns the existing id instead of creating a second stub.",
      inputSchema: {
        url: z.string().url().describe("http(s) URL to ingest"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const out = await dispatchApi(ctx.dispatch, "/api/readings", jsonBody({ url: args.url, email: false }));
      if (!out.ok) return apiErrorResult(out);
      return ingestResult(ctx, out.status, out.json);
    },
  );

  server.registerTool(
    "import_markdown",
    {
      title: "Import markdown",
      description:
        "STAGES markdown in your inbox; not in the library until a person promotes it. Use when you already have the text for a source_url (X, YouTube transcripts, Reddit). source_url is the identity key: staging the same URL again replaces its inbox item. Returns inbox_item_id (never a public_url), plus corpus_reading when a failed reading already owns the URL. If a ready or pending reading already owns the URL, nothing is staged and it returns existing with that reading and its public_markdown_link.",
      inputSchema: {
        source_url: z.string().url().describe("https source URL used for identity/dedupe"),
        markdown: z.string().min(1).describe("Extracted article markdown"),
        title: z.string().min(1).optional().describe("Optional title override"),
      },
      // Destructive and not idempotent: a re-stage replaces the item's text
      // and title, and a ready or pending owner discards the staged item.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const out = await dispatchApi(
        ctx.dispatch,
        "/api/inbox",
        jsonBody({
          source_url: args.source_url,
          markdown: args.markdown,
          ...(args.title ? { title: args.title } : {}),
        }),
      );
      if (!out.ok) return apiErrorResult(out);
      const body = asRecord(out.json) ?? {};
      if (body.existing === true) {
        const id = readingIdOf(body.reading);
        const publicUrl = id ? publicReadingUrl(ctx.webBaseUrl, id) : undefined;
        return jsonToolResult({
          existing: true,
          reading: body.reading,
          note: "a reading already owns this url; nothing was staged",
          ...(publicUrl
            ? { public_url: publicUrl, public_markdown_link: publicMarkdownLink(readingTitleOf(body.reading), publicUrl) }
            : {}),
        });
      }
      return jsonToolResult({ ...body, note: STAGED_NOTE });
    },
  );

  server.registerTool(
    "reprocess_reading",
    {
      title: "Reprocess reading",
      description:
        "MUTATES the corpus. Start a fresh processing attempt for an existing reading id from its URL. Use when a stub exists and needs to be redone. Optional body takes force and email. A markdown source is refused: stage text with import_markdown instead.",
      inputSchema: {
        id: z.string().min(1).describe("Reading id (rd_…)"),
        body: z
          .object({
            force: z.boolean().optional(),
            email: z.boolean().optional(),
            source: z
              .object({
                kind: z.literal("markdown"),
                markdown: z.string().min(1),
                title: z.string().min(1).optional(),
              })
              .optional(),
          })
          .optional()
          .describe("Optional reprocess JSON body"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      // Refused here, not left to zod: dropping an unknown `source` would
      // silently turn the call into a URL reprocess.
      if (args.body?.source) return errorToolResult(400, MARKDOWN_REPROCESS_REFUSED);
      const init: RequestInit =
        args.body === undefined
          ? { method: "POST", headers: { "content-type": "application/json" }, body: "" }
          : jsonBody(args.body);
      const out = await dispatchApi(
        ctx.dispatch,
        `/api/readings/${encodeURIComponent(args.id)}/reprocess`,
        init,
      );
      if (!out.ok) return apiErrorResult(out);
      return ingestResult(ctx, out.status, out.json);
    },
  );

  server.registerTool(
    "delete_reading",
    {
      title: "Delete reading",
      description:
        "DELETES one reading by id for the signed-in tenant, via DELETE /api/readings/:id. Requires readings:delete. Returns the purge report. An unknown id is an error; a non-stale running attempt conflicts and leaves the reading intact.",
      inputSchema: {
        id: z.string().min(1).describe("Reading id (rd_…)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const out = await dispatchApi(ctx.dispatch, `/api/readings/${encodeURIComponent(args.id)}`, {
        method: "DELETE",
      });
      if (!out.ok) return apiErrorResult(out);
      return jsonToolResult(out.json);
    },
  );

  server.registerTool(
    "get_diagnostics",
    {
      title: "Get diagnostics",
      description:
        "Fetch pipeline/manifest debug JSON for a reading id. Use when an import or submit stalls (pending/failed) to inspect attempts, pointers, and objects.",
      inputSchema: {
        id: z.string().min(1).describe("Reading id (rd_…)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const out = await dispatchApi(
        ctx.dispatch,
        `/api/readings/${encodeURIComponent(args.id)}/diagnostics`,
      );
      if (!out.ok) return apiErrorResult(out);
      return jsonToolResult(out.json);
    },
  );

  server.registerTool(
    "list_inbox",
    {
      title: "List inbox",
      description:
        "List the markdown staged in your inbox awaiting a person's review, metadata only (id, url, title, markdown_bytes), most recently staged first. Inbox items are not readings.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const out = await dispatchApi(ctx.dispatch, "/api/inbox");
      if (!out.ok) return apiErrorResult(out);
      return jsonToolResult(out.json);
    },
  );

  server.registerTool(
    "get_inbox_item",
    {
      title: "Get inbox item",
      description:
        "Fetch one inbox item's staged markdown by id. Large bodies are truncated; inspect bytes_total/truncated and pass offset to continue.",
      inputSchema: {
        id: z.string().min(1).describe("Inbox item id (in_…)"),
        offset: z.number().int().min(0).optional().describe("Byte offset into the staged markdown (default 0)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const out = await dispatchApi(ctx.dispatch, `/api/inbox/${encodeURIComponent(args.id)}`);
      if (!out.ok) return apiErrorResult(out);
      const { markdown, markdown_bytes: _bytes, ...meta } = asRecord(out.json) ?? {};
      const slice = sliceUtf8(typeof markdown === "string" ? markdown : "", args.offset ?? 0, CONTENT_CHUNK_BYTES);
      return jsonToolResult({
        ...meta,
        bytes_total: slice.bytes_total,
        bytes_returned: slice.bytes_returned,
        offset: slice.offset,
        truncated: slice.truncated,
        next_offset: slice.next_offset,
        markdown: slice.text,
      });
    },
  );

  server.registerTool(
    "discard_inbox_item",
    {
      title: "Discard inbox item",
      description:
        "Delete one staged inbox item by id, for markdown that should not be promoted. Does not touch the library.",
      inputSchema: {
        id: z.string().min(1).describe("Inbox item id (in_…)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const out = await dispatchApi(ctx.dispatch, `/api/inbox/${encodeURIComponent(args.id)}`, { method: "DELETE" });
      if (!out.ok) return apiErrorResult(out);
      return jsonToolResult({ id: args.id, discarded: true });
    },
  );
}
