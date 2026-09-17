import type { QueryClient } from "@tanstack/react-query";
import { revokeFromResponse, sessionsFromResponse, type RevokeOutcome, type SessionsResult } from "../sessions";
import { apiFetch, forbiddenOrSwitched } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for session management (#340.1): same-origin /api/auth/sessions
// with the session cookie (ADR 0003), pinned to the account the page was
// rendered for like the library's reads. Writes send the CSRF token. There is
// no server-render path: account pages load this in the browser (ADR 0003).
//
// A 403 on a write is read twice, as a save is (api/save.ts): the backend
// checks the CSRF token before the tenant pin, so another tab signing in as
// someone else answers 403, never the 412 a pinned read would give. The
// sessions list (and a write whose CSRF already passed) now 412s the same
// way readings do (`requireExpectedTenant` on `/api/auth/sessions…`).

function pin(expectedTenant: string | undefined): HeadersInit {
  return expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant };
}

export async function fetchSessions(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
): Promise<SessionsResult> {
  const response = await apiFetch(queryClient, "/api/auth/sessions", { headers: pin(expectedTenant) });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: sessionsFromResponse decides from the status.
  }
  return sessionsFromResponse(response.status, body);
}

export async function revokeSession(
  queryClient: QueryClient,
  id: string,
  expectedTenant: string | undefined,
): Promise<RevokeOutcome> {
  const response = await apiFetch(queryClient, `/api/auth/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: pin(expectedTenant),
  });
  return revokeWriteFrom(queryClient, response, "failed to revoke session");
}

export async function revokeAllSessions(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
): Promise<RevokeOutcome> {
  const response = await apiFetch(queryClient, "/api/auth/sessions/revoke-all", {
    method: "POST",
    headers: { "content-type": "application/json", ...pin(expectedTenant) },
    body: JSON.stringify({}),
  });
  return revokeWriteFrom(queryClient, response, "failed to revoke sessions");
}

async function revokeWriteFrom(
  queryClient: QueryClient,
  response: Response,
  fallback: string,
): Promise<RevokeOutcome> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: revokeFromResponse decides from the status.
  }
  const outcome = revokeFromResponse(response.status, body, fallback);
  return outcome.kind === "forbidden" ? forbiddenOrSwitched(queryClient) : outcome;
}
