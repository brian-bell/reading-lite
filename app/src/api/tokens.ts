import type { QueryClient } from "@tanstack/react-query";
import {
  tokenCreateFromResponse,
  tokenRevokeFromResponse,
  tokensFromResponse,
  type TokenCreateBody,
  type TokenCreateOutcome,
  type TokenRevokeOutcome,
  type TokensResult,
} from "../tokens";
import { apiFetch, forbiddenOrSwitched } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for API tokens (#340.7): same-origin /api/auth/tokens with the
// session cookie, pinned to the account the page was rendered for, as the
// sessions list is (api/sessions.ts). The token routes are session-only
// (`requireSession`), and a mismatched pin answers 412
// (`requireExpectedTenant` on `/api/auth/tokens…`). Writes send the CSRF
// token, and a write's 403 is read twice for the same reason a session
// revoke's is: CSRF is checked before the tenant pin.

function pin(expectedTenant: string | undefined): HeadersInit {
  return expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant };
}

export async function fetchTokens(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
): Promise<TokensResult> {
  const response = await apiFetch(queryClient, "/api/auth/tokens", { headers: pin(expectedTenant) });
  return tokensFromResponse(response.status, await jsonOrNull(response));
}

export async function createToken(
  queryClient: QueryClient,
  body: TokenCreateBody,
  expectedTenant: string | undefined,
): Promise<TokenCreateOutcome> {
  const response = await apiFetch(queryClient, "/api/auth/tokens", {
    method: "POST",
    headers: { "content-type": "application/json", ...pin(expectedTenant) },
    body: JSON.stringify(body),
  });
  const outcome = tokenCreateFromResponse(response.status, await jsonOrNull(response));
  return outcome.kind === "forbidden" ? forbiddenOrSwitched(queryClient) : outcome;
}

export async function revokeToken(
  queryClient: QueryClient,
  id: string,
  expectedTenant: string | undefined,
): Promise<TokenRevokeOutcome> {
  const response = await apiFetch(queryClient, `/api/auth/tokens/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: pin(expectedTenant),
  });
  const outcome = tokenRevokeFromResponse(response.status, await jsonOrNull(response));
  return outcome.kind === "forbidden" ? forbiddenOrSwitched(queryClient) : outcome;
}

async function jsonOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // Non-JSON: the caller decides from the status.
    return null;
  }
}
