import type { QueryClient } from "@tanstack/react-query";
import { diagnosticsFromResponse, type DiagnosticsResult } from "../reading-diagnostics";
import { apiFetch } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for the Details section's diagnostics (#373): same-origin GET
// /api/readings/:id/diagnostics with the session cookie, pinned to the account
// the page was rendered for like the reading and the source. There is no
// server path: diagnostics are fetched when Details is opened, never during a
// server render.

export async function fetchDiagnostics(
  queryClient: QueryClient,
  id: string,
  expectedTenant: string | undefined,
): Promise<DiagnosticsResult> {
  const response = await apiFetch(queryClient, `/api/readings/${encodeURIComponent(id)}/diagnostics`, {
    headers: expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: diagnosticsFromResponse decides from the status.
  }
  return diagnosticsFromResponse(response.status, body);
}
