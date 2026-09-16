import { QueryClientProvider, dehydrate, hydrate, onlineManager } from "@tanstack/react-query";
import {
  type AnyRoute,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import { createQueryClient, hrefOnScreen } from "../src/auth/session";
import { AppFrame } from "../src/components/AppFrame";
import { LibraryHome } from "../src/components/LibraryPage";
import { PageHeading } from "../src/components/PageHeading";
import { whoamiQueryKey, type Identity } from "../src/identity";
import { DelayedText } from "../src/components/ReadingStates";
import { libraryQueryKey } from "../src/library";
import { libraryQueryOptions, prefetchLibraryPage, startLibraryPage } from "../src/library-query";
import { LIBRARY_PAGE_SIZE, libraryParamsOf, validateLibrarySearch } from "../src/library-search";
import { libraryPage } from "../e2e/library-page.js";
import { currentLoadId } from "../src/reading-trail";
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
//
// The route tree waits for the page in its loader, as the server does. The
// browser's loader only starts the read (#416), so the states a page change
// shows while the read is still out — loading, offline — are driven through a
// second tree with that loader.

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

/** The pack's rows filtered and paged as the list handler does (e2e/library-page.js). */
function backendServesFilteredPack() {
  backend.list.mockImplementation(async ({ q, tag, offset }: { q?: string; tag?: string; offset?: number }) => ({
    status: 200,
    body: libraryPage(pack.list_index.items, { q, tag, offset }),
  }));
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

// The same pages behind the browser's loader, which starts the read and lets
// the page mount at once.
const browserRootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <AppFrame theme="system" onThemeChange={() => undefined}>
      <Outlet />
    </AppFrame>
  ),
});
const browserIndexRoute = createRoute({
  getParentRoute: () => browserRootRoute,
  path: "/",
  validateSearch: validateLibrarySearch,
  loaderDeps: ({ search }) => libraryParamsOf(search),
  loader: ({ context, deps }) => startLibraryPage(context.queryClient, deps),
  component: function LibraryRoute() {
    return <LibraryHome search={browserIndexRoute.useSearch()} />;
  },
});
const browserReadingRoute = createRoute({
  getParentRoute: () => browserRootRoute,
  path: "/readings/$id",
  component: function ReadingProbe() {
    const { id } = browserReadingRoute.useParams();
    return <PageHeading>{`Reading ${id}`}</PageHeading>;
  },
});
const browserRouteTree = browserRootRoute.addChildren([browserIndexRoute, browserReadingRoute]);

function newTab(path: string, identity: Identity | null | undefined = reader, tree: AnyRoute = routeTree) {
  const queryClient = createQueryClient(() => hrefOnScreen(router));
  if (identity !== undefined) queryClient.setQueryData(whoamiQueryKey, identity);
  const router = createRouter({
    routeTree: tree,
    context: { queryClient },
    ...plainSearch,
    history: createMemoryHistory({ initialEntries: [path] }),
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  return { router, queryClient };
}

async function openTab(path: string, identity: Identity | null = reader, tree: AnyRoute = routeTree) {
  const tab = newTab(path, identity, tree);
  render(<RouterProvider router={tab.router} />);
  await waitFor(() => expect(tab.router.state.status).toBe("idle"));
  await screen.findByRole("heading", { level: 1 });
  return tab;
}

/** A tab whose loader starts the read without waiting, as the browser's does. */
function openBrowserTab(path: string) {
  return openTab(path, reader, browserRouteTree);
}

async function pressNext(): Promise<void> {
  const pager = await screen.findByRole("navigation", { name: "Pagination" });
  const next = within(pager).getByRole("link", { name: "Next" });
  next.focus();
  await userEvent.keyboard("{Enter}");
}

/** Page 1 from `all`, and whatever `later` answers for any other offset. */
function backendServesFirstPageThen(all: readonly (typeof many)[number][], later: () => Promise<{ status: number; body: unknown }>) {
  backend.list.mockImplementation(async ({ offset = 0 }: { offset?: number }) =>
    offset === 0
      ? { status: 200, body: { readings: all.slice(0, LIBRARY_PAGE_SIZE), limit: LIBRARY_PAGE_SIZE, offset: 0, has_more: true } }
      : later(),
  );
}

function heading(): string {
  return screen.getByRole("heading", { level: 1 }).textContent ?? "";
}

async function headingSettles(text: string): Promise<void> {
  await waitFor(() => expect(heading()).toBe(text));
}

async function clickNext(): Promise<void> {
  const pager = await screen.findByRole("navigation", { name: "Pagination" });
  await userEvent.click(within(pager).getByRole("link", { name: "Next" }));
}

function cards(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Readings" })).getAllByRole("listitem");
}

function titleLink(card: HTMLElement): HTMLElement {
  return within(within(card).getByRole("heading", { level: 2 })).getByRole("link");
}

beforeEach(() => {
  backend.list.mockReset();
  request.current = new Request("https://app.example/", { headers: { cookie: "__Host-session=abc" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  onlineManager.setOnline(true);
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
      expect(titleLink(card)).toHaveAttribute("href", `/readings/${rows[index]!.id}`);
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

  // Badges (#415): text only, so the card keeps its one link.
  it("badges a pending row as processing, and a failed row with its failure's headline", async () => {
    backendAnswers(200, {
      readings: [
        { id: "rd_p", url: "https://fieldnotes.example/slow", status: "pending" },
        {
          id: "rd_f",
          url: "https://wall.example/report",
          status: "failed",
          error: { code: "BadStatusError", message: "bad response status 403", stage: "fetch_source" },
        },
      ],
      limit: 20,
      offset: 0,
      has_more: false,
    });
    await openTab("/");

    const [pending, failed] = cards();
    expect(within(pending!).getByText("Processing")).toBeInTheDocument();
    expect(within(failed!).getByText("Failed")).toBeInTheDocument();
    expect(within(failed!).getByText("The page couldn't be fetched.")).toBeInTheDocument();
    for (const card of [pending!, failed!]) {
      expect(within(card).getAllByRole("link")).toHaveLength(1);
      expect(within(card).queryByRole("button")).toBeNull();
    }
  });

  it("badges a ready row whose last attempt is a failed reprocess, keeping its summary", async () => {
    const row = pack.list_index.items.find((item) => item.id === "rd_FXREPROC01")!;
    backendAnswers(200, { readings: [row], limit: 20, offset: 0, has_more: false });
    await openTab("/");

    const [card] = cards();
    expect(within(card!).getByText("Reprocess failed")).toBeInTheDocument();
    expect(within(card!).getByRole("link", { name: row.title })).toBeInTheDocument();
    expect(within(card!).getByText(row.tldr!)).toBeInTheDocument();
    // The title and the row's one tag (#417): the badge is not a link.
    expect(within(card!).getAllByRole("link").map((link) => link.textContent)).toEqual([row.title, ...row.tags!]);
  });

  it("shows a ready row's summary and no badge", async () => {
    backendServesPack();
    await openTab("/");

    const attention = cards().find((card) => within(card).queryByRole("link", { name: "A quieter internet is a choice we can make" }))!;
    expect(within(attention).getByText(/^The best tools for thought/)).toBeInTheDocument();
    expect(attention.querySelector(".status-badge")).toBeNull();
  });

  // The reading's "Back to library" goes back to this entry (#407), so the
  // card records where this page sits in history.
  it("opens the reading from its card, recording the way back to this page", async () => {
    backendServesPages(many);
    const { router } = await openTab("/?offset=20");

    await userEvent.click(within(cards()[0]!).getByRole("link"));
    expect(await screen.findByRole("heading", { level: 1, name: `Reading ${many[20]!.id}` })).toBeInTheDocument();
    expect(router.state.location.state.libraryReturn).toEqual({ load: currentLoadId(), index: 0 });
  });
});

describe("what the page says instead of rows", () => {
  it("says the library is empty", async () => {
    backendAnswers(200, { readings: [], limit: 20, offset: 0, has_more: false });
    await openTab("/");
    expect(screen.getByText("No readings yet.")).toBeInTheDocument();
  });
});

// The acceptance matrix's common states (#416), from the server render and
// after a client-side page change. 403, 412, and a server error are the same
// state pages the reading page shows, each with its own heading; a 401 is the
// shell's expired-session page; offline is a notice on the library.
describe("the common states from the server render", () => {
  // A 403 is not a sign-out: the session and its cached identity stay put.
  // On the library there is no library to go back to, so no action.
  it("shows permission denied without ending the session, and offers no way back", async () => {
    backendAnswers(403, { error: "forbidden" });
    const { queryClient } = await openTab("/");

    expect(heading()).toBe("You don't have access to this.");
    expect(queryClient.getQueryData(whoamiQueryKey)).toEqual(reader);
    expect(screen.queryByRole("heading", { name: "Your session ended." })).not.toBeInTheDocument();
    expect(within(screen.getByRole("main")).queryByRole("link", { name: "Back to library" })).toBeNull();
    expect(within(screen.getByRole("main")).queryByRole("button")).toBeNull();
  });

  it("asks for a reload when the tab is signed in to a different account", async () => {
    backendAnswers(412, { error: "expected tenant mismatch", acting_tenant: "usr_b" });
    await openTab("/");

    expect(heading()).toBe("This tab is signed in to a different account than the page expects.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByText("Signed in as usr_b.")).toBeInTheDocument();
  });

  // An errored query is not dehydrated, so on a real page it is asked for
  // again on mount; here the backend keeps failing until Retry.
  it("offers a retry after a server error, and takes the reader out of it", async () => {
    backendAnswers(503, { error: "backend unavailable" });
    await openTab("/");

    await headingSettles("Something went wrong on our side.");
    expect(screen.getByText("backend unavailable")).toBeInTheDocument();

    backendServesPack();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await headingSettles("Library");
    await waitFor(() => expect(cards()).toHaveLength(Math.min(rows.length, 20)));
  });

  it("shows the server-error state when the backend binding throws", async () => {
    backend.list.mockImplementation(async () => {
      throw new Error("binding is down");
    });
    await openTab("/");

    await headingSettles("Something went wrong on our side.");
    expect(screen.getByText(/binding is down/)).toBeInTheDocument();
  });

  it("hands a 401 to the shell's expired-session page, with sign-in back to the library", async () => {
    backendAnswers(401, { error: "unauthorized" });
    await openTab("/?offset=20");

    await headingSettles("Your session ended.");
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login?next=%2F%3Foffset%3D20",
    );
    expect(backend.list).toHaveBeenCalledTimes(1);
  });
});

// Through the browser's loader: the page mounts while the read is out, so
// the state lands on the page the URL names, and useQuery joins the read
// rather than starting another.
describe("the common states after a page change", () => {
  it("shows permission denied on the new page, keeping the session", async () => {
    backendServesFirstPageThen(many, async () => ({ status: 403, body: { error: "forbidden" } }));
    const { router, queryClient } = await openBrowserTab("/");

    await clickNext();
    await headingSettles("You don't have access to this.");
    expect(router.state.location.href).toBe("/?offset=20");
    expect(queryClient.getQueryData(whoamiQueryKey)).toEqual(reader);
  });

  it("shows the account change on the new page", async () => {
    backendServesFirstPageThen(many, async () => ({
      status: 412,
      body: { error: "expected tenant mismatch", acting_tenant: "usr_b" },
    }));
    await openBrowserTab("/");

    await clickNext();
    await headingSettles("This tab is signed in to a different account than the page expects.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("shows the server error on the new page, and Retry reads that page again", async () => {
    let failing = true;
    backendServesFirstPageThen(many, async () =>
      failing
        ? { status: 502, body: { error: "upstream exploded" } }
        : { status: 200, body: { readings: many.slice(20, 40), limit: 20, offset: 20, has_more: true } },
    );
    await openBrowserTab("/");

    await clickNext();
    await headingSettles("Something went wrong on our side.");
    expect(screen.getByText("upstream exploded")).toBeInTheDocument();

    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await headingSettles("Library");
    await waitFor(() => expect(within(cards()[0]!).getByRole("heading", { level: 2 })).toHaveTextContent("Reading 21"));
    expect(backend.list.mock.calls.map(([input]) => input.offset)).toEqual([0, 20, 20]);
  });

  // Retry unmounts the button under the reader's finger. The page that
  // replaces the state page takes the focus, so the outcome is announced
  // either way: the library back again, or the failure again.
  it("moves focus to the heading after Retry, whether the read fails again or not", async () => {
    // Each read past the first page waits to be answered, as a real one does,
    // so the busy library renders between a Retry and its outcome.
    let answer: (response: { status: number; body: unknown }) => void = () => {};
    backendServesFirstPageThen(many, () => new Promise((resolve) => (answer = resolve)));
    const failure = { status: 502, body: { error: "upstream exploded" } };
    const success = { status: 200, body: { readings: many.slice(20, 40), limit: 20, offset: 20, has_more: true } };
    await openBrowserTab("/");
    await pressNext();
    answer(failure);
    await headingSettles("Something went wrong on our side.");

    async function retry(): Promise<void> {
      screen.getByRole("button", { name: "Retry" }).focus();
      await userEvent.keyboard("{Enter}");
      await headingSettles("Library");
      expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    }

    await retry();
    answer(failure);
    await headingSettles("Something went wrong on our side.");
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();

    await retry();
    answer(success);
    await waitFor(() => expect(within(cards()[0]!).getByRole("heading", { level: 2 })).toHaveTextContent("Reading 21"));
    expect(screen.getByRole("heading", { level: 1, name: "Library" })).toHaveFocus();
  });

  // The state page takes the focus the library held: the pager step the
  // reader pressed, or the heading a route change had just focused.
  it("moves focus to the state page's heading from the step that was pressed", async () => {
    backendServesFirstPageThen(many, async () => ({ status: 403, body: { error: "forbidden" } }));
    await openBrowserTab("/");

    await pressNext();
    await headingSettles("You don't have access to this.");
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });

  it("moves focus to the state page's heading after a path change into the library", async () => {
    backendAnswers(503, { error: "backend unavailable" });
    await openBrowserTab("/readings/rd_1");

    await userEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Library" }));
    await headingSettles("Something went wrong on our side.");
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });

  it("shows the expired-session page at the new page's URL", async () => {
    backendServesFirstPageThen(many, async () => ({ status: 401, body: { error: "unauthorized" } }));
    const { router } = await openBrowserTab("/");

    await clickNext();
    await headingSettles("Your session ended.");
    expect(router.state.location.href).toBe("/?offset=20");
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login?next=%2F%3Foffset%3D20",
    );
  });
});

describe("loading", () => {
  function busyRegion(): HTMLElement | null {
    return screen.getByRole("main").querySelector('[aria-busy="true"]');
  }

  it("marks the region busy at once and says so only after the wait is noticeable", async () => {
    backendServesFirstPageThen(many, () => new Promise(() => undefined));
    await openBrowserTab("/");
    await waitFor(() => expect(cards()).toHaveLength(20));

    await clickNext();
    await waitFor(() => expect(busyRegion()).not.toBeNull());
    expect(heading()).toBe("Library");
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.queryByRole("list", { name: "Readings" })).toBeNull();

    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    expect(busyRegion()).toContainElement(screen.getByText("Loading…"));
  });

  // Next is assumed to exist while the page is read, so a reader stepping
  // forward from the keyboard keeps the control they are on (#414).
  it("keeps focus on Next across a page change into a middle page", async () => {
    backendServesPages(many);
    await openBrowserTab("/");
    await waitFor(() => expect(cards()).toHaveLength(20));

    await pressNext();
    await waitFor(() => expect(within(cards()[0]!).getByRole("heading", { level: 2 })).toHaveTextContent("Reading 21"));
    const next = within(screen.getByRole("navigation", { name: "Pagination" })).getByRole("link", { name: "Next" });
    expect(next).toHaveAttribute("href", "/?offset=40");
    expect(next).toHaveFocus();
  });

  // A page with no rows has no pager, so the step that led there cannot keep
  // the focus; the heading takes it rather than the top of the document.
  it("moves focus to the heading when Next lands on a page that has no rows", async () => {
    backendServesFirstPageThen(many, async () => ({
      status: 200,
      body: { readings: [], limit: 20, offset: 20, has_more: false },
    }));
    await openBrowserTab("/");
    await waitFor(() => expect(cards()).toHaveLength(20));

    await pressNext();
    await screen.findByText("No readings on page 2.");
    expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Library" })).toHaveFocus();
  });

  it("does not stay busy once the rows arrive", async () => {
    backendServesPages(many);
    await openBrowserTab("/");
    await waitFor(() => expect(cards()).toHaveLength(20));
    expect(busyRegion()).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("holds the text for 300 ms exactly", () => {
    vi.useFakeTimers();
    render(<DelayedText delayMs={300}>Loading…</DelayedText>);

    act(() => vi.advanceTimersByTime(299));
    expect(screen.queryByText("Loading…")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
});

describe("offline", () => {
  function notice(): HTMLElement {
    return screen.getByRole("status");
  }

  it("says so on a page change that cannot be read, and reads it once the browser is back online", async () => {
    backendServesPages(many);
    const { router } = await openBrowserTab("/");
    await waitFor(() => expect(cards()).toHaveLength(20));

    act(() => onlineManager.setOnline(false));
    await clickNext();
    await waitFor(() => expect(notice()).toHaveTextContent("You're offline."));
    expect(heading()).toBe("Library");
    expect(router.state.location.href).toBe("/?offset=20");
    expect(within(notice()).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Readings" })).toBeNull();
    // Nothing is known about the page, so nothing is assumed: Next is not a
    // way to walk further from a page that never arrived.
    const pager = screen.getByRole("navigation", { name: "Pagination" });
    expect(within(pager).getByRole("link", { name: "Next" })).not.toHaveAttribute("href");
    expect(within(pager).getByRole("link", { name: "Previous" })).toHaveAttribute("href", "/");
    // The read never left: TanStack pauses a fetch it cannot make.
    expect(backend.list.mock.calls.map(([input]) => input.offset)).toEqual([0]);

    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(within(cards()[0]!).getByRole("heading", { level: 2 })).toHaveTextContent("Reading 21"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(backend.list.mock.calls.map(([input]) => input.offset)).toEqual([0, 20]);
  });

  it("keeps the loaded rows beneath the notice when a refresh cannot run", async () => {
    backendServesPages(many);
    const { queryClient } = await openBrowserTab("/");
    await waitFor(() => expect(cards()).toHaveLength(20));

    act(() => onlineManager.setOnline(false));
    // As a later slice's invalidation after a write would.
    await act(() => queryClient.invalidateQueries({ queryKey: libraryQueryKey({ offset: 0 }) }));
    await waitFor(() => expect(notice()).toHaveTextContent("You're offline."));
    expect(cards()).toHaveLength(20);

    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(cards()).toHaveLength(20);
    expect(backend.list.mock.calls.map(([input]) => input.offset)).toEqual([0, 0]);
  });

  it("Retry asks again by hand", async () => {
    backendServesPages(many);
    await openBrowserTab("/");
    await waitFor(() => expect(cards()).toHaveLength(20));

    act(() => onlineManager.setOnline(false));
    await clickNext();
    await waitFor(() => expect(notice()).toBeInTheDocument());

    // Still offline: the retry pauses too, without a request.
    await userEvent.click(within(notice()).getByRole("button", { name: "Retry" }));
    expect(backend.list.mock.calls.map(([input]) => input.offset)).toEqual([0]);
    expect(notice()).toBeInTheDocument();
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

// Search and tags (#417): `q` and `tag` in the URL, written as the current SPA
// writes them, read on the server for a deep link and through the browser's
// loader on a change. The pack has four rows tagged "design" and one titled
// "A quieter internet is a choice we can make".
describe("search and tags", () => {
  function searchField(): HTMLInputElement {
    return screen.getByRole("searchbox", { name: "Search" });
  }

  /** The filter bar, as against the same controls an empty page offers. */
  function bar() {
    return within(screen.getByRole("search", { name: "Filter readings" }));
  }

  function titles(): string[] {
    return cards().map((card) => within(card).getByRole("heading", { level: 2 }).textContent ?? "");
  }

  it("renders a deep link's filtered page on the server, asking for the filters as spelled", async () => {
    backendServesFilteredPack();
    const { router } = await openTab("/?q=Quiet&tag=design&offset=25");

    expect(backend.list).toHaveBeenCalledTimes(1);
    expect(backend.list).toHaveBeenCalledWith(expect.objectContaining({ q: "Quiet", tag: "design", offset: 20 }));
    expect(router.state.location.href).toBe("/?q=Quiet&tag=design&offset=25");
    expect(searchField()).toHaveValue("Quiet");
    expect(bar().getByRole("link", { name: "Clear tag design" })).toHaveAttribute("href", "/?q=Quiet");
    expect(bar().getByRole("link", { name: "Clear search “Quiet”" })).toHaveAttribute("href", "/?tag=design");
    expect(bar().getAllByRole("link").map((link) => link.textContent)).toEqual(["“Quiet” ×", "design ×"]);
  });

  it("shows no chips without filters", async () => {
    backendServesFilteredPack();
    await openTab("/");

    expect(searchField()).toHaveValue("");
    expect(bar().queryByRole("link")).toBeNull();
  });

  it("searches on submit: the draft trimmed, the offset dropped, the field keeping focus", async () => {
    backendServesFilteredPack();
    const { router } = await openBrowserTab("/?offset=20");

    await userEvent.type(searchField(), "  quiet {Enter}");
    await waitFor(() => expect(router.state.location.href).toBe("/?q=quiet"));
    const matching = libraryPage(pack.list_index.items, { q: "quiet" }).readings.map((row) => row.title ?? row.url);
    expect(matching.length).toBeGreaterThan(0);
    expect(matching.length).toBeLessThan(rows.length);
    await waitFor(() => expect(titles()).toEqual(matching));
    expect(backend.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: "quiet", offset: 0 }));
    expect(backend.list).not.toHaveBeenLastCalledWith(expect.objectContaining({ tag: expect.anything() }));
    expect(searchField()).toHaveValue("quiet");
    expect(searchField()).toHaveFocus();
    expect(bar().getByRole("link", { name: "Clear search “quiet”" })).toHaveAttribute("href", "/");
  });

  it("removes the search when an empty draft is submitted", async () => {
    backendServesFilteredPack();
    const { router } = await openBrowserTab("/?q=quiet&tag=design");

    await userEvent.clear(searchField());
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(router.state.location.href).toBe("/?tag=design"));
    expect(backend.list).toHaveBeenLastCalledWith(expect.objectContaining({ tag: "design", offset: 0 }));
  });

  it("filters by a card's tag, keeping the search, and hands focus to the chip", async () => {
    backendServesFilteredPack();
    const { router } = await openBrowserTab("/?q=a&offset=0");

    const attention = cards().find((card) => within(card).queryByRole("link", { name: "A quieter internet is a choice we can make" }))!;
    expect(within(attention).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "A quieter internet is a choice we can make",
      "attention",
      "design",
    ]);
    const design = within(attention).getByRole("link", { name: "design" });
    expect(design).toHaveAttribute("href", "/?q=a&tag=design");

    await userEvent.click(design);
    await waitFor(() => expect(router.state.location.href).toBe("/?q=a&tag=design"));
    expect(backend.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: "a", tag: "design", offset: 0 }));
    await waitFor(() => expect(cards()).toHaveLength(4));
    const chip = screen.getByRole("link", { name: "Clear tag design" });
    expect(chip).toHaveTextContent("design");
    expect(chip).toHaveFocus();
    // The tag every card now carries is text, not a link to the page on screen.
    for (const card of cards()) {
      expect(within(card).queryByRole("link", { name: "design" })).toBeNull();
      expect(within(card).getByText("design")).toBeInTheDocument();
    }
    expect(within(screen.getByRole("list", { name: "Readings" })).queryAllByRole("link", { current: "page" })).toEqual([]);
  });

  // The backend trims and lowercases the tag, so a deep link spelled
  // differently filters the same rows; their tag is the active one all the same.
  it.each(["/?tag=Design", "/?tag=%20design%20"])("marks the active tag on cards as the backend matches it (%s)", async (path) => {
    backendServesFilteredPack();
    await openTab(path);

    expect(cards()).toHaveLength(4);
    for (const card of cards()) {
      expect(within(card).queryByRole("link", { name: "design" })).toBeNull();
      expect(within(card).getByText("design")).toHaveClass("tag-current");
    }
  });

  it("shows the trimmed search in the field even when the URL does not change", async () => {
    backendServesFilteredPack();
    const { router } = await openBrowserTab("/?q=quiet");

    await userEvent.type(searchField(), "   {Enter}");
    expect(router.state.location.href).toBe("/?q=quiet");
    expect(searchField()).toHaveValue("quiet");
    expect(backend.list).toHaveBeenCalledTimes(1);
  });

  // A request to move focus that never lands as a filter change must not be
  // carried over to a later navigation the reader made some other way.
  it("does not move focus on a later navigation after a search that changed nothing", async () => {
    backendServesFilteredPack();
    const { router } = await openBrowserTab("/?q=quiet");

    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(router.state.location.href).toBe("/?q=quiet");
    screen.getByRole("heading", { level: 1 }).focus();

    await act(async () => {
      await router.navigate({ to: "/", search: {} });
    });
    await waitFor(() => expect(router.state.location.href).toBe("/"));
    await waitFor(() => expect(cards().length).toBeGreaterThan(4));
    expect(searchField()).toHaveValue("");
    expect(searchField()).not.toHaveFocus();
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });

  it("clears the tag from its chip, keeping the search and returning focus to the field", async () => {
    backendServesFilteredPack();
    const { router } = await openBrowserTab("/?q=a&tag=design&offset=20");

    await userEvent.click(screen.getByRole("link", { name: "Clear tag design" }));
    await waitFor(() => expect(router.state.location.href).toBe("/?q=a"));
    expect(backend.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: "a", offset: 0 }));
    expect(screen.queryByRole("link", { name: /^Clear tag/ })).toBeNull();
    expect(searchField()).toHaveValue("a");
    expect(searchField()).toHaveFocus();
  });

  it("clears the search from its chip, keeping the tag", async () => {
    backendServesFilteredPack();
    const { router } = await openBrowserTab("/?q=a&tag=design&utm_source=feed");

    await userEvent.click(bar().getByRole("link", { name: "Clear search “a”" }));
    await waitFor(() => expect(router.state.location.href).toBe("/?tag=design&utm_source=feed"));
    expect(searchField()).toHaveValue("");
    expect(searchField()).toHaveFocus();
  });

  it("keeps the filters across a page change", async () => {
    backend.list.mockImplementation(async ({ q, tag, offset = 0 }: { q?: string; tag?: string; offset?: number }) => ({
      status: 200,
      body: { readings: many.slice(offset, offset + 20), limit: 20, offset, has_more: offset + 20 < many.length, q, tag },
    }));
    const { router } = await openBrowserTab("/?q=reading&tag=ai");

    await clickNext();
    await waitFor(() => expect(router.state.location.href).toBe("/?q=reading&tag=ai&offset=20"));
    expect(backend.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: "reading", tag: "ai", offset: 20 }));
  });

  it("offers to save a reading when the library is empty", async () => {
    backendAnswers(200, { readings: [], limit: 20, offset: 0, has_more: false });
    await openTab("/");

    expect(screen.getByText("No readings yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Save a reading" })).toHaveAttribute("href", "/save");
    expect(screen.queryByRole("link", { name: /^Clear/ })).toBeNull();
  });

  it.each([
    ["/?q=zzz", "No readings match “zzz”.", ["Clear search"], { "Clear search": "/" }],
    ["/?tag=none", "No readings tagged none.", ["Clear tag"], { "Clear tag": "/" }],
    [
      "/?q=zzz&tag=none",
      "No readings match “zzz” tagged none.",
      ["Clear search", "Clear tag"],
      { "Clear search": "/?tag=none", "Clear tag": "/?q=zzz" },
    ],
  ])("names the filters behind an empty %s, with the controls that clear them", async (path, copy, actions, hrefs) => {
    backendServesFilteredPack();
    await openTab(path);

    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.queryByText("No readings yet.")).toBeNull();
    expect(screen.queryByRole("link", { name: "Save a reading" })).toBeNull();
    const message = screen.getByText(copy).parentElement!;
    expect(within(message).getAllByRole("link").map((link) => link.textContent)).toEqual(actions);
    for (const [name, href] of Object.entries(hrefs)) {
      expect(within(message).getByRole("link", { name })).toHaveAttribute("href", href);
    }
  });

  it("names the filters on a page past their end, with the first page of the same filters", async () => {
    backendServesFilteredPack();
    await openTab("/?q=quiet&offset=20");

    const message = within(screen.getByText("No readings match “quiet” on page 2.").parentElement!);
    expect(message.getByRole("link", { name: "First page" })).toHaveAttribute("href", "/?q=quiet");
    expect(message.getByRole("link", { name: "Clear search" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull();
  });

  it("clears a filter from the empty page and lands the reader in the field", async () => {
    backendServesFilteredPack();
    const { router } = await openBrowserTab("/?q=zzz&tag=design");

    const message = screen.getByText("No readings match “zzz” tagged design.").parentElement!;
    await userEvent.click(within(message).getByRole("link", { name: "Clear search" }));
    await waitFor(() => expect(router.state.location.href).toBe("/?tag=design"));
    await waitFor(() => expect(cards()).toHaveLength(4));
    expect(searchField()).toHaveFocus();
  });
});
