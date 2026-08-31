import type {
  ListReadingsResponse,
  Manifest,
  ReadingDiagnostics,
  ReprocessReadingBody,
  ReprocessReadingResponse,
  SubmitReadingResponse,
  WhoamiResponse,
  ListSessionsResponse
} from "./types";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const CSRF_HEADER = "x-csrf-token";
let csrfToken: string | undefined;
let whoamiGeneration = 0;

function rememberCsrfToken(token: string | undefined): void {
  csrfToken = token && token !== "" ? token : undefined;
}

function rememberWhoamiCsrf(token: string | undefined, generation: number): void {
  if (generation !== whoamiGeneration) return;
  rememberCsrfToken(token);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new DOMException("The operation was aborted.", "AbortError");
}

function jsonHeaders(extra?: Record<string, string>): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (extra) {
    for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  }
  return headers;
}

function mutationHeaders(extra?: Record<string, string>): Headers {
  const headers = jsonHeaders(extra);
  if (csrfToken) headers.set(CSRF_HEADER, csrfToken);
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

async function apiFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(new Request(input, { ...init, credentials: "include" }));
}

export async function getWhoami(context?: { signal?: AbortSignal }): Promise<WhoamiResponse | null> {
  const generation = ++whoamiGeneration;
  const signal = context?.signal;
  const response = await apiFetch(new URL("/api/whoami", window.location.origin), { signal });
  throwIfAborted(signal);
  if (response.status === 401 || response.status === 403) {
    rememberWhoamiCsrf(undefined, generation);
    return null;
  }
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to load identity"));
  }
  const body = (await response.json()) as WhoamiResponse;
  throwIfAborted(signal);
  rememberWhoamiCsrf(body.csrf_token, generation);
  return body;
}

export async function requestLoginLink(email: string): Promise<void> {
  const response = await apiFetch(new URL("/api/auth/challenge", window.location.origin), {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email })
  });
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to request sign-in link"));
  }
}

export async function redeemLoginLink(credential: string, redemptionId: string): Promise<WhoamiResponse> {
  const response = await apiFetch(new URL("/api/auth/redeem", window.location.origin), {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ credential, redemption_id: redemptionId })
  });
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to complete sign-in"));
  }
  return (await response.json()) as WhoamiResponse;
}

export async function logoutSession(): Promise<void> {
  const response = await apiFetch(new URL("/api/auth/logout", window.location.origin), {
    method: "POST",
    headers: mutationHeaders(),
    body: JSON.stringify({})
  });
  // 401: session already gone; Worker still expires the host-only cookie.
  if (response.status === 401) {
    rememberCsrfToken(undefined);
    return;
  }
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to log out"));
  }
  rememberCsrfToken(undefined);
}

export async function listSessions(): Promise<ListSessionsResponse> {
  const response = await apiFetch(new URL("/api/auth/sessions", window.location.origin));
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to list sessions"));
  }
  return (await response.json()) as ListSessionsResponse;
}

export async function revokeSession(id: string): Promise<void> {
  const response = await apiFetch(new URL(`/api/auth/sessions/${encodeURIComponent(id)}`, window.location.origin), {
    method: "DELETE",
    headers: mutationHeaders()
  });
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to revoke session"));
  }
}

export async function revokeAllSessions(): Promise<void> {
  const response = await apiFetch(new URL("/api/auth/sessions/revoke-all", window.location.origin), {
    method: "POST",
    headers: mutationHeaders(),
    body: JSON.stringify({})
  });
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to revoke sessions"));
  }
  rememberCsrfToken(undefined);
}

export async function requestEmailChange(email: string): Promise<void> {
  const response = await apiFetch(new URL("/api/auth/email-change", window.location.origin), {
    method: "POST",
    headers: mutationHeaders(),
    body: JSON.stringify({ email })
  });
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to request email change"));
  }
}

export type ListReadingsParams = {
  limit: number;
  offset: number;
  q?: string;
  tag?: string;
};

export async function listReadings(params: ListReadingsParams): Promise<ListReadingsResponse> {
  const url = new URL("/api/readings", window.location.origin);
  url.searchParams.set("limit", String(params.limit));
  url.searchParams.set("offset", String(params.offset));
  if (params.q && params.q !== "") url.searchParams.set("q", params.q);
  if (params.tag && params.tag !== "") url.searchParams.set("tag", params.tag);

  const response = await apiFetch(url);
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to list readings"));
  }
  return (await response.json()) as ListReadingsResponse;
}

export async function getReading(id: string): Promise<Manifest> {
  const url = new URL(`/api/readings/${encodeURIComponent(id)}`, window.location.origin);
  const response = await apiFetch(url);
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to get reading"));
  }
  return (await response.json()) as Manifest;
}

export async function getReadingDiagnostics(id: string): Promise<ReadingDiagnostics> {
  const url = new URL(`/api/readings/${encodeURIComponent(id)}/diagnostics`, window.location.origin);
  const response = await apiFetch(url);
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to get diagnostics"));
  }
  return (await response.json()) as ReadingDiagnostics;
}

export type ContentKind = "content" | "content/raw";

export async function fetchContentBlob(id: string, kind: ContentKind): Promise<Blob> {
  const url = new URL(`/api/readings/${encodeURIComponent(id)}/${kind}`, window.location.origin);
  const response = await apiFetch(url);
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to fetch content"));
  }
  return await response.blob();
}

export async function submitReading(url: string): Promise<SubmitReadingResponse | Manifest> {
  const target = new URL("/api/readings", window.location.origin);
  const response = await apiFetch(target, {
    method: "POST",
    headers: mutationHeaders(),
    body: JSON.stringify({ url })
  });
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to submit reading"));
  }
  return (await response.json()) as SubmitReadingResponse | Manifest;
}

export async function reprocessReading(
  id: string,
  body: ReprocessReadingBody = {}
): Promise<ReprocessReadingResponse> {
  const target = new URL(`/api/readings/${encodeURIComponent(id)}/reprocess`, window.location.origin);
  const response = await apiFetch(target, {
    method: "POST",
    headers: mutationHeaders(),
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessageOf(response, "failed to reprocess reading"));
  }
  return (await response.json()) as ReprocessReadingResponse;
}
