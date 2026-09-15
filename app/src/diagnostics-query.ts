import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { fetchDiagnostics } from "./api/diagnostics";
import type { Identity } from "./identity";
import { expectedLayoutOf } from "./reading";
import { diagnosticsQueryKey, type DiagnosticsResult } from "./reading-diagnostics";

// Browser-only, like the source query (source-query.ts): no isomorphic server
// branch and never a loader's prefetch, so diagnostics are not part of the
// server render and are requested only once Details is opened (#373). The key
// is account-scoped like the reading's, so sign-in and sign-out drop it.

export function diagnosticsQueryOptions(queryClient: QueryClient, id: string, identity: Identity | null | undefined) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: diagnosticsQueryKey(id),
    queryFn: (): Promise<DiagnosticsResult> => fetchDiagnostics(queryClient, id, expectedTenant),
    // Diagnostics change when an attempt runs; Phase 4's status contract
    // invalidates what a reprocess touches, and closing and reopening the
    // section is not a reason to ask again.
    staleTime: Infinity,
    // Failure shows inside the section with its own Retry.
    retry: false,
  });
}
