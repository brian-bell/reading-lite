import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { fetchInbox, fetchInboxItem } from "./api/inbox";
import type { Identity } from "./identity";
import { inboxItemQueryKey, inboxQueryKey, type InboxItemResult, type InboxListResult } from "./inbox";
import { expectedLayoutOf } from "./reading";

// Browser-only, like the sessions list (sessions-query.ts): no isomorphic
// server branch and never a loader's prefetch, so the inbox is not part of the
// server render. The keys are account-scoped, so sign-in and sign-out drop
// them (src/auth/session.ts). An item key sits under the list key, so a write
// invalidates the list exactly (inbox-writes.ts) and does not refetch the item.
//
// No timed reads: an agent staging more Markdown shows up the next time the
// page is opened or a write invalidates it (AGENTS.md, no other polling).

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
