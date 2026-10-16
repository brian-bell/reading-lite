import type { QueryClient } from "@tanstack/react-query";
import { KINDS } from "../catalog";
import { libraryFromResponse, type LibraryParams, type LibraryResult } from "../library";
import { apiFetch } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for the library: same-origin GET /api/readings with the session
// cookie (ADR 0003). The server render reads the same endpoint through the
// backend entrypoint, and both map the response with libraryFromResponse.
// Empty filters are omitted and the page size is left to the backend, as the
// entrypoint does.

export async function fetchLibrary(
  queryClient: QueryClient,
  params: LibraryParams,
  expectedTenant: string | undefined,
  signal?: AbortSignal,
): Promise<LibraryResult> {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.tag) query.set("tag", params.tag);
  if (params.facet) query.set(KINDS[params.facet.kind].param, params.facet.term);
  query.set("offset", String(params.offset));
  const response = await apiFetch(queryClient, `/api/readings?${query.toString()}`, {
    headers: expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant },
    ...(signal === undefined ? {} : { signal }),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: libraryFromResponse decides from the status.
  }
  return libraryFromResponse(response.status, body);
}
