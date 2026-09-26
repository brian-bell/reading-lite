import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { fetchLatestExport } from "./api/exports";
import { EXPORT_POLL_MS, exportInProgress, exportsQueryKey, type ExportsResult } from "./archive-export";
import type { Identity } from "./identity";
import { expectedLayoutOf } from "./reading";

// Browser-only, like the tokens query (tokens-query.ts): never part of the
// server render (ADR 0003, account pages). The key is account-scoped, so
// sign-in and sign-out drop it (src/auth/session.ts). It reads again every
// EXPORT_POLL_MS only while an export is queued or building, and stops once
// the backend says it finished either way.

export function exportsQueryOptions(queryClient: QueryClient, identity: Identity | null | undefined) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: exportsQueryKey(identity?.user_id ?? ""),
    queryFn: (): Promise<ExportsResult> => fetchLatestExport(queryClient, expectedTenant),
    enabled: identity != null,
    staleTime: Infinity,
    retry: false,
    refetchInterval: (query) => (exportInProgress(query.state.data) ? EXPORT_POLL_MS : false),
  });
}
