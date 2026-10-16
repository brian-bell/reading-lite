import type { QueryClient } from "@tanstack/react-query";
import { catalogIndexFromResponse, type CatalogIndexResult } from "../catalog";
import { apiFetch } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

export async function fetchCatalogIndex(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
  signal?: AbortSignal,
): Promise<CatalogIndexResult> {
  const response = await apiFetch(queryClient, "/api/readings/terms", {
    headers: expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant },
    ...(signal === undefined ? {} : { signal }),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return catalogIndexFromResponse(response.status, body);
}
