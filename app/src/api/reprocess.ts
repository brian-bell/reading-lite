import type { QueryClient } from "@tanstack/react-query";
import { reprocessFromResponse, type ReprocessOutcome } from "../reprocess";
import { apiFetch, forbiddenOrSwitched } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for Retry and Reprocess (#410): same-origin
// POST /api/readings/:id/reprocess with the session cookie, the CSRF token,
// and the tenant pin, as a save is (api/save.ts). The body is always `{}`: no
// `force`, no `email`, and no Markdown source, which is Import a copy's (#411).

export async function reprocessReading(
  queryClient: QueryClient,
  id: string,
  expectedTenant: string | undefined,
): Promise<ReprocessOutcome> {
  const response = await apiFetch(queryClient, `/api/readings/${encodeURIComponent(id)}/reprocess`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant }),
    },
    body: "{}",
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: reprocessFromResponse decides from the status.
  }
  const outcome = reprocessFromResponse(response.status, body);
  return outcome.kind === "forbidden" ? forbiddenOrSwitched(queryClient) : outcome;
}
