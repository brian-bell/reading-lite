// Streamable HTTP MCP connector for Cursor / Grok Bot. A dedicated POST /mcp
// route (not the frontend's catch-all) speaks current MCP over JSON. Each request
// builds a fresh stateless McpServer; tools dispatch a synthetic sub-request
// into the same Hono app with the caller's Authorization header so auth,
// scopes, and toHttp stay single-homed. The token is forwarded as a header
// object only — never interpolated into tool results, logs, or error text.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { HTTPException } from "hono/http-exception";
import type { Context, MiddlewareHandler } from "hono";
import type { AppBindings } from "../middleware";
import { registerMcpTools, type McpToolContext } from "./tools";
import type { McpDispatch } from "./dispatch";

export const MCP_SERVER_NAME = "reading-lite";
// 2.0.0: import_markdown stages in the inbox instead of importing
// (reading-lite-gh423), poll_until_ready is gone, and the inbox tools exist.
export const MCP_SERVER_VERSION = "2.0.0";

export interface CreateMcpServerOptions extends McpToolContext {}

export function createMcpServer(opts: CreateMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        "Search and retrieve the reading-lite corpus. list_readings/search_readings return metadata only; fetch bodies with get_reading_content by id. submit_url and reprocess_reading mutate the corpus. import_markdown STAGES markdown in the user's inbox: it is not in the library until a person promotes it, so never present an inbox item as saved or give it a public link. Review staged items with list_inbox and get_inbox_item, and remove one with discard_inbox_item. When a result has public_markdown_link, include it in your reply.",
    },
  );
  registerMcpTools(server, opts);
  return server;
}

function methodNotAllowed(): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    },
    { status: 405, headers: { allow: "POST" } },
  );
}

export function createMcpHandler(
  dispatchFrom: (c: Context<AppBindings>) => McpDispatch,
): MiddlewareHandler<AppBindings> {
  return async (c) => {
    if (c.req.method !== "POST") {
      return methodNotAllowed();
    }

    const dispatch = dispatchFrom(c);
    const server = createMcpServer({
      dispatch,
      webBaseUrl: c.env.WEB_BASE_URL,
    });
    const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      const res = await transport.handleRequest(c);
      return res ?? new Response(null, { status: 204 });
    } catch (err) {
      if (err instanceof HTTPException) {
        return err.getResponse();
      }
      throw err;
    } finally {
      await server.close();
    }
  };
}

export function bindInternalDispatch(app: {
  request: (
    input: string,
    init?: RequestInit,
    env?: AppBindings["Bindings"],
    ctx?: Context<AppBindings>["executionCtx"],
  ) => Promise<Response> | Response;
}): (c: Context<AppBindings>) => McpDispatch {
  return (c) => {
    const authorization = c.req.header("authorization");
    return (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (authorization) headers.set("authorization", authorization);
      return Promise.resolve(app.request(path, { ...init, headers }, c.env, c.executionCtx));
    };
  };
}
