import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { fetchRelationships } from "./api/relationships";
import type { Identity } from "./identity";
import { expectedLayoutOf } from "./reading";
import { readRelationshipsFromBackend, relationshipsQueryKey, type RelationshipsResult } from "./relationships";

// The relationship graph query, isomorphic like library-query.ts: on the
// server it reads the backend entrypoint with this request's cookie, in the
// browser it calls same-origin /api/readings/relationships. The Threads
// routes prefetch it in their loaders, so it is part of their server render;
// the reading page only observes it, so there it is read in the browser
// after hydration and the reading's own render stays bounded.

const loadRelationships = createIsomorphicFn()
  .server(async (_queryClient: QueryClient, expectedTenant: string | undefined, _signal?: AbortSignal) => {
    const { env } = await import("cloudflare:workers");
    return readRelationshipsFromBackend(env.BACKEND, getRequest(), expectedTenant);
  })
  .client((queryClient: QueryClient, expectedTenant: string | undefined, signal?: AbortSignal) =>
    fetchRelationships(queryClient, expectedTenant, signal),
  );

export function relationshipsQueryOptions(queryClient: QueryClient, identity: Identity | null | undefined) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: relationshipsQueryKey,
    queryFn: ({ signal }): Promise<RelationshipsResult> => loadRelationships(queryClient, expectedTenant, signal),
    enabled: identity != null,
    // Dehydrated with the Threads pages, so hydration asks nothing again. A
    // finished attempt and a started reprocess invalidate it, as they do the
    // library (ReadingPage.tsx, use-reprocess.ts).
    staleTime: Infinity,
    retry: false,
  });
}
