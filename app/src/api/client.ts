import { onlineManager, type QueryClient } from "@tanstack/react-query";
import { identityFromResponse, whoamiQueryKey, type Identity } from "../identity";
import { ApiError, NetworkError } from "./errors";

// Browser requests (ADR 0003): same-origin /api/* with the session cookie, and
// the CSRF token from /api/whoami on writes. The token is read from the
// caller's QueryClient, never from module state, because this
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
  try {
    return await fetch(new Request(new URL(path, window.location.origin), { ...init, headers, credentials: "include" }));
  } catch (err) {
    // No response at all. The same events TanStack Query pauses on decide
    // whether this was the network being away.
    throw new NetworkError(err, !onlineManager.isOnline());
  }
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

/**
 * What a 403 on a write is: whoever is signed in now — another account,
 * nobody, or still this one. The backend checks the CSRF token before the
 * tenant pin (src/middleware.ts), so when another tab has signed in as someone
 * else the cached token no longer matches the cookie and the answer is 403,
 * never the 412 the pin would have given a read.
 */
export async function forbiddenOrSwitched(
  queryClient: QueryClient,
): Promise<{ kind: "forbidden" } | { kind: "account-changed"; actingTenant?: string }> {
  const previous = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  // Unreadable identity is never a sign-out (identity.ts); the refusal stands.
  const identity = await fetchIdentity().catch(() => undefined);
  if (identity === null) throw new ApiError(401, "session ended");
  if (identity && identity.user_id !== previous?.user_id) {
    return { kind: "account-changed", actingTenant: identity.tenant_id };
  }
  return { kind: "forbidden" };
}
