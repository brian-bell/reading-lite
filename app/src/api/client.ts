import type { QueryClient } from "@tanstack/react-query";
import { identityFromResponse, whoamiQueryKey, type Identity } from "../identity";

// Browser requests (ADR 0003): same-origin /api/* with the session cookie, and
// the CSRF token from /api/whoami on writes, as web/src/api.ts does. The token
// is read from the caller's QueryClient, never from module state, because this
// module is also loaded during server renders.

export const CSRF_HEADER = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export async function apiFetch(queryClient: QueryClient, path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith("/api/")) {
    throw new Error(`apiFetch only calls same-origin /api/* paths, not ${path}`);
  }
  const headers = new Headers(init.headers);
  if (!SAFE_METHODS.has((init.method ?? "GET").toUpperCase())) {
    const token = queryClient.getQueryData<Identity | null>(whoamiQueryKey)?.csrf_token;
    if (token) headers.set(CSRF_HEADER, token);
  }
  return fetch(new Request(new URL(path, window.location.origin), { ...init, headers, credentials: "include" }));
}

/** Browser path for the whoami query. */
export async function fetchIdentity(): Promise<Identity | null> {
  const response = await fetch(
    new Request(new URL("/api/whoami", window.location.origin), { credentials: "include" }),
  );
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: identityFromResponse decides from the status.
  }
  return identityFromResponse(response.status, body);
}
