import { MutationCache, QueryCache, QueryClient, useQuery } from "@tanstack/react-query";
import { logoutSession } from "../api/auth";
import { fetchIdentity } from "../api/client";
import { isUnauthorized } from "../api/errors";
import { whoamiQueryKey, type Identity } from "../identity";

// Session transitions, all on the caller's request-scoped QueryClient.
//
// Expired session (acceptance matrix, Common states): a 401 from any query or
// mutation marks the session ended at the URL where it happened, and the root
// shows "Your session ended" there. Signed-out identity (whoami's 401) is the
// normal signed-out state, not an error. A 403 is never a sign-out.

/** Holds the href where the session ended, or null. */
export const sessionEndedQueryKey = ["session-ended"] as const;

/** Queries that hold nothing belonging to an account survive a change of identity. */
const ACCOUNT_FREE_QUERIES = new Set<unknown>([whoamiQueryKey[0], sessionEndedQueryKey[0], "login-options"]);

/**
 * The href of the page on screen: the resolved location, not a navigation
 * still pending (while one is, the old page stays up).
 */
export function hrefOnScreen(router: {
  state: { resolvedLocation?: { href: string } };
  latestLocation: { href: string };
}): string {
  return (router.state.resolvedLocation ?? router.latestLocation).href;
}

export function createQueryClient(currentHref: () => string): QueryClient {
  const onError = (error: unknown) => {
    if (isUnauthorized(error)) markSessionEnded(queryClient, currentHref());
  };
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
  });
  return queryClient;
}

export function markSessionEnded(queryClient: QueryClient, href: string): void {
  queryClient.setQueryData(whoamiQueryKey, null);
  queryClient.setQueryData(sessionEndedQueryKey, href);
}

/** The href where the session ended, or null. */
export function useSessionEndedAt(): string | null {
  return useQuery({
    queryKey: sessionEndedQueryKey,
    queryFn: (): string | null => null,
    initialData: null,
    staleTime: Infinity,
  }).data;
}

function forgetAccount(queryClient: QueryClient): void {
  queryClient.removeQueries({ predicate: (query) => !ACCOUNT_FREE_QUERIES.has(query.queryKey[0]) });
  queryClient.setQueryData(sessionEndedQueryKey, null);
}

/** Signs out and drops the account's cached data, whatever logout answers. */
export async function signOut(queryClient: QueryClient): Promise<void> {
  try {
    // Before dropping whoami: logout sends its CSRF token.
    await logoutSession(queryClient);
  } catch {
    // The session may outlive a failed logout; this tab forgets it regardless.
  } finally {
    forgetAccount(queryClient);
    queryClient.setQueryData(whoamiQueryKey, null);
  }
}

/**
 * After redemption: drop the previous account's data and load the new
 * identity. Browser only. Null means the new session is not visible.
 */
export async function completeSignIn(queryClient: QueryClient): Promise<Identity | null> {
  await queryClient.cancelQueries({ queryKey: whoamiQueryKey });
  forgetAccount(queryClient);
  const identity = await fetchIdentity();
  queryClient.setQueryData(whoamiQueryKey, identity);
  return identity;
}
