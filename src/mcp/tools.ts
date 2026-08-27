import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiErrorResult, dispatchApi, jsonBody, type McpDispatch } from "./dispatch";
import {
  CONTENT_CHUNK_BYTES,
  jsonToolResult,
  POLL_INTERVAL_MS,
  POLL_MAX_WAIT_MS,
  publicMarkdownLink,
  publicReadingUrl,
  sliceUtf8,
  maxPolls,
} from "./format";

export const MCP_TOOL_NAMES = [
  "list_readings",
  "search_readings",
  "get_reading",
  "get_reading_content",
  "submit_url",
  "import_markdown",
  "reprocess_reading",
  "get_diagnostics",
] as const;

export interface McpToolContext {
  dispatch: McpDispatch;
  webBaseUrl: string;
  sleep: (ms: number) => Promise<void>;
}

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

function isTerminalStatus(status: string | undefined): boolean {
  return status === "ready" || status === "failed";
}

function listQuery(args: { q?: string; tag?: string; limit?: number; offset?: number }): string {
  const params = new URLSearchParams();
  if (args.q !== undefined) params.set("q", args.q);
  if (args.tag !== undefined) params.set("tag", args.tag);
  params.set("limit", String(args.limit ?? 20));
  params.set("offset", String(args.offset ?? 0));
  return `/api/readings?${params.toString()}`;
}

async function pollUntilTerminal(
  ctx: McpToolContext,
  id: string,
): Promise<ReturnType<typeof dispatchApi>> {
  const attempts = maxPolls(POLL_MAX_WAIT_MS, POLL_INTERVAL_MS);
  let last = await dispatchApi(ctx.dispatch, `/api/readings/${encodeURIComponent(id)}`);
  for (let i = 0; i < attempts; i++) {
    if (!last.ok) return last;
    if (isTerminalStatus(readingStatusOf(last.json))) return last;
    if (i === attempts - 1) return last;
    await ctx.sleep(POLL_INTERVAL_MS);
    last = await dispatchApi(ctx.dispatch, `/api/readings/${encodeURIComponent(id)}`);
  }
  return last;
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
        "Fetch one reading's metadata and summary_markdown by id. Includes the public web URL. Does not include the full extracted body — use get_reading_content for that.",
      inputSchema: {
        id: z.string().min(1).describe("Reading id (rd_…)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const out = await dispatchApi(ctx.dispatch, `/api/readings/${encodeURIComponent(args.id)}`);
      if (!out.ok) return apiErrorResult(out);
      const rec = asRecord(out.json) ?? {};
      const publicUrl = publicReadingUrl(ctx.webBaseUrl, args.id);
      return jsonToolResult({
        ...rec,
        public_url: publicUrl,
        public_markdown_link: publicMarkdownLink(readingTitleOf(out.json), publicUrl),
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
        public_url: publicUrl,
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
        "MUTATES the corpus. Import extracted markdown for a source_url (the identity/dedupe key). Prefer this over submit_url when you already have text (X, YouTube transcripts, Reddit). Returns id + status. After a successful import, include the public markdown link in your reply. Optional poll_until_ready waits until ready or failed.",
      inputSchema: {
        source_url: z.string().url().describe("https source URL used for identity/dedupe"),
        markdown: z.string().min(1).describe("Extracted article markdown"),
        title: z.string().min(1).optional().describe("Optional title override"),
        poll_until_ready: z
          .boolean()
          .optional()
          .describe("If true, poll GET /api/readings/:id until ready or failed (bounded)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const out = await dispatchApi(
        ctx.dispatch,
        "/api/readings/import-markdown",
        jsonBody({
          source_url: args.source_url,
          markdown: args.markdown,
          ...(args.title ? { title: args.title } : {}),
          email: false,
        }),
      );
      if (!out.ok) return apiErrorResult(out);
      const id = readingIdOf(out.json);
      if (args.poll_until_ready && id && !isTerminalStatus(readingStatusOf(out.json))) {
        const polled = await pollUntilTerminal(ctx, id);
        if (!polled.ok) return apiErrorResult(polled);
        const publicUrl = publicReadingUrl(ctx.webBaseUrl, id);
        const title = readingTitleOf(polled.json) ?? args.title;
        return jsonToolResult({
          id,
          status: readingStatusOf(polled.json),
          existing: out.status === 200,
          polled: true,
          note: isTerminalStatus(readingStatusOf(polled.json))
            ? undefined
            : "still pending after bounded poll",
          public_url: publicUrl,
          public_markdown_link: publicMarkdownLink(title, publicUrl),
          reading: polled.json,
        });
      }
      return ingestResult(ctx, out.status, out.json, args.title ? { title: args.title } : {});
    },
  );

  server.registerTool(
    "reprocess_reading",
    {
      title: "Reprocess reading",
      description:
        "MUTATES the corpus. Start a fresh processing attempt for an existing reading id. Use when a stub exists and needs to be redone. Optional body matches POST /api/readings/:id/reprocess (force, email, source).",
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
}
