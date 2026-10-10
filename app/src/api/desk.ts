import type { QueryClient } from "@tanstack/react-query";
import { deskWriteFromResponse, type DeskWriteOutcome } from "../desk";
import { apiFetch, forbiddenOrSwitched } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for the desk toggle: same-origin /api/desk with the session
// cookie and CSRF token (ADR 0003), pinned to the account the page was
// rendered for. A 403 is read twice, as a capture's is (api/capture.ts): the
// CSRF check runs before the pin, so a tab another account signed in to gets
// 403, and only whoever is signed in now tells the two apart.

export async function writeDesk(
  queryClient: QueryClient,
  id: string,
  put: boolean,
  expectedTenant: string | undefined,
): Promise<DeskWriteOutcome> {
  const pin: Record<string, string> = expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant };
  const response = await apiFetch(
    queryClient,
    put ? "/api/desk" : `/api/desk/${encodeURIComponent(id)}`,
    put
      ? { method: "POST", headers: { "content-type": "application/json", ...pin }, body: JSON.stringify({ id }) }
      : { method: "DELETE", headers: pin },
  );
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: the mapping decides from the status.
  }
  const outcome = deskWriteFromResponse(response.status, body);
  return outcome.kind === "forbidden" ? forbiddenOrSwitched(queryClient) : outcome;
}
