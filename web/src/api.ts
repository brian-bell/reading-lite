import type {
  ListReadingsResponse,
  Manifest,
  ReadingDiagnostics,
  ReprocessReadingResponse,
  SubmitReadingResponse
} from "./types";

export const tokenStorageKey = "reading-lite.bearerToken";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function authHeaders(token: string): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  const trimmed = token.trim();
  if (trimmed !== "") {
    headers.set("Authorization", `Bearer ${trimmed}`);
  }
  return headers;
}

async function errorMessageOf(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    if (body && typeof body.error === "string" && body.error !== "") return body.error;
  } catch {
    // ignore — non-JSON body
  }
  return fallback;
}

export type ListReadingsParams = {
  limit: number;
  offset: number;
  q?: string;
  tag?: string;
};

export async function listReadings(
  token: string,
  params: ListReadingsParams
): Promise<ListReadingsResponse> {
  const url = new URL("/api/readings", window.location.origin);
  url.searchParams.set("limit", String(params.limit));
  url.searchParams.set("offset", String(params.offset));
  if (params.q && params.q !== "") url.searchParams.set("q", params.q);
  if (params.tag && params.tag !== "") url.searchParams.set("tag", params.tag);

  const response = await fetch(new Request(url, { headers: authHeaders(token) }));
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to list readings"));
  }
  return (await response.json()) as ListReadingsResponse;
}

export async function getReading(token: string, id: string): Promise<Manifest> {
  const url = new URL(`/api/readings/${encodeURIComponent(id)}`, window.location.origin);
  const response = await fetch(new Request(url, { headers: authHeaders(token) }));
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to get reading"));
  }
  return (await response.json()) as Manifest;
}

export async function getReadingDiagnostics(
  token: string,
  id: string
): Promise<ReadingDiagnostics> {
  const url = new URL(`/api/readings/${encodeURIComponent(id)}/diagnostics`, window.location.origin);
  const response = await fetch(new Request(url, { headers: authHeaders(token) }));
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to get diagnostics"));
  }
  return (await response.json()) as ReadingDiagnostics;
}

export type ContentKind = "content" | "content/raw";

export async function fetchContentBlob(
  token: string,
  id: string,
  kind: ContentKind
): Promise<Blob> {
  const url = new URL(`/api/readings/${encodeURIComponent(id)}/${kind}`, window.location.origin);
  const response = await fetch(new Request(url, { headers: authHeaders(token) }));
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to fetch content"));
  }
  return await response.blob();
}

export async function submitReading(
  token: string,
  url: string
): Promise<SubmitReadingResponse | Manifest> {
  const target = new URL("/api/readings", window.location.origin);
  const response = await fetch(
    new Request(target, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ url })
    })
  );
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to submit reading"));
  }
  return (await response.json()) as SubmitReadingResponse | Manifest;
}

export async function reprocessReading(
  token: string,
  id: string
): Promise<ReprocessReadingResponse> {
  const target = new URL(`/api/readings/${encodeURIComponent(id)}/reprocess`, window.location.origin);
  const response = await fetch(
    new Request(target, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({})
    })
  );
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to reprocess reading"));
  }
  return (await response.json()) as ReprocessReadingResponse;
}
