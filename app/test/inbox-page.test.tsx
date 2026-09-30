import { QueryClientProvider, onlineManager } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  useLocation,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireSignedIn } from "../src/auth/guards";
import { createQueryClient, hrefOnScreen } from "../src/auth/session";
import { AppFrame } from "../src/components/AppFrame";
import { InboxItemPage } from "../src/components/InboxItemPage";
import { InboxPage } from "../src/components/InboxPage";
import { PageHeading } from "../src/components/PageHeading";
import { whoamiQueryKey, type Identity } from "../src/identity";
import { inboxQueryKey } from "../src/inbox";
import { libraryQueryKey } from "../src/library";
import type { RouterContext } from "../src/router";
import { saveNoticeOf } from "../src/save-notice";
import { plainSearch } from "../src/search";

// The inbox (reading-lite-fy8t) through the real pages, mutations, and shell,
// on a route tree shaped like src/routes. Every request is the browser's own,
// so the backend is a stubbed fetch keyed by method and path. The reading a
// promote opens is a stand-in page: what it shows is the reading page's own
// business (test/save-page.test.tsx), and what matters here is that it is
// opened, with the save notice in its history state.

vi.mock("cloudflare:workers", () => ({ env: { BACKEND: {} } }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => new Request("https://app.example/") }));

const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

const TITLED = {
  id: "in_TITLED",
  url: "https://notes.example/slow-reading-week",
  title: "Slow reading week",
  markdown_bytes: 1200,
  created_at: "2026-09-29T10:00:00.000Z",
  updated_at: "2026-09-29T11:00:00.000Z",
};
const UNTITLED = {
  id: "in_UNTITLED",
  url: "https://fieldnotes.example/untitled-draft",
  title: null,
  markdown_bytes: 640,
  created_at: "2026-09-28T09:00:00.000Z",
  updated_at: "2026-09-28T09:00:00.000Z",
};
const MARKDOWN = "# Slow reading week\n\nOne thing at a time, and [the rest](/later) can wait.";

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
  component: () => (
    <div className="page">
      <PageHeading>Library</PageHeading>
    </div>
  ),
});
const authedRoute = createRoute({ getParentRoute: () => rootRoute, id: "_authed", beforeLoad: requireSignedIn });
const inboxRoute = createRoute({ getParentRoute: () => authedRoute, path: "/inbox", component: InboxPage });
const itemRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/inbox/$id",
  component: function ItemRoute() {
    const { id } = itemRoute.useParams();
    return <InboxItemPage key={id} id={id} />;
  },
});
const readingRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/readings/$id",
  component: function ReadingStandIn() {
    const { id } = readingRoute.useParams();
    const notice = useLocation({ select: (location) => saveNoticeOf(location.state) });
    return (
      <div className="page">
        <PageHeading>Reading {id}</PageHeading>
        <p>Notice: {notice ?? "none"}</p>
      </div>
    );
  },
});
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: () => <h1>Sign in</h1> });
const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  authedRoute.addChildren([inboxRoute, itemRoute, readingRoute]),
]);

type Answer = () => Response;

/**
 * The backend, by "METHOD path". Unlisted requests answer 404 so a stray one
 * shows up as a not-found state rather than hanging.
 */
function stubBackend(answers: Record<string, Answer>) {
  const fetchMock = vi.fn(async (input: Request) => {
    const key = `${input.method} ${new URL(input.url).pathname}`;
    const answer = answers[key];
    return answer ? answer() : Response.json({ error: "not found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestsTo(fetchMock: ReturnType<typeof stubBackend>, method: string, path: string): Request[] {
  return fetchMock.mock.calls
    .map(([input]) => input)
    .filter((input) => input.method === method && new URL(input.url).pathname === path);
}

async function open(path: string, identity: Identity | null = reader) {
  const queryClient = createQueryClient(() => hrefOnScreen(router));
  queryClient.setQueryData(whoamiQueryKey, identity);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    ...plainSearch,
    history: createMemoryHistory({ initialEntries: [path] }),
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.status).toBe("idle"));
  return { router, queryClient };
}

function listed(...items: object[]): Answer {
  return () => Response.json({ items });
}

function item(meta: object = TITLED, markdown = MARKDOWN): Answer {
  return () => Response.json({ ...meta, markdown });
}

afterEach(() => {
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
  cleanup();
});

describe("the inbox", () => {
  it("sends a signed-out reader to sign in and back", async () => {
    const { router } = await open("/inbox", null);
    expect(router.state.location.href).toBe("/login?next=%2Finbox");
  });

  it("lists every staged item, named by its title or else its URL", async () => {
    stubBackend({ "GET /api/inbox": listed(TITLED, UNTITLED) });
    await open("/inbox");

    const list = await screen.findByRole("list", { name: "Inbox items" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: "Slow reading week" })).toHaveAttribute(
      "href",
      "/inbox/in_TITLED",
    );
    expect(rows[0]).toHaveTextContent("notes.example");
    expect(rows[0]).toHaveTextContent("1 KB");
    expect(rows[0]).toHaveTextContent("Staged 29 September 2026, 11:00 UTC");
    expect(within(rows[1]!).getByRole("link", { name: UNTITLED.url })).toHaveAttribute("href", "/inbox/in_UNTITLED");
  });

  it("says so when there is nothing staged", async () => {
    stubBackend({ "GET /api/inbox": listed() });
    await open("/inbox");

    expect(await screen.findByText("Your inbox is empty.")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Inbox items" })).not.toBeInTheDocument();
  });

  it.each([
    [403, { error: "forbidden" }, "You don't have access to this."],
    [
      412,
      { error: "expected tenant mismatch", acting_tenant: "usr_b" },
      "This tab is signed in to a different account than the page expects.",
    ],
    [503, { error: "storage unavailable" }, "Something went wrong on our side."],
  ])("replaces the list with the shared state for %i", async (status, body, heading) => {
    stubBackend({ "GET /api/inbox": () => Response.json(body, { status }) });
    await open("/inbox");

    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
  });

  it("reads the list again each time it is opened", async () => {
    const fetchMock = stubBackend({ "GET /api/inbox": listed(TITLED), "GET /api/inbox/in_TITLED": item() });
    const { router } = await open("/inbox");
    await screen.findByRole("link", { name: "Slow reading week" });

    await userEvent.click(screen.getByRole("link", { name: "Slow reading week" }));
    await screen.findByRole("region", { name: "Preview" });
    await userEvent.click(screen.getByRole("link", { name: "Back to inbox" }));
    await waitFor(() => expect(router.state.location.href).toBe("/inbox"));

    await waitFor(() => expect(requestsTo(fetchMock, "GET", "/api/inbox")).toHaveLength(2));
  });
});

describe("an inbox item", () => {
  it("previews the staged Markdown as the Source view renders it", async () => {
    stubBackend({ "GET /api/inbox/in_TITLED": item() });
    await open("/inbox/in_TITLED");

    expect(await screen.findByRole("heading", { level: 1, name: "Slow reading week" })).toBeInTheDocument();
    const preview = screen.getByRole("region", { name: "Preview" });
    // Headings demoted under the page's own title, links resolved against the
    // staged URL and opened in a new tab without a referrer.
    expect(within(preview).getByRole("heading", { level: 2, name: "Slow reading week" })).toBeInTheDocument();
    const link = within(preview).getByRole("link", { name: "the rest" });
    expect(link).toHaveAttribute("href", "https://notes.example/later");
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(screen.getByRole("link", { name: "notes.example" })).toHaveAttribute("href", TITLED.url);
  });

  it("shows the item-gone page for an item that is not in the inbox", async () => {
    stubBackend({});
    await open("/inbox/in_GONE");

    expect(
      await screen.findByRole("heading", { level: 1, name: "This item isn't in your inbox." }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to inbox" })).toHaveAttribute("href", "/inbox");
  });

  it("opens the reading an add created, and lets the library and the inbox know", async () => {
    const fetchMock = stubBackend({
      "GET /api/inbox/in_TITLED": item(),
      "POST /api/inbox/in_TITLED/promote": () =>
        Response.json({ id: "rd_NEW", status: "pending", inbox_item_id: "in_TITLED" }, { status: 202 }),
    });
    const { router, queryClient } = await open("/inbox/in_TITLED");
    const libraryKey = libraryQueryKey({ offset: 0 });
    queryClient.setQueryData(libraryKey, {
      state: "ready",
      page: { readings: [], limit: 20, offset: 0, has_more: false },
    });
    queryClient.setQueryData(inboxQueryKey("usr_a"), { state: "ready", value: { items: [TITLED, UNTITLED] } });

    await userEvent.click(await screen.findByRole("button", { name: "Add to library" }));

    await waitFor(() => expect(router.state.location.href).toBe("/readings/rd_NEW"));
    expect(screen.getByText("Notice: none")).toBeInTheDocument();
    expect(queryClient.getQueryState(libraryKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData(inboxQueryKey("usr_a"))).toEqual({ state: "ready", value: { items: [UNTITLED] } });
    expect(queryClient.getQueryState(inboxQueryKey("usr_a"))?.isInvalidated).toBe(true);
    // The item on screen was not asked for again under the page leaving it.
    expect(requestsTo(fetchMock, "GET", "/api/inbox/in_TITLED")).toHaveLength(1);
  });

  it("says a URL that was already a reading is already in the library", async () => {
    stubBackend({
      "GET /api/inbox/in_TITLED": item(),
      "POST /api/inbox/in_TITLED/promote": () =>
        Response.json({ id: "rd_OLD", status: "ready", inbox_item_id: "in_TITLED" }, { status: 200 }),
    });
    const { router } = await open("/inbox/in_TITLED");

    await userEvent.click(await screen.findByRole("button", { name: "Add to library" }));

    await waitFor(() => expect(router.state.location.href).toBe("/readings/rd_OLD"));
    expect(screen.getByText("Notice: already-saved")).toBeInTheDocument();
  });

  it("keeps the item under a refusal that will pass, and Try again asks again", async () => {
    let refuse = true;
    const fetchMock = stubBackend({
      "GET /api/inbox/in_TITLED": item(),
      "POST /api/inbox/in_TITLED/promote": () =>
        refuse
          ? Response.json(
              { error: "rate limited", code: "rate_limited", limit: "hourly", reset_at: "2026-09-29T12:00:00.000Z" },
              { status: 429 },
            )
          : Response.json({ id: "rd_NEW", status: "pending", inbox_item_id: "in_TITLED" }, { status: 202 }),
    });
    const { router } = await open("/inbox/in_TITLED");

    await userEvent.click(await screen.findByRole("button", { name: "Add to library" }));

    const sentence = "You've reached the hourly reading limit. It resets at 29 September 2026, 12:00 UTC.";
    expect(await screen.findByText(sentence, { selector: ".offline-notice-text" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(sentence);
    expect(screen.getByRole("region", { name: "Preview" })).toBeInTheDocument();

    refuse = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(router.state.location.href).toBe("/readings/rd_NEW"));
    expect(requestsTo(fetchMock, "POST", "/api/inbox/in_TITLED/promote")).toHaveLength(2);
  });

  it.each([
    [409, { error: "reading already has an active attempt" }, "This reading is already processing."],
    [
      413,
      { error: "markdown too large", code: "markdown_too_large" },
      "This Markdown is too large to add to your library once it takes the failed reading's title. Discard it, or have the agent stage it again with a title.",
    ],
  ])("offers nothing to retry for %i", async (status, body, sentence) => {
    stubBackend({
      "GET /api/inbox/in_TITLED": item(),
      "POST /api/inbox/in_TITLED/promote": () => Response.json(body, { status }),
    });
    await open("/inbox/in_TITLED");

    await userEvent.click(await screen.findByRole("button", { name: "Add to library" }));

    expect(await screen.findByText(sentence, { selector: ".offline-notice-text" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("shows the item-gone page when the item left the inbox before the add", async () => {
    stubBackend({
      "GET /api/inbox/in_TITLED": item(),
      "POST /api/inbox/in_TITLED/promote": () => Response.json({ error: "not found" }, { status: 404 }),
    });
    await open("/inbox/in_TITLED");

    await userEvent.click(await screen.findByRole("button", { name: "Add to library" }));

    expect(await screen.findByRole("heading", { level: 1, name: "This item isn't in your inbox." })).toHaveFocus();
  });

  it("discards only after the reader confirms, then returns to the inbox", async () => {
    let discarded = false;
    const fetchMock = stubBackend({
      "GET /api/inbox": () => Response.json({ items: discarded ? [UNTITLED] : [TITLED, UNTITLED] }),
      "GET /api/inbox/in_TITLED": item(),
      "DELETE /api/inbox/in_TITLED": () => {
        discarded = true;
        return new Response(null, { status: 204 });
      },
    });
    const { router } = await open("/inbox/in_TITLED");

    await userEvent.click(await screen.findByRole("button", { name: "Discard…" }));
    const dialog = screen.getByRole("dialog", { name: "Discard this item?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(requestsTo(fetchMock, "DELETE", "/api/inbox/in_TITLED")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Discard…" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Discard this item?" })).getByRole("button", { name: "Discard" }),
    );

    await waitFor(() => expect(router.state.location.href).toBe("/inbox"));
    const list = await screen.findByRole("list", { name: "Inbox items" });
    expect(within(list).queryByRole("link", { name: "Slow reading week" })).not.toBeInTheDocument();
    expect(requestsTo(fetchMock, "DELETE", "/api/inbox/in_TITLED")).toHaveLength(1);
  });

  it("keeps the item when a discard fails offline, and Retry asks through the dialog again", async () => {
    stubBackend({ "GET /api/inbox/in_TITLED": item() });
    await open("/inbox/in_TITLED");
    await screen.findByRole("region", { name: "Preview" });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementationOnce(async () => {
      onlineManager.setOnline(false);
      throw new TypeError("Failed to fetch");
    });

    await userEvent.click(screen.getByRole("button", { name: "Discard…" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Discard this item?" })).getByRole("button", { name: "Discard" }),
    );

    expect(await screen.findByText("You're offline. Check your connection and try again.")).toBeVisible();
    expect(screen.getByRole("region", { name: "Preview" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("dialog", { name: "Discard this item?" })).toBeInTheDocument();
  });
});
