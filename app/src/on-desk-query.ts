import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { fetchDesk } from "./api/desk";
import { onDeskQueryKey, type DeskResult, type OnDeskEntry } from "./desk";
import type { Identity } from "./identity";
import { expectedLayoutOf } from "./reading";

// What is on the desk, in position order: what a toggle needs to know the
// desk is full, and what the reading page's session bar counts and names.
// GET /api/desk without `since`, read in the browser by the first observer
// on a page that has none yet; the reading route prefetches it on the server
// for a reading on the desk, passing the isomorphic read as `read`
// (desk-query.ts), and the desk page's own read leaves it too. Each write's
// answer replaces it at once (onDeskAfterWrite). It sits under
// DESK_QUERY_ROOT, which every desk write, a settled attempt and a started
// reprocess invalidate.

export type DeskReader = (
  queryClient: QueryClient,
  since: string | undefined,
  expectedTenant: string | undefined,
  signal?: AbortSignal,
) => Promise<DeskResult>;

export function onDeskQueryOptions(
  queryClient: QueryClient,
  identity: Identity | null | undefined,
  read: DeskReader = fetchDesk,
) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: onDeskQueryKey,
    queryFn: async ({ signal }): Promise<OnDeskEntry[]> => {
      const result = await read(queryClient, undefined, expectedTenant, signal);
      // A refused read leaves the toggles as they would be with no desk; a
      // write says the rest.
      return result.state === "ready" ? onDeskOf(result.value.on_desk) : [];
    },
    enabled: identity != null,
    staleTime: Infinity,
    retry: false,
  });
}

export function onDeskOf(rows: readonly { id: string; title?: string }[]): OnDeskEntry[] {
  return rows.map((row) => (row.title === undefined ? { id: row.id } : { id: row.id, title: row.title }));
}
