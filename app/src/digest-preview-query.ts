import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { fetchDigestPreview } from "./api/digest";
import { digestPreviewQueryKey, type DigestPreviewResult } from "./digest-preview";
import type { Identity } from "./identity";
import { expectedLayoutOf } from "./reading";

// Browser-only, like the provider tile's read (provider-query.ts): never part
// of the desk's or /digest's server render. Read again on every visit, since
// the window runs to now and the send time moves on once it passes; a
// settings save and anything that refreshes the desk invalidate it. There is
// no timed refresh.

export function digestPreviewQueryOptions(queryClient: QueryClient, identity: Identity | null | undefined) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: digestPreviewQueryKey,
    queryFn: ({ signal }): Promise<DigestPreviewResult> => fetchDigestPreview(queryClient, expectedTenant, signal),
    enabled: identity != null,
    staleTime: Infinity,
    refetchOnMount: "always",
    retry: false,
  });
}
