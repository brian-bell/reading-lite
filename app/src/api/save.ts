import type { QueryClient } from "@tanstack/react-query";
import { submitFromResponse, type SubmitOutcome } from "../save";
import { apiFetch } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for saving a URL (#431): same-origin POST /api/readings with
// the session cookie and the CSRF token (ADR 0003), pinned to the account the
// page was rendered for, as the library's reads are. There is no server-render
// path: a save is a write the reader makes, never part of rendering a page.

export async function submitReading(
  queryClient: QueryClient,
  url: string,
  expectedTenant: string | undefined,
): Promise<SubmitOutcome> {
  const response = await apiFetch(queryClient, "/api/readings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant }),
    },
    body: JSON.stringify({ url }),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: submitFromResponse decides from the status.
  }
  return submitFromResponse(response.status, body);
}
