import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { fetchLibrary } from "./api/library";
import { identityOf } from "./auth/guards";
import {
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
    // Kept for 30 minutes rather than the default five, so a reader coming
    // back from a long read finds the page already rendered and scroll
    // restoration has the full page to scroll (#407). Finite, because nothing
    // else refreshes a page yet: a reader away longer than this gets the page
    // read again, at the cost of landing at the top of it.
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
}

/**
 * Reads the page the URL names (#414) and waits for it, so a server render
 * has it in the HTML. Identity is shared with the root loader's in-flight
 * whoami rather than read twice; signed out or unknown, there is no library
 * to read. prefetchQuery never throws, so an unavailable backend renders its
 * state in the page instead of failing the route.
 */
export async function prefetchLibraryPage(queryClient: QueryClient, params: LibraryParams): Promise<void> {
  const identity = await identityOf(queryClient);
  if (!identity) return;
  await queryClient.prefetchQuery(libraryQueryOptions(queryClient, params, identity));
}

/**
 * The browser's loader: starts the read and lets the page mount at once
 * (#416). Its region is busy until the rows arrive, "Loading…" appears only
 * after 300 ms, and a read that fails, or cannot run offline, renders its
 * state on the new page rather than holding the old one up. useQuery joins
 * the read started here, so it is still one request.
 */
export function startLibraryPage(queryClient: QueryClient, params: LibraryParams): void {
  void prefetchLibraryPage(queryClient, params);
}

/** The library route's loader: wait for the page on the server, start it in the browser. */
export const loadLibraryPage = createIsomorphicFn().server(prefetchLibraryPage).client(startLibraryPage);
