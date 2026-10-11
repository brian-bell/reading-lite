import type { QueryClient } from "@tanstack/react-query";
import { relationshipsFromResponse, type RelationshipsResult } from "../relationships";
import { apiFetch } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for the relationship graph: same-origin
// GET /api/readings/relationships with the session cookie (ADR 0003). The
// Threads pages' server render reads the same endpoint through the backend
// entrypoint, and both map the response with relationshipsFromResponse.

export async function fetchRelationships(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
  signal?: AbortSignal,
): Promise<RelationshipsResult> {
  const response = await apiFetch(queryClient, "/api/readings/relationships", {
    headers: expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant },
    ...(signal === undefined ? {} : { signal }),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: relationshipsFromResponse decides from the status.
  }
  return relationshipsFromResponse(response.status, body);
}
