import { MutationCache, QueryCache, QueryClient, useQuery } from "@tanstack/react-query";
import { loginOptionsQueryKey, logoutSession } from "../api/auth";
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

/**
 * Holds the href where this tab deleted the account, or null (acceptance
 * matrix, Account closing). Only the tab that sent the delete knows: other
 * tabs see an ordinary 401 or 403, and a reload is an ordinary signed-out tab.
 */
export const accountClosingQueryKey = ["account-closing"] as const;

/** Queries that hold nothing belonging to an account survive a change of identity. */
const ACCOUNT_FREE_QUERIES = new Set<unknown>([
  whoamiQueryKey[0],
  sessionEndedQueryKey[0],
  accountClosingQueryKey[0],
  loginOptionsQueryKey[0],
]);

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

/** The href where this tab deleted the account, or null. */
export function useAccountClosingAt(): string | null {
  return useQuery({
    queryKey: accountClosingQueryKey,
    queryFn: (): string | null => null,
    initialData: null,
    staleTime: Infinity,
  }).data;
}

function forgetAccount(queryClient: QueryClient): void {
  queryClient.removeQueries({ predicate: (query) => !ACCOUNT_FREE_QUERIES.has(query.queryKey[0]) });
  queryClient.setQueryData(sessionEndedQueryKey, null);
  queryClient.setQueryData(accountClosingQueryKey, null);
}

/**
 * The session is already gone (revoked this device, or every session), so
 * drop the account without calling logout. The caller invalidates the router
 * so a guarded page sends the reader to sign in.
 */
export function dropSignedInAccount(queryClient: QueryClient): void {
  forgetAccount(queryClient);
  queryClient.setQueryData(whoamiQueryKey, null);
}

/**
 * DELETE /api/account succeeded: the backend revoked every credential and
 * cleared the cookie. Drop the account's cached data and identity, then show
 * the closing page at `href`. The router is not invalidated: the signed-in
 * guard would replace this page with sign-in, which fails during the grace.
 */
export function closeAccount(queryClient: QueryClient, href: string): void {
  dropSignedInAccount(queryClient);
  queryClient.setQueryData(accountClosingQueryKey, href);
}

export type SignOutResult = "signed-out" | "still-signed-in" | "account-changed";

/**
 * Signs out and drops the account's cached data.
 *
 * A failed logout leaves the session and its cookie alone, so the reader is
 * still signed in and a reload would prove it. Rather than show a signed-out
 * page over a live session, ask the backend who we are: only a session it no
 * longer accepts is forgotten here. (401 from logout is already signed out.)
 *
 * That recovery read can also answer as a different reader: another tab
 * replaces the shared session cookie, this tab's CSRF token no longer matches
 * the session behind it, and logout is refused. The cached data belongs to the
 * account that is gone, so drop it before showing the new identity, as
 * `completeSignIn` does. That is `"account-changed"` rather than a failed
 * sign-out: nothing was revoked, and the tab is no longer the account the
 * reader acted on (acceptance matrix, Account changed) (#384 review).
 */
export async function signOut(queryClient: QueryClient): Promise<SignOutResult> {
  const previous = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  try {
    // Before dropping whoami: logout sends its CSRF token.
    await logoutSession(queryClient);
  } catch {
    const identity = await fetchIdentity().catch(() => undefined);
    // Signed in, or unknown: either way this session is not ours to discard.
    if (identity !== null) {
      if (identity && identity.user_id !== previous?.user_id) {
        forgetAccount(queryClient);
        queryClient.setQueryData(whoamiQueryKey, identity);
        return "account-changed";
      }
      if (identity) queryClient.setQueryData(whoamiQueryKey, identity);
      return "still-signed-in";
    }
  }
  dropSignedInAccount(queryClient);
  return "signed-out";
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
