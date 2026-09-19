import type { QueryClient } from "@tanstack/react-query";
import { tokensFromResponse, type TokensResult } from "../tokens";
import { apiFetch } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for API tokens (#340.7): same-origin /api/auth/tokens with the
// session cookie, pinned to the account the page was rendered for, as the
// sessions list is (api/sessions.ts). The token routes are session-only
// (`requireSession`), and a mismatched pin answers 412
// (`requireExpectedTenant` on `/api/auth/tokens…`).

export async function fetchTokens(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
): Promise<TokensResult> {
  const response = await apiFetch(queryClient, "/api/auth/tokens", {
    headers: expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: tokensFromResponse decides from the status.
  }
  return tokensFromResponse(response.status, body);
}
