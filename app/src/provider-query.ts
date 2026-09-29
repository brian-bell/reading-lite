import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { fetchProvider, fetchProviderUsage } from "./api/provider";
import type { Identity } from "./identity";
import {
  providerQueryKey,
  providerUsageQueryKey,
  type ProviderResult,
  type ProviderUsageResult,
} from "./provider";
import { expectedLayoutOf } from "./reading";

// Browser-only, like the settings query (settings-query.ts): never part of the
// server render (ADR 0003, account pages). The keys are account-scoped, so
// sign-in and sign-out drop them (src/auth/session.ts). Usage is read on
// every visit and again after a write, since a cached total can be a previous
// day's; there is no timed refresh.

export function providerQueryOptions(queryClient: QueryClient, identity: Identity | null | undefined) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: providerQueryKey(identity?.user_id ?? ""),
    queryFn: (): Promise<ProviderResult> => fetchProvider(queryClient, expectedTenant),
    enabled: identity != null,
    staleTime: Infinity,
    retry: false,
  });
}

export function providerUsageQueryOptions(queryClient: QueryClient, identity: Identity | null | undefined) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: providerUsageQueryKey(identity?.user_id ?? ""),
    queryFn: (): Promise<ProviderUsageResult> => fetchProviderUsage(queryClient, expectedTenant),
    enabled: identity != null,
    staleTime: Infinity,
    refetchOnMount: "always",
    retry: false,
  });
}
