import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { fetchSource } from "./api/source";
import type { Identity } from "./identity";
import { expectedLayoutOf } from "./reading";
import { sourceQueryKey, type SourceResult } from "./reading-source";

// The source query is browser-only, unlike reading-query.ts: no isomorphic
// server branch and never a loader's prefetch, so the extracted Markdown is
// not part of the server render (design spec, Source content). Its query key
// is account-scoped like the reading's, so sign-in and sign-out drop it
// (src/auth/session.ts).

export function sourceQueryOptions(queryClient: QueryClient, id: string, identity: Identity | null | undefined) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: sourceQueryKey(id),
    queryFn: (): Promise<SourceResult> => fetchSource(queryClient, id, expectedTenant),
    // A captured source does not change under a reading; a reprocess replaces
    // it, and Phase 4's status contract invalidates what a reprocess touches.
    staleTime: Infinity,
    // Failure shows inside the view with its own Retry.
    retry: false,
  });
}
