import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { fetchSettings } from "./api/settings";
import type { Identity } from "./identity";
import { expectedLayoutOf } from "./reading";
import { settingsQueryKey, type SettingsResult } from "./settings";

// Browser-only, like the sessions query (sessions-query.ts): never part of the
// server render (ADR 0003, account pages). The key is account-scoped, so
// sign-in and sign-out drop it (src/auth/session.ts).

export function settingsQueryOptions(queryClient: QueryClient, identity: Identity | null | undefined) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: settingsQueryKey(identity?.user_id ?? ""),
    queryFn: (): Promise<SettingsResult> => fetchSettings(queryClient, expectedTenant),
    enabled: identity != null,
    staleTime: Infinity,
    retry: false,
  });
}
