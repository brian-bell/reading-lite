import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie, getRequest } from "@tanstack/react-start/server";
import { fetchDesk } from "./api/desk";
import { identityOf } from "./auth/guards";
import type { QueryRefresh } from "./components/use-status-watch";
import {
  VISIT_COOKIE,
  deskHomeQueryKey,
  onDeskQueryKey,
  readDeskFromBackend,
  readVisitFromCookieHeader,
  visitAt,
  type DeskResult,
  type VisitAt,
} from "./desk";
import { needsProviderKey, type Identity } from "./identity";
import { libraryQueryOptions } from "./library-query";
import { FIRST_LIBRARY_PAGE, needsLibraryRead } from "./onboarding";
import { onDeskOf, onDeskQueryOptions } from "./on-desk-query";
import { expectedLayoutOf } from "./reading";

// The desk's reads for the server render, isomorphic like library-query.ts:
// on the server through the backend entrypoint with this request's cookie, in
// the browser through same-origin /api/desk.
//
// - The desk page's read is the whole GET /api/desk for this visit,
//   prefetched by the `/` loader, and it leaves what is on the desk for the
//   toggles and the session bar (on-desk-query.ts). A keyless reader also
//   prefetches the library's first page, which says whether the library is
//   empty (onboarding.ts).
// - `prefetchOnDesk` is that on-desk query for the reading route, whose
//   session bar is part of the reading's server render.
//
// Both sit under DESK_QUERY_ROOT, which every desk write, a settled attempt
// and a started reprocess invalidate.

const loadDesk = createIsomorphicFn()
  .server(
    async (_queryClient: QueryClient, since: string | undefined, expectedTenant: string | undefined, _signal?: AbortSignal) => {
      const { env } = await import("cloudflare:workers");
      return readDeskFromBackend(env.BACKEND, getRequest(), since, expectedTenant);
    },
  )
  .client((queryClient: QueryClient, since: string | undefined, expectedTenant: string | undefined, signal?: AbortSignal) =>
    fetchDesk(queryClient, since, expectedTenant, signal),
  );

export function deskQueryOptions(
  queryClient: QueryClient,
  visit: VisitAt,
  identity: Identity | null | undefined,
  refresh: QueryRefresh<DeskResult> = {},
) {
  const expectedTenant = expectedLayoutOf(identity);
  const since = new Date(visit.since).toISOString();
  return queryOptions({
    queryKey: deskHomeQueryKey(visit.next.previous),
    queryFn: async ({ signal }): Promise<DeskResult> => {
      const result = await loadDesk(queryClient, since, expectedTenant, signal);
      if (result.state === "ready") queryClient.setQueryData(onDeskQueryKey, onDeskOf(result.value.on_desk));
      return result;
    },
    enabled: identity != null,
    // Dehydrated with the server render. Writes, a settled attempt and a
    // reprocess invalidate it; while a reading on it is processing it is
    // refreshed on the library's bounded schedule, through `refresh`.
    staleTime: Infinity,
    retry: false,
    ...refresh,
  });
}

/** The reading route's loader, for a reading on the desk: what is on it, waited for on the server. */
export function prefetchOnDesk(queryClient: QueryClient, identity: Identity | null | undefined): Promise<void> {
  return queryClient.prefetchQuery(onDeskQueryOptions(queryClient, identity, loadDesk));
}

/** The `rl_visit` cookie as this request or document carries it. */
const visitCookie = createIsomorphicFn()
  .server(() => getCookie(VISIT_COOKIE))
  .client(() => readVisitFromCookieHeader(document.cookie));

/** What `/` reads for a signed-in reader: the desk, and the library's first page while the steps could be shown. */
function deskPageReads(queryClient: QueryClient, visit: VisitAt, identity: Identity): Promise<void>[] {
  const reads = [queryClient.prefetchQuery(deskQueryOptions(queryClient, visit, identity))];
  if (needsLibraryRead({ keyNeeded: needsProviderKey(identity), opened: false })) {
    reads.push(queryClient.prefetchQuery(libraryQueryOptions(queryClient, FIRST_LIBRARY_PAGE, identity)));
  }
  return reads;
}

async function prefetchDeskPage(queryClient: QueryClient): Promise<VisitAt> {
  const visit = visitAt(visitCookie(), Date.now());
  const identity = await identityOf(queryClient);
  if (identity) await Promise.all(deskPageReads(queryClient, visit, identity));
  return visit;
}

function startDeskPage(queryClient: QueryClient): VisitAt {
  const visit = visitAt(visitCookie(), Date.now());
  void identityOf(queryClient).then((identity) => {
    if (!identity) return;
    for (const read of deskPageReads(queryClient, visit, identity)) void read;
  });
  return visit;
}

/**
 * The `/` loader: the visit, and the desk read waited for on the server and
 * started in the browser, so a client navigation mounts the page at once.
 */
export const loadDeskPage = createIsomorphicFn().server(prefetchDeskPage).client(startDeskPage);
