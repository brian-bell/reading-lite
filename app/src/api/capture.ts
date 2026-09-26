import type { QueryClient } from "@tanstack/react-query";
import { apiFetch, forbiddenOrSwitched } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// The one request behind every capture write: a URL save and a Markdown import
// (api/save.ts), and Retry, Reprocess, and Import a copy (api/reprocess.ts).
// Same-origin POST with the session cookie and the CSRF token (ADR 0003),
// pinned to the account the page was rendered for, as the library's reads
// are. There is no server-render path: a capture is a write the reader makes,
// never part of rendering a page.
//
// A 403 is read twice. The backend checks the CSRF token before the tenant
// pin (src/middleware.ts), so when another tab has signed in as someone else
// the cached token no longer matches the cookie and the answer is 403, never
// the 412 the pin would have given a read. Only whoever is signed in now tells
// a switched account from a real refusal, so the page asks, as signOut does
// for a refused logout (auth/session.ts).

type Forbidden = { kind: "forbidden" };
type ForbiddenOrSwitched = Awaited<ReturnType<typeof forbiddenOrSwitched>>;

/**
 * Posts `payload` as JSON to `path` and reads the answer with `outcomeOf`,
 * which decides from the status when the body is not JSON.
 */
export async function postCapture<Outcome extends { kind: string }>(
  queryClient: QueryClient,
  path: string,
  payload: object,
  expectedTenant: string | undefined,
  outcomeOf: (status: number, body: unknown) => Outcome | Forbidden,
): Promise<Outcome | ForbiddenOrSwitched> {
  const response = await apiFetch(queryClient, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant }),
    },
    body: JSON.stringify(payload),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: outcomeOf decides from the status.
  }
  const outcome = outcomeOf(response.status, body);
  return outcome.kind === "forbidden" ? forbiddenOrSwitched(queryClient) : (outcome as Outcome);
}
