import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { fetchCatalogIndex } from "./api/catalog";
import { identityOf } from "./auth/guards";
import {
  catalogIndexQueryKey,
  catalogListParams,
  readCatalogIndexFromBackend,
  type CatalogIndexResult,
  type CatalogView,
} from "./catalog";
import type { Identity } from "./identity";
import { libraryQueryOptions } from "./library-query";
import { expectedLayoutOf } from "./reading";

const loadCatalogIndex = createIsomorphicFn()
  .server(async (_queryClient: QueryClient, expectedTenant: string | undefined, _signal?: AbortSignal) => {
    const { env } = await import("cloudflare:workers");
    return readCatalogIndexFromBackend(env.BACKEND, getRequest(), expectedTenant);
  })
  .client((queryClient: QueryClient, expectedTenant: string | undefined, signal?: AbortSignal) =>
    fetchCatalogIndex(queryClient, expectedTenant, signal),
  );

export function catalogIndexQueryOptions(queryClient: QueryClient, identity: Identity | null | undefined) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: catalogIndexQueryKey,
    queryFn: ({ signal }): Promise<CatalogIndexResult> => loadCatalogIndex(queryClient, expectedTenant, signal),
    enabled: identity != null,
    staleTime: Infinity,
    retry: false,
  });
}

export async function prefetchCatalogPage(queryClient: QueryClient, view: CatalogView): Promise<void> {
  const identity = await identityOf(queryClient);
  if (!identity) return;
  if (view.mode === "index") {
    await queryClient.prefetchQuery(catalogIndexQueryOptions(queryClient, identity));
    return;
  }
  await queryClient.prefetchQuery(libraryQueryOptions(queryClient, catalogListParams(view), identity));
}

function startCatalogPage(queryClient: QueryClient, view: CatalogView): void {
  void prefetchCatalogPage(queryClient, view);
}

export const loadCatalogPage = createIsomorphicFn().server(prefetchCatalogPage).client(startCatalogPage);
