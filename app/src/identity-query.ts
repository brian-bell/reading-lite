import { queryOptions } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { fetchIdentity } from "./api/client";
import { readWhoamiFromBackend, whoamiQueryKey } from "./identity";

// On the server the query reads the backend entrypoint with this request's
// cookie; in the browser it calls same-origin /api/whoami. It is never a Start
// server function, so the browser never reaches identity through this Worker.
// The runtime module is imported inside the server branch, which the Start
// compiler removes from the client build.
const loadIdentity = createIsomorphicFn()
  .server(async (_signal?: AbortSignal) => {
    const { env } = await import("cloudflare:workers");
    return readWhoamiFromBackend(env.BACKEND, getRequest());
  })
  .client((signal?: AbortSignal) => fetchIdentity(signal));

export function whoamiQueryOptions() {
  return queryOptions({
    queryKey: whoamiQueryKey,
    queryFn: ({ signal }) => loadIdentity(signal),
    // As the legacy SPA: identity changes only through sign-in and sign-out,
    // which invalidate it. No retry, so an unavailable backend never stalls a
    // server render.
    staleTime: Infinity,
    retry: false,
  });
}
