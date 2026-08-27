import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorToolResult, mapHttpError } from "./format";

export type McpDispatch = (path: string, init?: RequestInit) => Promise<Response>;

export type ApiOk = { ok: true; status: number; json?: unknown; text?: string };
export type ApiErr = { ok: false; status: number; error: string };
export type ApiResult = ApiOk | ApiErr;

function readErrorField(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
}

export async function dispatchApi(
  dispatch: McpDispatch,
  path: string,
  init: RequestInit = {},
): Promise<ApiResult> {
  const res = await dispatch(path, init);
  const status = res.status;
  const contentType = res.headers.get("content-type") ?? "";
  if (status >= 400) {
    let bodyError: string | undefined;
    if (contentType.includes("application/json")) {
      const body: unknown = await res.json().catch(() => null);
      bodyError = readErrorField(body);
    }
    return { ok: false, status, error: mapHttpError(status, bodyError) };
  }
  if (contentType.includes("application/json")) {
    const json: unknown = await res.json();
    return { ok: true, status, json };
  }
  const text = await res.text();
  return { ok: true, status, text };
}

export function apiErrorResult(err: ApiErr): CallToolResult {
  return errorToolResult(err.status, err.error);
}

export function jsonBody(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
