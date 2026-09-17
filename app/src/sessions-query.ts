import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { fetchSessions } from "./api/sessions";
import type { Identity } from "./identity";
import { expectedLayoutOf } from "./reading";
import { sessionsQueryKey, type SessionsResult } from "./sessions";

// Browser-only, like the source query (source-query.ts): no isomorphic server
// branch and never a loader's prefetch, so the sessions list is not part of
// the server render (ADR 0003, account pages). The key is account-scoped, so
// sign-in and sign-out drop it (src/auth/session.ts).

export function sessionsQueryOptions(
  queryClient: QueryClient,
  identity: Identity | null | undefined,
) {
  const expectedTenant = expectedLayoutOf(identity);
  const userId = identity?.user_id ?? "";
  return queryOptions({
    queryKey: sessionsQueryKey(userId),
    queryFn: (): Promise<SessionsResult> => fetchSessions(queryClient, expectedTenant),
    enabled: identity != null,
    staleTime: Infinity,
    retry: false,
  });
}
