import { queryOptions, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { readRefusedBy, type AccountRefusal } from "./account-state";
import { fetchProvider, fetchProviderUsage } from "./api/provider";
import { whoamiQueryKey, type Identity } from "./identity";
import {
  providerQueryKey,
  providerUsageQueryKey,
  type ProviderResult,
  type ProviderSettings,
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

/**
 * A provider write's answer, stored as the read's: new settings, or a refusal
 * the host then shows as a refused read. New settings may move the limit, so
 * today's usage is read again. The one writer of the provider caches.
 */
export function useProviderStore(): {
  saved(settings: ProviderSettings): void;
  refused(refusal: AccountRefusal): void;
} {
  const queryClient = useQueryClient();
  const userId = () => queryClient.getQueryData<Identity | null>(whoamiQueryKey)?.user_id ?? "";
  return {
    saved(settings: ProviderSettings) {
      const id = userId();
      const stored: ProviderResult = { state: "ready", value: settings };
      queryClient.setQueryData<ProviderResult>(providerQueryKey(id), stored);
      void queryClient.invalidateQueries({ queryKey: providerUsageQueryKey(id) });
    },
    refused(refusal: AccountRefusal) {
      queryClient.setQueryData<ProviderResult>(providerQueryKey(userId()), readRefusedBy(refusal));
    },
  };
}
