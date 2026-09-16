import type { QueryClient } from "@tanstack/react-query";
import { readingFromResponse, type ReadingResult } from "../reading";
import { apiFetch } from "./client";

// Browser path for reading detail: same-origin GET /api/readings/:id with the
// session cookie (ADR 0003). The server render reads the same endpoint through
// the backend entrypoint, and both map the response with readingFromResponse.

/** The backend's `requireExpectedTenant` pin (src/schemas/api.ts). */
export const EXPECTED_TENANT_HEADER = "x-expected-tenant";

export async function fetchReading(
  queryClient: QueryClient,
  id: string,
  expectedTenant: string | undefined,
  signal?: AbortSignal,
): Promise<ReadingResult> {
  const response = await apiFetch(queryClient, `/api/readings/${encodeURIComponent(id)}`, {
    headers: expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant },
    ...(signal === undefined ? {} : { signal }),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: readingFromResponse decides from the status.
  }
  return readingFromResponse(response.status, body);
}
