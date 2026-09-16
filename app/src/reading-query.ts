import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { fetchReading } from "./api/readings";
import { expectedLayoutOf, readReadingFromBackend, readingQueryKey, type ReadingResult } from "./reading";
import type { Identity } from "./identity";
import type { QueryRefresh } from "./components/use-status-watch";

// The reading query, isomorphic like identity-query.ts: on the server it reads
// the backend entrypoint with this request's cookie, in the browser it calls
// same-origin /api/readings/:id. Never a Start server function, so the browser
// never reaches a reading through this Worker. The runtime module is imported
// inside the server branch, which the Start compiler removes from the client
// build.

const loadReading = createIsomorphicFn()
  .server(async (_queryClient: QueryClient, id: string, expectedTenant: string | undefined, _signal?: AbortSignal) => {
    const { env } = await import("cloudflare:workers");
    return readReadingFromBackend(env.BACKEND, getRequest(), id, expectedTenant);
  })
  .client((queryClient: QueryClient, id: string, expectedTenant: string | undefined, signal?: AbortSignal) =>
    fetchReading(queryClient, id, expectedTenant, signal),
  );

export function readingQueryOptions(
  queryClient: QueryClient,
  id: string,
  identity: Identity | null | undefined,
  refresh: QueryRefresh<ReadingResult> = {},
) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: readingQueryKey(id),
    // Reading `signal` is what lets Query abort the request when the page
    // unmounts mid-check.
    queryFn: ({ signal }): Promise<ReadingResult> => loadReading(queryClient, id, expectedTenant, signal),
    // The server render's answer is dehydrated into the page, so hydration
    // settles without asking again and client navigation back to a reading
    // reuses it (#370, "not refetched after hydration"). A reading being
    // processed is refreshed on the status contract's bounded schedule instead
    // (#406), through `refresh` on the reading page's observer.
    staleTime: Infinity,
    // An unavailable backend renders the server-error state instead of stalling
    // the server render, as whoami does.
    retry: false,
    ...refresh,
  });
}
