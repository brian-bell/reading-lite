import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { fetchLibrary } from "./api/library";
import { identityOf } from "./auth/guards";
import {
  FIRST_LIBRARY_PAGE,
  libraryQueryKey,
  readLibraryFromBackend,
  type LibraryParams,
  type LibraryResult,
} from "./library";
import { expectedLayoutOf } from "./reading";
import type { Identity } from "./identity";

// The library query, isomorphic like reading-query.ts: on the server it reads
// the backend entrypoint with this request's cookie, in the browser it calls
// same-origin /api/readings. Never a Start server function. The runtime module
// is imported inside the server branch, which the Start compiler removes from
// the client build.

const loadLibrary = createIsomorphicFn()
  .server(async (_queryClient: QueryClient, params: LibraryParams, expectedTenant: string | undefined) => {
    const { env } = await import("cloudflare:workers");
    return readLibraryFromBackend(env.BACKEND, getRequest(), params, expectedTenant);
  })
  .client((queryClient: QueryClient, params: LibraryParams, expectedTenant: string | undefined) =>
    fetchLibrary(queryClient, params, expectedTenant),
  );

export function libraryQueryOptions(
  queryClient: QueryClient,
  params: LibraryParams,
  identity: Identity | null | undefined,
) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: libraryQueryKey(params),
    queryFn: (): Promise<LibraryResult> => loadLibrary(queryClient, params, expectedTenant),
    // The server render's page is dehydrated, so hydration settles without a
    // second list request (#413). Refreshing after writes and the bounded
    // refresh of active rows are later slices; nothing here refetches on its
    // own.
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * The library route's loader. Identity is shared with the root loader's
 * in-flight whoami rather than read twice; signed out or unknown, there is no
 * library to read. prefetchQuery never throws, so an unavailable backend
 * renders its state in the page instead of failing the route.
 */
export async function prefetchFirstLibraryPage(queryClient: QueryClient): Promise<void> {
  const identity = await identityOf(queryClient);
  if (!identity) return;
  await queryClient.prefetchQuery(libraryQueryOptions(queryClient, FIRST_LIBRARY_PAGE, identity));
}
