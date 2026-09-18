import type { QueryClient } from "@tanstack/react-query";
import { emailChangeFromResponse, type EmailChangeOutcome } from "../email-change";
import { apiFetch, forbiddenOrSwitched } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for POST /api/auth/email-change (#340.6.2), with CSRF and the
// tenant pin like the account page's other writes. A 403 is read twice, as a
// revoke's is: CSRF is checked before the pin, so another tab signing in as
// someone else answers 403. When the same reader is still signed in, the 403
// is the recent-auth gate and the answer is a fresh sign-in; when nobody is,
// forbiddenOrSwitched throws the 401 the shell shows as a session that ended.

export async function requestEmailChange(
  queryClient: QueryClient,
  email: string,
  expectedTenant: string | undefined,
): Promise<EmailChangeOutcome> {
  const response = await apiFetch(queryClient, "/api/auth/email-change", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant }),
    },
    body: JSON.stringify({ email }),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: the status decides.
  }
  const outcome = emailChangeFromResponse(response.status, body);
  if (outcome.kind !== "step-up" || response.status !== 403) return outcome;
  const who = await forbiddenOrSwitched(queryClient);
  return who.kind === "account-changed" ? who : outcome;
}
