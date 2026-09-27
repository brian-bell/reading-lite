import { QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import { expect, vi } from "vitest";
import { AppFrame } from "../src/components/AppFrame";
import { ReadingPage } from "../src/components/ReadingPage";
import { createQueryClient, hrefOnScreen } from "../src/auth/session";
import { whoamiQueryKey, type Identity } from "../src/identity";
import type { Reading } from "../src/reading";
import { readingQueryOptions } from "../src/reading-query";
import type { RouterContext } from "../src/router";
import { plainSearch } from "../src/search";
import { readingViewOf, validateReadingSearch } from "../src/reading-view";

// The reading page mounted on the browser branch of its query, with fake
// timers and a stubbed `fetch`, for the component tests that follow it over
// time: the status refresh contract (reading-refresh.test.tsx) and Retry,
// Reprocess, and Import a copy (reading-reprocess.test.tsx, reading-import.test.tsx).
// Each file mocks the Start runtime to the client branch (start-client-mock.ts)
// and stubs `fetch` its own way; this is the page, its routes, and the clock.

export const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;

export type Answer = () => Response | Promise<Response>;

export const json =
  (body: unknown, status = 200): Answer =>
  () =>
    Response.json(body, { status });

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <AppFrame theme="system" onThemeChange={() => undefined}>
      <Outlet />
    </AppFrame>
  ),
});
const readingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/readings/$id",
  validateSearch: validateReadingSearch,
  loader: ({ context, params }) =>
    context.queryClient.prefetchQuery(readingQueryOptions(context.queryClient, params.id, reader)),
  component: function ReadingRoute() {
    const { id } = readingRoute.useParams();
    return <ReadingPage id={id} view={readingViewOf(readingRoute.useSearch())} />;
  },
});
const leftRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <p>Elsewhere</p> });
const routeTree = rootRoute.addChildren([readingRoute, leftRoute]);

/** Lets promises and zero-delay timers run, `rounds` times, without moving the clock. */
export async function settle(rounds = 1) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

export async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Opens `/readings/:id` (plus `search`) signed in as `reader`, once its heading is on screen. */
export async function openReadingPage(reading: Reading, search = "") {
  const queryClient = createQueryClient(() => hrefOnScreen(router));
  queryClient.setQueryData(whoamiQueryKey, reader);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    ...plainSearch,
    history: createMemoryHistory({ initialEntries: [`/readings/${reading.id}${search}`] }),
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  const view = render(<RouterProvider router={router} />);
  await settle(5);
  expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  return { ...view, queryClient, router };
}

/** Everything the page's polite regions say now. */
export function politeRegion(): string {
  return screen
    .getAllByRole("status")
    .map((region) => region.textContent ?? "")
    .join("");
}
