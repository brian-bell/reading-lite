import type { QueryClient } from "@tanstack/react-query";
import { sourceFromResponse, type SourceResult } from "../reading-source";
import { apiFetch } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for the Source view: same-origin GET /api/readings/:id/content
// with the session cookie, pinned to the account the page was rendered for
// like the reading itself. There is no server path: the source is fetched on
// demand, never during a server render (design spec, Source content).

export async function fetchSource(
  queryClient: QueryClient,
  id: string,
  expectedTenant: string | undefined,
): Promise<SourceResult> {
  const response = await apiFetch(queryClient, `/api/readings/${encodeURIComponent(id)}/content`, {
    headers: expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant },
  });
  return sourceFromResponse(response.status, await response.text());
}
