import type { QueryClient } from "@tanstack/react-query";
import { accountDeleteFromResponse, DELETE_CONFIRM_PHRASE, type AccountDeleteOutcome } from "../account-delete";
import { apiFetch, forbiddenOrSwitched } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for account deletion (#340.8): same-origin DELETE /api/account
// with the session cookie and CSRF token, pinned to the account the page was
// rendered for. The backend checks the pin after CSRF and before recent auth,
// so a tab showing another account gets 412 rather than a step-up.
//
// A plain 403 is read twice, as a revoke is (api/sessions.ts): another tab
// signing in as someone else fails the CSRF check before the pin can answer.
// The step-up 403 is not re-read; it names this account's own sign-in.

export async function deleteAccount(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
): Promise<AccountDeleteOutcome> {
  const response = await apiFetch(queryClient, "/api/account", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      ...(expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant }),
    },
    body: JSON.stringify({ confirm: DELETE_CONFIRM_PHRASE }),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: accountDeleteFromResponse decides from the status.
  }
  const outcome = accountDeleteFromResponse(response.status, body);
  return outcome.kind === "forbidden" ? forbiddenOrSwitched(queryClient) : outcome;
}
