import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeskInboxSection } from "../src/components/DeskInbox";
import { whoamiQueryKey, type Identity } from "../src/identity";
import type { InboxItemMeta } from "../src/inbox";

const ITEM: InboxItemMeta = {
  id: "in_1",
  url: "https://example.com/note",
  title: "Amber",
  markdown_bytes: 13,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-02T00:00:00.000Z",
};

function identity(): Identity {
  return {
    tenant_id: "usr_a",
    user_id: "usr_a",
    principal: "session",
    tenant_data_plane: true,
    email: "a@example.com",
    csrf_token: "csrf-a",
  };
}

function itemBody(markdown: string) {
  return { ...ITEM, markdown, markdown_bytes: markdown.length };
}

function renderRow() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(whoamiQueryKey, identity());
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: DeskRow,
  });
  const inboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/inbox",
    component: () => <p>All inbox</p>,
  });
  const inboxItemRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/inbox/$id",
    component: () => <p>Inbox item</p>,
  });
  const readingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/readings/$id",
    component: OpenedReading,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, inboxRoute, inboxItemRoute, readingRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function OpenedReading() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return <p>Opened {pathname.split("/").pop()}</p>;
}

function DeskRow() {
  return (
    <DeskInboxSection
      fold={{ kind: "staged", shown: [ITEM], total: 1 }}
      onRetry={() => undefined}
      Section={({ title, children }: { title: string; count?: number; children: ReactNode }) => (
        <section aria-label={title}>
          <ul>{children}</ul>
        </section>
      )}
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubPromote(status: number, body: unknown) {
  let itemReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/api/inbox/in_1") {
        itemReads += 1;
        const markdown = itemReads === 1 ? "Original note" : "Restaged note";
        return new Response(JSON.stringify(itemBody(markdown)), { status: 200 });
      }
      if (request.method === "POST" && path === "/api/inbox/in_1/promote") {
        return new Response(JSON.stringify(body), { status });
      }
      return new Response(JSON.stringify({ items: [ITEM] }), { status: 200 });
    }),
  );
  return {
    reads: () => itemReads,
  };
}

describe("desk inbox writes", () => {
  it("announces a refused add in a status region that was already on the row", async () => {
    stubPromote(429, { limit: "hourly" });
    renderRow();
    expect(await screen.findByText("Original note")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("");
    fireEvent.click(screen.getByRole("button", { name: "Add to library" }));
    expect(await screen.findByRole("status")).toHaveTextContent("You've reached the hourly reading limit.");
  });

  it("reads the item again when a refused add leaves it in the inbox", async () => {
    const fetchLog = stubPromote(429, { limit: "hourly" });
    renderRow();
    expect(await screen.findByText("Original note")).toBeVisible();
    const readsAtClick = fetchLog.reads();
    fireEvent.click(screen.getByRole("button", { name: "Add to library" }));
    expect(await screen.findByText("Restaged note")).toBeVisible();
    expect(fetchLog.reads()).toBe(readsAtClick + 1);
  });

  it("leaves the open preview when the add takes the item out of the inbox", async () => {
    let itemReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === "/api/inbox/in_1") {
          itemReads += 1;
          return new Response(JSON.stringify(itemBody(itemReads === 1 ? "Original note" : "Restaged note")), {
            status: 200,
          });
        }
        if (request.method === "POST" && path === "/api/inbox/in_1/promote") {
          return new Response(JSON.stringify({ id: "rd_new" }), { status: 202 });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }),
    );

    renderRow();
    expect(await screen.findByText("Original note")).toBeVisible();
    const readsAtClick = itemReads;
    fireEvent.click(screen.getByRole("button", { name: "Add to library" }));
    expect(await screen.findByText("Opened rd_new")).toBeVisible();
    expect(itemReads).toBe(readsAtClick);
  });
});
