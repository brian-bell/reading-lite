import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import type { Identity } from "../identity";
import { whoamiQueryOptions } from "../identity-query";
import { clearReturnPath, loginHref, safeReturnPath } from "./return-path";

// Route beforeLoad checks. Identity comes from the request's whoami query:
// cached after the first read, through the backend entrypoint on the server
// and same-origin /api/whoami in the browser. The backend stays authoritative;
// these only decide which page to show.

/** Identity, null when signed out, or undefined when it cannot be determined (never a sign-out). */
async function identityOf(queryClient: QueryClient): Promise<Identity | null | undefined> {
  try {
    return await queryClient.ensureQueryData(whoamiQueryOptions());
  } catch {
    return undefined;
  }
}

/** Signed out: sign in and come back here (acceptance matrix, `/readings/:id`). */
export async function requireSignedIn({
  context,
  location,
}: {
  context: { queryClient: QueryClient };
  location: { href: string };
}): Promise<void> {
  if ((await identityOf(context.queryClient)) === null) {
    throw redirect({ href: loginHref(location.href), replace: true });
  }
}

export interface LoginSearch {
  next?: string;
  step_up?: "1";
}

export function validateLoginSearch(search: Record<string, unknown>): LoginSearch {
  return {
    next: typeof search.next === "string" ? search.next : undefined,
    step_up: search.step_up === "1" ? "1" : undefined,
  };
}

/** Already signed in and not stepping up: go straight to the return path. */
export async function redirectSignedInFromLogin({
  context,
  search,
}: {
  context: { queryClient: QueryClient };
  search: LoginSearch;
}): Promise<void> {
  if (search.step_up) return;
  if (!(await identityOf(context.queryClient))) return;
  // This path is consumed here, so an older stored one must not outlive it.
  clearReturnPath();
  throw redirect({ href: safeReturnPath(search.next) ?? "/", replace: true });
}
