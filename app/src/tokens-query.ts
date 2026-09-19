import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { fetchTokens } from "./api/tokens";
import type { Identity } from "./identity";
import { expectedLayoutOf } from "./reading";
import { tokensQueryKey, type TokensResult } from "./tokens";

// Browser-only, like the sessions query (sessions-query.ts): never part of the
// server render (ADR 0003, account pages). The key is account-scoped, so
// sign-in and sign-out drop it (src/auth/session.ts).

export function tokensQueryOptions(queryClient: QueryClient, identity: Identity | null | undefined) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: tokensQueryKey(identity?.user_id ?? ""),
    queryFn: (): Promise<TokensResult> => fetchTokens(queryClient, expectedTenant),
    enabled: identity != null,
    staleTime: Infinity,
    retry: false,
  });
}
