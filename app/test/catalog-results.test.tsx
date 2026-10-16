import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { catalogIndexQueryKey } from "../src/catalog";
import { BackToLibrary } from "../src/components/BackToLibrary";
import { CatalogHome } from "../src/components/CatalogPage";
import { LibraryRows } from "../src/components/LibraryPage";
import { DESK_QUERY_ROOT } from "../src/desk";
import { whoamiQueryKey, type Identity } from "../src/identity";
import { libraryQueryKey, type LibraryResult, type LibraryRow } from "../src/library";
import { relationshipsQueryKey } from "../src/relationships";

const ADA = { facet: { kind: "people" as const, term: "Ada" }, offset: 0 };

function reader(): Identity {
  return {
    tenant_id: "usr_a",
    user_id: "usr_a",
    principal: "session",
    tenant_data_plane: true,
    email: "a@example.com",
    csrf_token: "csrf-a",
  };
}

function row(status: "pending" | "ready"): LibraryRow {
  return {
    id: "rd_pending",
    url: "https://example.com/pending",
    status,
    title: "Still reading",
  };
}

function listed(status: "pending" | "ready"): LibraryResult {
  return {
    state: "ready",
    page: { readings: [row(status)], limit: 20, offset: 0, has_more: false },
  };
}

function clientWith(status: "pending" | "ready"): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(whoamiQueryKey, reader());
  queryClient.setQueryData(libraryQueryKey(ADA), listed(status));
  queryClient.setQueryData(catalogIndexQueryKey, {
    state: "ready",
    value: { people: [], orgs: [], keywords: [], hosts: [] },
  });
  queryClient.setQueryData(relationshipsQueryKey, { state: "ready", value: { readings: [], relationships: [] } });
  queryClient.setQueryData(DESK_QUERY_ROOT, { state: "ready", value: { on_desk: [] } });
  return queryClient;
}

function invalidated(queryClient: QueryClient, queryKey: readonly unknown[]): boolean {
  return queryClient.getQueryCache().find({ queryKey })?.state.isInvalidated === true;
}

function refreshInterval(queryClient: QueryClient): number | false | undefined {
  const query = queryClient.getQueryCache().find({ queryKey: libraryQueryKey(ADA) });
  const refetchInterval = query?.observers[0]?.options.refetchInterval;
  if (typeof refetchInterval !== "function" || query === undefined) return undefined;
  const interval = refetchInterval(query);
  return typeof interval === "number" || interval === false ? interval : undefined;
}

async function renderAt(
  queryClient: QueryClient,
  path: "/catalog" | "/library",
  page: () => ReactNode,
) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const list = createRoute({ getParentRoute: () => root, path, component: page });
  const reading = createRoute({
    getParentRoute: () => root,
    path: "/readings/$id",
    component: () => <BackToLibrary />,
  });
  const router = createRouter({
    routeTree: root.addChildren([list, reading]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("catalog results", () => {
  it("refreshes a processing row on the library schedule and drops the terms index when it settles", async () => {
    const queryClient = clientWith("pending");
    await renderAt(queryClient, "/catalog", () => <CatalogHome search={{ person: "Ada" }} />);
    await screen.findByRole("link", { name: "Still reading" });

    expect(refreshInterval(queryClient)).toBe(15_000);

    queryClient.setQueryData(libraryQueryKey(ADA), listed("ready"));
    await waitFor(() => {
      expect(invalidated(queryClient, catalogIndexQueryKey)).toBe(true);
      expect(invalidated(queryClient, relationshipsQueryKey)).toBe(true);
      expect(invalidated(queryClient, DESK_QUERY_ROOT)).toBe(true);
    });
  });

  it("leaves a settled catalog page alone", async () => {
    const queryClient = clientWith("ready");
    await renderAt(queryClient, "/catalog", () => <CatalogHome search={{ person: "Ada" }} />);
    await screen.findByRole("link", { name: "Still reading" });

    expect(refreshInterval(queryClient)).toBe(false);
    expect(invalidated(queryClient, catalogIndexQueryKey)).toBe(false);
  });

  it("sends a reading opened from the catalog back to the catalog", async () => {
    const user = userEvent.setup();
    const queryClient = clientWith("pending");
    const router = await renderAt(queryClient, "/catalog", () => <CatalogHome search={{ person: "Ada" }} />);
    await user.click(await screen.findByRole("link", { name: "Still reading" }));

    expect(router.state.location.pathname).toBe("/readings/rd_pending");
    await user.click(screen.getByRole("button", { name: "Back to catalog" }));
    expect(router.state.location.pathname).toBe("/catalog");
    expect(screen.getByRole("heading", { level: 2, name: "Ada" })).toBeVisible();
  });

  it("sends a reading opened from the library back to the library", async () => {
    const user = userEvent.setup();
    const queryClient = clientWith("pending");
    const router = await renderAt(queryClient, "/library", () => <LibraryRows rows={[row("pending")]} search={{}} />);
    await user.click(await screen.findByRole("link", { name: "Still reading" }));

    expect(router.state.location.pathname).toBe("/readings/rd_pending");
    await user.click(screen.getByRole("button", { name: "Back to library" }));
    expect(router.state.location.pathname).toBe("/library");
  });
});
