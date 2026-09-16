import { QueryClientProvider, onlineManager } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import { requireSignedIn } from "../src/auth/guards";
import { createQueryClient, hrefOnScreen } from "../src/auth/session";
import { AppFrame } from "../src/components/AppFrame";
import { PageHeading } from "../src/components/PageHeading";
import { ReadingPage } from "../src/components/ReadingPage";
import { SavePage } from "../src/components/SavePage";
import { SignInPage } from "../src/components/SignInPage";
import { whoamiQueryKey, type Identity } from "../src/identity";
import { libraryQueryKey } from "../src/library";
import { readingQueryKey, type Reading } from "../src/reading";
import { readingQueryOptions } from "../src/reading-query";
import { readingViewOf, validateReadingSearch } from "../src/reading-view";
import type { RouterContext } from "../src/router";
import { plainSearch } from "../src/search";

// Saving a URL through the real page, mutation, and shell, on a route tree
// shaped like src/routes (#431). The browser's own POST is a stubbed fetch,
// as in test/save-api.test.ts; the reading the save opens is read through the
// same fake backend entrypoint reading-detail.test.tsx uses, because without
// the Start compiler the isomorphic reading query resolves to its server
// branch.

const { backend, request } = vi.hoisted(() => ({
  backend: { reading: vi.fn(), whoami: vi.fn() },
  request: { current: new Request("https://app.example/") },
}));

vi.mock("cloudflare:workers", () => ({ env: { BACKEND: backend } }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => request.current }));

const readings = pack.readings as Record<string, Reading>;
const PENDING = "rd_FXPENDNG01";

const ACCEPTED = {
  id: PENDING,
  status: "pending",
  poll: `/api/readings/${PENDING}`,
  attempt_id: "att_1",
};

const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

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
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: () => <SignInPage />,
});
const authedRoute = createRoute({ getParentRoute: () => rootRoute, id: "_authed", beforeLoad: requireSignedIn });
const saveRoute = createRoute({ getParentRoute: () => authedRoute, path: "/save", component: SavePage });
const readingRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/readings/$id",
  validateSearch: validateReadingSearch,
  loader: ({ context, params }) => {
    const identity = context.queryClient.getQueryData<Identity | null>(whoamiQueryKey);
    return context.queryClient.prefetchQuery(readingQueryOptions(context.queryClient, params.id, identity));
  },
  component: function ReadingRoute() {
    const { id } = readingRoute.useParams();
    const search = readingRoute.useSearch();
    return <ReadingPage id={id} view={readingViewOf(search)} />;
  },
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  authedRoute.addChildren([saveRoute, readingRoute]),
]);

function stubFetch(answer: () => Response) {
  const fetchMock = vi.fn(async () => answer());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openSave(identity: Identity | null = reader) {
  const queryClient = createQueryClient(() => hrefOnScreen(router));
  queryClient.setQueryData(whoamiQueryKey, identity);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    ...plainSearch,
    history: createMemoryHistory({ initialEntries: ["/save"] }),
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.status).toBe("idle"));
  await screen.findByRole("heading", { level: 1 });
  return { router, queryClient };
}

function urlField(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "URL" }) as HTMLInputElement;
}

beforeEach(() => {
  backend.reading.mockImplementation(async ({ id }: { id: string }) =>
    id in readings ? { status: 200, body: readings[id] } : { status: 404, body: { error: "not found" } },
  );
  request.current = new Request("https://app.example/");
});

afterEach(() => {
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
  cleanup();
  localStorage.clear();
});

describe("the save page", () => {
  it("sends a signed-out reader to sign in and back", async () => {
    const { router } = await openSave(null);

    expect(router.state.location.href).toBe("/login?next=%2Fsave");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sign in");
  });

  it("offers the URL tab and its field", async () => {
    await openSave();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Save reading");
    expect(screen.getByRole("tab", { name: "URL" })).toHaveAttribute("aria-selected", "true");
    expect(urlField()).toBeInTheDocument();
  });

  // The rule is the backend's, applied before the round trip; nothing is
  // asked for and the reader stays on the page, in the field.
  it("refuses a URL it can see is wrong without asking the backend", async () => {
    const fetchMock = stubFetch(() => Response.json(ACCEPTED, { status: 202 }));
    const { router } = await openSave();

    await userEvent.type(urlField(), "not a url");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("Enter a full URL, like https://example.com/article.")).toBeVisible();
    expect(urlField()).toHaveFocus();
    expect(urlField()).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.state.location.href).toBe("/save");
  });

  it("links the message to the field it belongs to", async () => {
    await openSave();

    await userEvent.type(urlField(), "ftp://example.com/a");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const message = screen.getByText("Only http and https links can be saved.");
    expect(urlField()).toHaveAttribute("aria-describedby", message.id);
  });

  // A URL the rule accepts can still be refused, and that answer renders in
  // the same place, in the backend's words.
  it("renders a rejection from the backend in the field", async () => {
    stubFetch(() =>
      Response.json({ error: "url rejected: host is not allowed", code: "unsupported_url" }, { status: 400 }),
    );
    const { router } = await openSave();

    await userEvent.type(urlField(), "https://blocked.example/a");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("url rejected: host is not allowed")).toBeVisible());
    expect(urlField()).toHaveFocus();
    expect(urlField()).toHaveAttribute("aria-invalid", "true");
    expect(router.state.location.href).toBe("/save");
  });

  it("opens the reading a save created, and lets the library know", async () => {
    stubFetch(() => Response.json(ACCEPTED, { status: 202 }));
    const { router, queryClient } = await openSave();
    const libraryKey = libraryQueryKey({ offset: 0 });
    queryClient.setQueryData(libraryKey, { state: "ready", page: { readings: [], limit: 20, offset: 0, has_more: false } });

    await userEvent.type(urlField(), "https://fieldnotes.example/making-room-for-slow-work");
    // The polite message is on the page before it leaves it.
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(router.state.location.href).toBe(`/readings/${PENDING}`));
    await waitFor(() => expect(screen.getByText("This reading is still being processed.")).toBeVisible());
    expect(queryClient.getQueryState(libraryKey)?.isInvalidated).toBe(true);
    await expect((vi.mocked(fetch).mock.calls[0]![0] as unknown as Request).json()).resolves.toEqual({
      url: "https://fieldnotes.example/making-room-for-slow-work",
    });
  });

  // A failed owner is reprocessed in place under the same id (AGENTS.md), and
  // the reading query never goes stale on its own. A failed answer this tab
  // read earlier must not be what the reader lands on.
  it("does not show a reading's earlier failure over the attempt a save just started", async () => {
    stubFetch(() => Response.json(ACCEPTED, { status: 202 }));
    const { router, queryClient } = await openSave();
    queryClient.setQueryData(readingQueryKey(PENDING), {
      state: "ready",
      reading: { ...readings.rd_FXERR00001, id: PENDING },
    });

    await userEvent.type(urlField(), "https://fieldnotes.example/making-room-for-slow-work");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(router.state.location.href).toBe(`/readings/${PENDING}`));
    await waitFor(() => expect(screen.getByText("This reading is still being processed.")).toBeVisible());
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  });

  it("says a save landed before it leaves the page", async () => {
    stubFetch(() => Response.json(ACCEPTED, { status: 202 }));
    // The reading never answers, so the navigation stays pending and this page
    // is still the one on screen: what it announced can be read.
    backend.reading.mockImplementation(() => new Promise(() => {}));
    await openSave();

    await userEvent.type(urlField(), "https://example.com/a");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved. Opening the reading…"));
  });

  // A URL already in the library was not saved now, so the page does not say
  // it was; it still opens the reading and refreshes the library.
  it("opens a reading that already owns the URL without claiming a save", async () => {
    stubFetch(() => Response.json(readings[PENDING], { status: 200 }));
    const { router, queryClient } = await openSave();
    const libraryKey = libraryQueryKey({ offset: 0 });
    queryClient.setQueryData(libraryKey, {
      state: "ready",
      page: { readings: [], limit: 20, offset: 0, has_more: false },
    });

    await userEvent.type(urlField(), "https://fieldnotes.example/making-room-for-slow-work");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(router.state.location.href).toBe(`/readings/${PENDING}`));
    expect(queryClient.getQueryState(libraryKey)?.isInvalidated).toBe(true);
  });

  it("says only that it is opening the reading when nothing was saved", async () => {
    stubFetch(() => Response.json({ id: "rd_1", url: "https://example.com/a", status: "ready" }, { status: 200 }));
    backend.reading.mockImplementation(() => new Promise(() => {}));
    await openSave();

    await userEvent.type(urlField(), "https://example.com/a");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Opening the reading…"));
    expect(screen.getByRole("status")).not.toHaveTextContent("Saved.");
  });

  it("shows the account-changed state for a 412", async () => {
    stubFetch(() => Response.json({ error: "expected tenant mismatch", acting_tenant: "usr_b" }, { status: 412 }));
    await openSave();

    await userEvent.type(urlField(), "https://example.com/a");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "This tab is signed in to a different account than the page expects.",
      ),
    );
    // The pin's answer travels with the state, as it does on a read.
    expect(screen.getByText("Signed in as usr_b.")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });

  it("shows the forbidden state for a 403", async () => {
    stubFetch(() => Response.json({ error: "forbidden" }, { status: 403 }));
    await openSave();

    await userEvent.type(urlField(), "https://example.com/a");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("You don't have access to this."),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });

  // Another tab signing in as someone else replaces the shared cookie, so this
  // tab's CSRF token no longer matches and the backend answers 403 before the
  // tenant pin can say 412. The page still has to be the account-changed one.
  it("shows the account-changed state for a 403 when another account is signed in now", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) =>
        new URL(request.url).pathname === "/api/whoami"
          ? Response.json({ ...reader, tenant_id: "usr_b", user_id: "usr_b", email: "b@example.com" })
          : Response.json({ error: "forbidden" }, { status: 403 }),
      ),
    );
    await openSave();

    await userEvent.type(urlField(), "https://example.com/a");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "This tab is signed in to a different account than the page expects.",
      ),
    );
    expect(screen.getByText("Signed in as usr_b.")).toBeVisible();
  });

  // A 401 is the shell's page at this URL, not the form's error.
  it("hands a 401 to the shell's expired-session page", async () => {
    stubFetch(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    await openSave();

    await userEvent.type(urlField(), "https://example.com/a");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your session ended."));
  });

  // Offline is a notice above the form, not a page: whatever was typed stays.
  // A save started without a network never runs; React Query holds it paused
  // and continues it when the browser is back.
  it("holds a save made offline and shows the notice over the form", async () => {
    stubFetch(() => Response.json(ACCEPTED, { status: 202 }));
    const { router } = await openSave();
    onlineManager.setOnline(false);

    await userEvent.type(urlField(), "https://example.com/a");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByText("You're offline. This save will be sent when your connection returns.")).toBeVisible(),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Save reading");
    expect(urlField()).toHaveValue("https://example.com/a");

    // Nothing to retry: React Query sends it when the browser is back, and a
    // second submit would claim the URL twice.
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(
      screen.getByText("You're offline. This save will be sent when your connection returns."),
    ).toBeVisible();

    onlineManager.setOnline(true);
    await waitFor(() => expect(router.state.location.href).toBe(`/readings/${PENDING}`));
  });

  // query-core keeps a paused mutation after the page is gone and resumes it
  // when the browser is back. It must not then navigate: the reader has moved
  // on, and pulling them to the new reading would take the page from under
  // them.
  it("does not move a reader who left while a save was held offline", async () => {
    stubFetch(() => Response.json(ACCEPTED, { status: 202 }));
    const { router } = await openSave();
    onlineManager.setOnline(false);

    await userEvent.type(urlField(), "https://example.com/a");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByText("You're offline. This save will be sent when your connection returns.")).toBeVisible(),
    );

    await act(async () => {
      await router.navigate({ to: "/" });
    });
    expect(router.state.location.href).toBe("/");

    await act(async () => {
      onlineManager.setOnline(true);
      // Long enough for the resumed save to settle and its callbacks to run.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // The save still reached the backend; the reader simply stayed put.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(router.state.location.href).toBe("/");
  });

  // The other shape: the request ran and failed with the network already gone.
  it("shows the notice for a save that failed while the network was away", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        onlineManager.setOnline(false);
        throw new TypeError("Failed to fetch");
      }),
    );
    const { router } = await openSave();

    await userEvent.type(urlField(), "https://example.com/a");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByText("You're offline. Check your connection and try again.")).toBeVisible(),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Save reading");

    // That save is over, so this notice does offer the way on.
    onlineManager.setOnline(true);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(ACCEPTED, { status: 202 })));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(router.state.location.href).toBe(`/readings/${PENDING}`));
  });

  // Retry is a submit, so it cannot get past a rule a submit would catch.
  it("applies the field's rule to a retry after an offline failure", async () => {
    const fetchMock = vi.fn(async () => {
      onlineManager.setOnline(false);
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    await openSave();

    await userEvent.type(urlField(), "https://example.com/a");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByText("You're offline. Check your connection and try again.")).toBeVisible(),
    );

    onlineManager.setOnline(true);
    await userEvent.clear(urlField());
    fetchMock.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.getByText("Enter the URL of the page you want to save.")).toBeVisible();
    expect(urlField()).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers a retry after a server error and takes the reader back to the form", async () => {
    stubFetch(() => Response.json({ error: "upstream exploded" }, { status: 502 }));
    await openSave();

    await userEvent.type(urlField(), "https://example.com/a");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Something went wrong on our side."),
    );
    expect(screen.getByText("upstream exploded")).toBeVisible();
    // The page that replaced the form takes the focus it held, so it is announced.
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Save reading");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveFocus());
    // The URL the reader typed is still there to try again.
    expect(urlField()).toHaveValue("https://example.com/a");
  });
});
