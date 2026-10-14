import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { fetchInbox, fetchInboxItem } from "./api/inbox";
import type { Identity } from "./identity";
import { inboxItemQueryKey, inboxQueryKey, type InboxItemResult, type InboxListResult } from "./inbox";
import { expectedLayoutOf } from "./reading";

export function inboxQueryOptions(queryClient: QueryClient, identity: Identity | null | undefined) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: inboxQueryKey(identity?.user_id ?? ""),
    queryFn: (): Promise<InboxListResult> => fetchInbox(queryClient, expectedTenant),
    enabled: identity != null,
    // Never stale on its own, like every other read here, so focusing the tab
    // asks nothing. Opening the page reads it again all the same: the agent
    // that stages into the inbox is not this tab, so what an earlier visit
    // read is not necessarily what is there now.
    staleTime: Infinity,
    refetchOnMount: "always",
    retry: false,
  });
}

export function inboxItemQueryOptions(queryClient: QueryClient, id: string, identity: Identity | null | undefined) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: inboxItemQueryKey(identity?.user_id ?? "", id),
    queryFn: (): Promise<InboxItemResult> => fetchInboxItem(queryClient, id, expectedTenant),
    enabled: identity != null,
    staleTime: Infinity,
    refetchOnMount: "always",
    retry: false,
  });
}
