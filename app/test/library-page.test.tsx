import { QueryClientProvider, dehydrate, hydrate } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import { createQueryClient, hrefOnScreen } from "../src/auth/session";
import { AppFrame } from "../src/components/AppFrame";
import { LibraryHome } from "../src/components/LibraryPage";
import { PageHeading } from "../src/components/PageHeading";
import { whoamiQueryKey, type Identity } from "../src/identity";
import { libraryQueryOptions, prefetchLibraryPage } from "../src/library-query";
import { LIBRARY_PAGE_SIZE, libraryParamsOf, validateLibrarySearch } from "../src/library-search";
import type { RouterContext } from "../src/router";
import { plainSearch } from "../src/search";

// The library (#413) and its pages (#414) through the real loader, page, and
// shell, on a route tree shaped like src/routes.
//
// Without the Start compiler an isomorphic function resolves to its server
// branch, so these drive the server-render path: a fake FrontendReads, reached
// through the same query the route's loader uses. The browser path has its own
// test in test/library.test.ts. Rows come from the fixture pack's list index,
// newest first, as the list handler orders them.

const { backend, request } = vi.hoisted(() => ({
  backend: { list: vi.fn(), reading: vi.fn(), whoami: vi.fn() },
  request: { current: new Request("https://app.example/") },
}));

vi.mock("cloudflare:workers", () => ({ env: { BACKEND: backend } }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => request.current }));

const rows = [...pack.list_index.items].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

function backendAnswers(status: number, body: unknown) {
  backend.list.mockImplementation(async () => ({ status, body }));
}

function backendServesPack() {
  backendServesPages(rows);
}

/** Pages of `all` by the offset asked for, as the list handler slices them. */
function backendServesPages(all: readonly { id: string; url: string; status: string }[]) {
  backend.list.mockImplementation(async ({ offset = 0 }: { offset?: number }) => ({
    status: 200,
    body: {
      readings: all.slice(offset, offset + LIBRARY_PAGE_SIZE),
      limit: LIBRARY_PAGE_SIZE,
      offset,
      has_more: offset + LIBRARY_PAGE_SIZE < all.length,
    },
  }));
}

// 45 rows: three pages, the last with five.
const many = Array.from({ length: 45 }, (_, i) => ({
  id: `rd_${String(i + 1).padStart(3, "0")}`,
  url: `https://archive.example/${i + 1}`,
  status: "ready",
  title: `Reading ${i + 1}`,
}));

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <AppFrame theme="system" onThemeChange={() => undefined}>
      <Outlet />
    </AppFrame>
  ),
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: validateLibrarySearch,
  loaderDeps: ({ search }) => libraryParamsOf(search),
  loader: ({ context, deps }) => prefetchLibraryPage(context.queryClient, deps),
  component: function LibraryRoute() {
    return <LibraryHome search={indexRoute.useSearch()} />;
  },
});
const readingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/readings/$id",
  component: function ReadingProbe() {
    const { id } = readingRoute.useParams();
    return <PageHeading>{`Reading ${id}`}</PageHeading>;
  },
});
const routeTree = rootRoute.addChildren([indexRoute, readingRoute]);

function newTab(path: string, identity: Identity | null | undefined = reader) {
  const queryClient = createQueryClient(() => hrefOnScreen(router));
  if (identity !== undefined) queryClient.setQueryData(whoamiQueryKey, identity);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    ...plainSearch,
    history: createMemoryHistory({ initialEntries: [path] }),
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  return { router, queryClient };
}

async function openTab(path: string, identity: Identity | null = reader) {
  const tab = newTab(path, identity);
  render(<RouterProvider router={tab.router} />);
  await waitFor(() => expect(tab.router.state.status).toBe("idle"));
  await screen.findByRole("heading", { level: 1 });
  return tab;
}

function cards(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Readings" })).getAllByRole("listitem");
}

beforeEach(() => {
  backend.list.mockReset();
  request.current = new Request("https://app.example/", { headers: { cookie: "__Host-session=abc" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the first page", () => {
  it("reads the session's first page once, pinned to its account", async () => {
    backendServesPack();
    await openTab("/");

    expect(backend.list).toHaveBeenCalledTimes(1);
    expect(backend.list).toHaveBeenCalledWith({
      cookie: "__Host-session=abc",
      host: "app.example",
      offset: 0,
      expectedTenant: "usr_a",
    });
  });

  it("renders a card per row, in the backend's order, under the Library heading", async () => {
    backendServesPack();
    await openTab("/");

    expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
    const titles = cards().map((card) => within(card).getByRole("heading", { level: 2 }).textContent);
    expect(titles).toEqual(rows.slice(0, 20).map((row) => ("title" in row && row.title) || row.url));
  });

  it("links each title to its reading", async () => {
    backendServesPack();
    await openTab("/");

    for (const [index, card] of cards().entries()) {
      expect(within(card).getByRole("link")).toHaveAttribute("href", `/readings/${rows[index]!.id}`);
    }
  });

  it("names a reading that has no title yet by its URL, with the hostname below", async () => {
    backendAnswers(200, {
      readings: [{ id: "rd_1", url: "https://www.fieldnotes.example/slow", status: "pending" }],
      limit: 20,
      offset: 0,
      has_more: false,
    });
    await openTab("/");

    const [card] = cards();
    expect(within(card!).getByRole("link", { name: "https://www.fieldnotes.example/slow" })).toBeInTheDocument();
    expect(within(card!).getByText("fieldnotes.example")).toBeInTheDocument();
  });

  it("carries a very long title whole", async () => {
    const title = "What we lose when every tool for thinking becomes a place to organize ".repeat(3).trim();
    backendAnswers(200, {
      readings: [{ id: "rd_1", url: "https://example.com/a", status: "ready", title }],
      limit: 20,
      offset: 0,
      has_more: false,
    });
    await openTab("/");

    expect(screen.getByRole("link", { name: title })).toBeInTheDocument();
  });

  it("opens the reading from its card", async () => {
    backendServesPack();
    await openTab("/");

    await userEvent.click(within(cards()[0]!).getByRole("link"));
    expect(await screen.findByRole("heading", { level: 1, name: `Reading ${rows[0]!.id}` })).toBeInTheDocument();
  });
});

describe("what the page says instead of rows", () => {
  it("says the library is empty", async () => {
    backendAnswers(200, { readings: [], limit: 20, offset: 0, has_more: false });
    await openTab("/");
    expect(screen.getByText("No readings yet.")).toBeInTheDocument();
  });

  it("keeps the Library heading and offers Retry when the backend fails", async () => {
    backendAnswers(503, { error: "backend unavailable" });
    await openTab("/");

    expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
    expect(await screen.findByText(/backend unavailable/)).toBeInTheDocument();

    backendServesPack();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(cards()).toHaveLength(Math.min(rows.length, 20)));
  });

  it("says permission was denied", async () => {
    backendAnswers(403, { error: "forbidden" });
    await openTab("/");
    expect(screen.getByText("You don't have access to this.")).toBeInTheDocument();
  });

  it("says the tab is signed in to a different account", async () => {
    backendAnswers(412, { error: "expected tenant mismatch", acting_tenant: "usr_b" });
    await openTab("/");
    expect(screen.getByText(/signed in to a different account/)).toBeInTheDocument();
  });

  it("shows the session-ended page on a 401", async () => {
    backendAnswers(401, { error: "unauthorized" });
    await openTab("/");
    expect(await screen.findByRole("heading", { level: 1, name: "Your session ended." })).toBeInTheDocument();
  });
});

describe("pages", () => {
  function pager() {
    return screen.getByRole("navigation", { name: "Pagination" });
  }

  function titles(): string[] {
    return cards().map((card) => within(card).getByRole("heading", { level: 2 }).textContent ?? "");
  }

  it("offers Next but not Previous on the first page", async () => {
    backendServesPages(many);
    await openTab("/");

    expect(within(pager()).getByText("Page 1")).toBeInTheDocument();
    expect(within(pager()).getByRole("link", { name: "Previous" })).not.toHaveAttribute("href");
    expect(within(pager()).getByRole("link", { name: "Previous" })).toHaveAttribute("aria-disabled", "true");
    expect(within(pager()).getByRole("link", { name: "Next" })).toHaveAttribute("href", "/?offset=20");
  });

  it("offers both on a middle page, the first page written without an offset", async () => {
    backendServesPages(many);
    await openTab("/?offset=20");

    expect(backend.list).toHaveBeenCalledWith(expect.objectContaining({ offset: 20 }));
    expect(titles()[0]).toBe("Reading 21");
    expect(within(pager()).getByText("Page 2")).toBeInTheDocument();
    expect(within(pager()).getByRole("link", { name: "Previous" })).toHaveAttribute("href", "/");
    expect(within(pager()).getByRole("link", { name: "Next" })).toHaveAttribute("href", "/?offset=40");
    // Neither is the page on screen, though `/` matches its path.
    for (const link of within(pager()).getAllByRole("link")) expect(link).not.toHaveAttribute("aria-current");
  });

  it("offers Previous but not Next on the last page", async () => {
    backendServesPages(many);
    await openTab("/?offset=40");

    expect(cards()).toHaveLength(5);
    expect(within(pager()).getByText("Page 3")).toBeInTheDocument();
    expect(within(pager()).getByRole("link", { name: "Previous" })).toHaveAttribute("href", "/?offset=20");
    expect(within(pager()).getByRole("link", { name: "Next" })).not.toHaveAttribute("href");
    expect(within(pager()).getByRole("link", { name: "Next" })).toHaveAttribute("aria-disabled", "true");
  });

  it("shows a one-page library without links either way", async () => {
    backendServesPages(many.slice(0, 3));
    await openTab("/");

    expect(within(pager()).getByText("Page 1")).toBeInTheDocument();
    for (const step of within(pager()).getAllByRole("link")) {
      expect(step).toHaveAttribute("aria-disabled", "true");
      expect(step).not.toHaveAttribute("href");
    }
  });

  it.each([
    ["/?offset=25", 20, "Page 2"],
    ["/?offset=abc", 0, "Page 1"],
    ["/?offset=-20", 0, "Page 1"],
  ])("snaps %s to the page it names, leaving the URL as it was", async (path, offset, page) => {
    backendServesPages(many);
    const { router } = await openTab(path);

    expect(backend.list).toHaveBeenCalledTimes(1);
    expect(backend.list).toHaveBeenCalledWith(expect.objectContaining({ offset }));
    expect(within(pager()).getByText(page)).toBeInTheDocument();
    expect(router.state.location.href).toBe(path);
  });

  it("moves between pages, reading each once and updating the URL", async () => {
    backendServesPages(many);
    const { router } = await openTab("/");

    await userEvent.click(within(pager()).getByRole("link", { name: "Next" }));
    await waitFor(() => expect(titles()[0]).toBe("Reading 21"));
    expect(router.state.location.href).toBe("/?offset=20");
    expect(within(pager()).getByText("Page 2")).toBeInTheDocument();

    await userEvent.click(within(pager()).getByRole("link", { name: "Previous" }));
    await waitFor(() => expect(titles()[0]).toBe("Reading 1"));
    expect(router.state.location.href).toBe("/");
    // Page 1 was already in the cache.
    expect(backend.list.mock.calls.map(([input]) => input.offset)).toEqual([0, 20]);
  });

  it("says a page past the end has nothing, with its number and a way back to the first page", async () => {
    backendServesPages(many);
    const { router } = await openTab("/?offset=100");

    expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
    expect(screen.getByText("No readings on page 6.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Readings" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull();
    expect(screen.queryByText("No readings yet.")).toBeNull();

    expect(screen.getByRole("link", { name: "First page" })).not.toHaveAttribute("aria-current");
    await userEvent.click(screen.getByRole("link", { name: "First page" }));
    await waitFor(() => expect(titles()[0]).toBe("Reading 1"));
    expect(router.state.location.href).toBe("/");
  });

  it("says an empty library is empty, not past its end, on the first page", async () => {
    backendServesPages([]);
    await openTab("/?offset=0");
    expect(screen.getByText("No readings yet.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "First page" })).toBeNull();
  });
});

describe("signed out", () => {
  it("renders the sign-in form in place and never reads a library", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ turnstile_site_key: null })),
    );
    const { router } = await openTab("/", null);

    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    expect(router.state.location.href).toBe("/");
    expect(backend.list).not.toHaveBeenCalled();
  });
});

describe("hydration", () => {
  // What the server render dehydrates into the page is what the browser shows:
  // asking again would waste the request and flash the page.
  it("renders the server's page without reading it a second time", async () => {
    backendServesPack();

    const server = createQueryClient(() => "/");
    server.setQueryData(whoamiQueryKey, reader);
    await prefetchLibraryPage(server, libraryParamsOf({}));
    const dehydrated = JSON.parse(JSON.stringify(dehydrate(server)));
    expect(backend.list).toHaveBeenCalledTimes(1);

    const tab = newTab("/");
    hydrate(tab.queryClient, dehydrated);
    render(<RouterProvider router={tab.router} />);
    await screen.findByRole("heading", { level: 1, name: "Library" });
    await waitFor(() => expect(cards()).toHaveLength(Math.min(rows.length, 20)));

    expect(backend.list).toHaveBeenCalledTimes(1);
  });

  it("keeps two sessions' pages apart in their own caches", async () => {
    backend.list.mockImplementation(async ({ expectedTenant }: { expectedTenant?: string }) => ({
      status: 200,
      body: {
        readings: [{ id: `rd_${expectedTenant}`, url: "https://example.com/a", status: "ready" }],
        limit: 20,
        offset: 0,
        has_more: false,
      },
    }));
    const a = createQueryClient(() => "/");
    const b = createQueryClient(() => "/");
    const readerB = { ...reader, tenant_id: "usr_b", user_id: "usr_b" };
    // Concurrent renders crossing a real binding are smoke/worker.test.ts's
    // evidence; here the point is that the key carries no account and the
    // cache is the request's own.
    await a.prefetchQuery(libraryQueryOptions(a, libraryParamsOf({}), reader));
    await b.prefetchQuery(libraryQueryOptions(b, libraryParamsOf({}), readerB));

    expect(JSON.stringify(dehydrate(a))).toContain("rd_usr_a");
    expect(JSON.stringify(dehydrate(a))).not.toContain("rd_usr_b");
    expect(JSON.stringify(dehydrate(b))).toContain("rd_usr_b");
    expect(JSON.stringify(dehydrate(b))).not.toContain("rd_usr_a");
  });
});
