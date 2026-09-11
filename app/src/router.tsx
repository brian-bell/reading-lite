import { type QueryClient, QueryClientProvider, dehydrate, hydrate } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { createQueryClient, hrefOnScreen } from "./auth/session";
import { routeTree } from "./routeTree.gen";
import { plainSearch } from "./search";

export interface RouterContext {
  queryClient: QueryClient;
}

// Called once per server request and once in the browser, so router state and
// the QueryClient are never shared between requests (ADR 0003, Rendering and
// caching). The dehydrated cache, including whoami's CSRF token, goes only into
// this request's HTML. Query data is API JSON, so the cache travels as a JSON
// string, which the router's serializer accepts and escapes for the page.
// A 401 from any query marks the session ended at the page on screen.
export function getRouter() {
  const queryClient = createQueryClient(() => hrefOnScreen(router));
  const router = createRouter({
    routeTree,
    context: { queryClient },
    ...plainSearch,
    scrollRestoration: true,
    defaultPreload: "intent",
    dehydrate: () => ({ queryClientState: JSON.stringify(dehydrate(queryClient)) }),
    hydrate: (dehydrated: { queryClientState: string }) => {
      hydrate(queryClient, JSON.parse(dehydrated.queryClientState));
    },
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
