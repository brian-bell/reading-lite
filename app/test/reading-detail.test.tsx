import { QueryClientProvider, dehydrate, hydrate } from "@tanstack/react-query";
import {
  Link,
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
import { requireSignedIn } from "../src/auth/guards";
import { createQueryClient, hrefOnScreen } from "../src/auth/session";
import { AppFrame } from "../src/components/AppFrame";
import { PageHeading } from "../src/components/PageHeading";
import { ReadingPage } from "../src/components/ReadingPage";
import { whoamiQueryKey, type Identity } from "../src/identity";
import { readingQueryKey, type Reading } from "../src/reading";
import { readingQueryOptions } from "../src/reading-query";
import type { RouterContext } from "../src/router";
import { plainSearch } from "../src/search";

// Reading detail through the real page, query, and shell, on a route tree
// shaped like src/routes.
//
// Without the Start compiler an isomorphic function resolves to its server
// branch, so these drive the server-render path: a fake FrontendReads, reached
// through the same query the route's loader uses. That is the path that
// produces the HTML, and the browser path has its own test in
// test/reading-api.test.ts. Fixture bodies come from the pack the browser suite
// serves (docs/design/connected/fixture-pack.md).

const { backend, request } = vi.hoisted(() => ({
  backend: { reading: vi.fn(), whoami: vi.fn() },
  request: { current: new Request("https://app.example/") },
}));

vi.mock("cloudflare:workers", () => ({ env: { BACKEND: backend } }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => request.current }));

const readings = pack.readings as Record<string, Reading>;
const ATTENTION = "rd_FXATTENT01";

const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

/** The backend answers every read with this. */
function backendAnswers(status: number, body: unknown) {
  backend.reading.mockImplementation(async () => ({ status, body }));
}

/** The backend answers per reading id. */
function backendServes(bodies: Record<string, unknown>) {
  backend.reading.mockImplementation(async ({ id }: { id: string }) =>
    id in bodies ? { status: 200, body: bodies[id] } : { status: 404, body: { error: "not found" } },
  );
}

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
      <Link to="/readings/$id" params={{ id: ATTENTION }}>
        Open the reading
      </Link>
    </div>
  ),
});
const authedRoute = createRoute({ getParentRoute: () => rootRoute, id: "_authed", beforeLoad: requireSignedIn });
const readingRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/readings/$id",
  loader: ({ context, params }) => {
    const identity = context.queryClient.getQueryData<Identity | null>(whoamiQueryKey);
    return context.queryClient.prefetchQuery(readingQueryOptions(context.queryClient, params.id, identity));
  },
  component: function ReadingRoute() {
    const { id } = readingRoute.useParams();
    return <ReadingPage id={id} />;
  },
});
const routeTree = rootRoute.addChildren([indexRoute, authedRoute.addChildren([readingRoute])]);

function newTab(path: string, identity: Identity | null = reader) {
  const queryClient = createQueryClient(() => hrefOnScreen(router));
  queryClient.setQueryData(whoamiQueryKey, identity);
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
  // The loader settles the query before the page renders; waiting for the
  // router keeps an assertion from reading the loading heading instead.
  await waitFor(() => expect(tab.router.state.status).toBe("idle"));
  await screen.findByRole("heading", { level: 1 });
  return tab;
}

function heading(): string {
  return screen.getByRole("heading", { level: 1 }).textContent ?? "";
}

/** The heading once the page has settled on one. */
async function headingSettles(text: string): Promise<void> {
  await waitFor(() => expect(heading()).toBe(text));
}

beforeEach(() => {
  backend.reading.mockReset();
  request.current = new Request("https://app.example/");
});

afterEach(() => {
  localStorage.clear();
});

describe("a ready reading", () => {
  it("renders the title, hostname, and saved date", async () => {
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);

    expect(heading()).toBe("A quieter internet is a choice we can make");
    expect(screen.getByText("fieldnotes.example")).toBeInTheDocument();
    expect(screen.getByText("Saved 7 September 2026")).toBeInTheDocument();
  });

  it("names imported Markdown in the metadata line", async () => {
    backendAnswers(200, readings.rd_FXMDPAGE01);
    await openTab("/readings/rd_FXMDPAGE01");

    expect(screen.getByText("Imported Markdown")).toBeInTheDocument();
  });

  it("says nothing about the source type for a fetched URL", async () => {
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);

    expect(screen.queryByText("Imported Markdown")).not.toBeInTheDocument();
  });

  // The manifest title has no length cap; truncating would lose the end of it.
  it("carries a very long title whole", async () => {
    const long = readings.rd_FXMAXNAME1;
    backendAnswers(200, long);
    await openTab("/readings/rd_FXMAXNAME1");

    expect(heading()).toBe(long.title);
    expect(heading().length).toBeGreaterThan(120);
  });

  it("falls back to the URL when the manifest has no title", async () => {
    backendAnswers(200, { id: ATTENTION, url: "https://example.com/x", status: "ready" });
    await openTab(`/readings/${ATTENTION}`);

    expect(heading()).toBe("https://example.com/x");
  });

  it("omits the saved date rather than inventing one", async () => {
    backendAnswers(200, { id: ATTENTION, url: "https://example.com/x", status: "ready" });
    await openTab(`/readings/${ATTENTION}`);

    expect(screen.queryByText(/^Saved /)).not.toBeInTheDocument();
  });

  // An old manifest is missing similarity, verdict, and connections by design.
  it("renders an old manifest without complaint", async () => {
    backendAnswers(200, readings.rd_FXPAST0001);
    await openTab("/readings/rd_FXPAST0001");

    expect(heading()).toBe(readings.rd_FXPAST0001.title);
    expect(screen.queryByText(/unclassified/i)).not.toBeInTheDocument();
  });
});

describe("pending and failed readings", () => {
  it("shows a pending reading's stage without inventing progress", async () => {
    backendAnswers(200, readings.rd_FXPENDNG01);
    await openTab("/readings/rd_FXPENDNG01");

    expect(screen.getByText("This reading is still being processed.")).toBeInTheDocument();
    expect(screen.getByText("Queued.")).toBeInTheDocument();
  });

  it("shows the failure category, the backend's message, and the stage", async () => {
    const failed = readings.rd_FXERR00001;
    backendAnswers(200, failed);
    await openTab("/readings/rd_FXERR00001");

    expect(screen.getByText("The page couldn't be fetched.")).toBeInTheDocument();
    expect(screen.getByText(failed.error!.message)).toBeInTheDocument();
    expect(screen.getByText("Stopped at: Fetching the page.")).toBeInTheDocument();
  });

  it("shows an unknown failure's message once, as its own headline", async () => {
    const failed = readings.rd_FXERR00008;
    backendAnswers(200, failed);
    await openTab("/readings/rd_FXERR00008");

    expect(screen.getAllByText(failed.error!.message)).toHaveLength(1);
  });

  // A failed manifest never got a title, so the heading is the URL it was
  // saved from — the reader still sees which reading this is.
  it("keeps the reading's own heading and metadata above the status", async () => {
    const failed = readings.rd_FXERR00001;
    backendAnswers(200, failed);
    await openTab("/readings/rd_FXERR00001");

    expect(failed.title).toBeUndefined();
    expect(heading()).toBe(failed.url);
    expect(screen.getByText("registration-wall.example")).toBeInTheDocument();
    expect(screen.getByLabelText("Processing status")).toBeInTheDocument();
  });
});

describe("states that replace the reading", () => {
  it("says a missing reading isn't in the library, and offers the way back", async () => {
    backendAnswers(404, { error: "not found" });
    await openTab(`/readings/${ATTENTION}`);

    expect(heading()).toBe("This reading isn't in your library.");
    expect(screen.getByRole("link", { name: "Back to library" })).toBeInTheDocument();
  });

  // A 403 is not a sign-out: the session and its cached identity stay put.
  it("shows permission denied without ending the session", async () => {
    backendAnswers(403, { error: "forbidden" });
    const { queryClient } = await openTab(`/readings/${ATTENTION}`);

    expect(heading()).toBe("You don't have access to this.");
    expect(queryClient.getQueryData(whoamiQueryKey)).toEqual(reader);
    expect(screen.queryByRole("heading", { name: "Your session ended." })).not.toBeInTheDocument();
  });

  it("asks for a reload when the tab is signed in to a different account", async () => {
    backendAnswers(412, { error: "expected tenant mismatch", acting_tenant: "usr_b" });
    await openTab(`/readings/${ATTENTION}`);

    expect(heading()).toBe("This tab is signed in to a different account than the page expects.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByText("Signed in as usr_b.")).toBeInTheDocument();
  });

  it("hands a 401 to the shell's expired-session page, at this URL", async () => {
    backendAnswers(401, { error: "unauthorized" });
    await openTab(`/readings/${ATTENTION}`);

    await headingSettles("Your session ended.");
    // The shell's account menu offers its own sign-in link once identity is
    // gone; this is the page's.
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      `/login?next=%2Freadings%2F${ATTENTION}`,
    );
  });

  // An errored query retries when the page mounts, so the backend keeps
  // failing until the reader asks again: what is asserted here is the state,
  // not a race with that retry.
  it("offers a retry after a server error, and takes the reader out of it", async () => {
    let failing = true;
    backend.reading.mockImplementation(async () =>
      failing ? { status: 502, body: { error: "upstream exploded" } } : { status: 200, body: readings[ATTENTION] },
    );
    await openTab(`/readings/${ATTENTION}`);
    await headingSettles("Something went wrong on our side.");
    expect(screen.getByText("upstream exploded")).toBeInTheDocument();

    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await headingSettles("A quieter internet is a choice we can make");
  });

  // The binding being down is the same retryable state, not a missing reading.
  it("shows the server-error state when the backend binding throws", async () => {
    backend.reading.mockImplementation(async () => {
      throw new Error("binding is down");
    });
    await openTab(`/readings/${ATTENTION}`);

    await headingSettles("Something went wrong on our side.");
  });
});

describe("the tenant pin", () => {
  it("pins the read to the account the page is being rendered for", async () => {
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);

    expect(backend.reading.mock.calls[0]![0]).toMatchObject({ id: ATTENTION, expectedTenant: "usr_a" });
  });

  // With the data-plane gate off the backend acts on the pre-tenant layout,
  // which is what the pin has to name (backend requireExpectedTenant).
  it("names the global layout when the account is not on the tenant data plane", async () => {
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`, { ...reader, tenant_data_plane: false });

    expect(backend.reading.mock.calls[0]![0]).toMatchObject({ expectedTenant: "global" });
  });

  it("forwards the cookie and host of the request being rendered", async () => {
    request.current = new Request("https://next.readinglite.ai/readings/x", {
      headers: { cookie: "__Host-session=abc" },
    });
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);

    expect(backend.reading.mock.calls[0]![0]).toMatchObject({
      cookie: "__Host-session=abc",
      host: "next.readinglite.ai",
    });
  });
});

describe("hydration and navigation", () => {
  // What the server render dehydrates into the page is what the browser shows:
  // asking again would waste the request and flash the page.
  it("renders the server's answer without reading it a second time", async () => {
    backendAnswers(200, readings[ATTENTION]);

    // The server render: its own QueryClient, through the same query.
    const server = createQueryClient(() => "/");
    server.setQueryData(whoamiQueryKey, reader);
    await server.prefetchQuery(readingQueryOptions(server, ATTENTION, reader));
    const dehydrated = JSON.parse(JSON.stringify(dehydrate(server)));
    expect(backend.reading).toHaveBeenCalledTimes(1);

    // The browser, hydrating that page.
    const tab = newTab(`/readings/${ATTENTION}`);
    hydrate(tab.queryClient, dehydrated);
    render(<RouterProvider router={tab.router} />);
    await screen.findByRole("heading", { level: 1, name: "A quieter internet is a choice we can make" });

    expect(backend.reading).toHaveBeenCalledTimes(1);
  });

  it("reuses the cached reading when the reader navigates back to it", async () => {
    backendServes({ [ATTENTION]: readings[ATTENTION] });
    const { router } = await openTab("/");
    expect(backend.reading).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("link", { name: "Open the reading" }));
    await screen.findByRole("heading", { level: 1, name: "A quieter internet is a choice we can make" });
    expect(backend.reading).toHaveBeenCalledTimes(1);

    await act(() => router.navigate({ to: "/" }));
    await screen.findByRole("heading", { level: 1, name: "Library" });
    await act(() => router.navigate({ to: "/readings/$id", params: { id: ATTENTION } }));
    await screen.findByRole("heading", { level: 1, name: "A quieter internet is a choice we can make" });

    expect(backend.reading).toHaveBeenCalledTimes(1);
  });

  it("keeps one reading's answer from standing in for another's", async () => {
    backendServes({ [ATTENTION]: readings[ATTENTION], rd_FXSPARSE01: readings.rd_FXSPARSE01 });
    const { queryClient } = await openTab(`/readings/${ATTENTION}`);
    await queryClient.prefetchQuery(readingQueryOptions(queryClient, "rd_FXSPARSE01", reader));

    expect(queryClient.getQueryData(readingQueryKey(ATTENTION))).toMatchObject({
      reading: { id: ATTENTION },
    });
    expect(queryClient.getQueryData(readingQueryKey("rd_FXSPARSE01"))).toMatchObject({
      reading: { id: "rd_FXSPARSE01" },
    });
  });
});
