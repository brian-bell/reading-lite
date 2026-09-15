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
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import { requireSignedIn } from "../src/auth/guards";
import { createQueryClient, hrefOnScreen } from "../src/auth/session";
import { AppFrame } from "../src/components/AppFrame";
import { PageHeading } from "../src/components/PageHeading";
import { ReadingPage } from "../src/components/ReadingPage";
import { whoamiQueryKey, type Identity } from "../src/identity";
import { readingQueryKey, type ProcessingStage, type Reading } from "../src/reading";
import { readingQueryOptions } from "../src/reading-query";
import { readingViewOf, validateReadingSearch } from "../src/reading-view";
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

describe("the Summary view", () => {
  it("leads with the tldr and follows it with the summary", async () => {
    const reading = readings[ATTENTION]!;
    backendAnswers(200, reading);
    await openTab(`/readings/${ATTENTION}`);

    expect(screen.getByText(reading.tldr!)).toBeInTheDocument();
    expect(screen.getByText(/^Saving is only the beginning\./)).toBeInTheDocument();
  });

  // The summarizer opens summary_markdown with the tldr itself, so rendering
  // both verbatim would print the lead twice.
  it("prints the lead once", async () => {
    const reading = readings[ATTENTION]!;
    backendAnswers(200, reading);
    await openTab(`/readings/${ATTENTION}`);

    expect(screen.getAllByText(reading.tldr!)).toHaveLength(1);
  });

  it("renders the summary's Markdown rather than its source text", async () => {
    backendAnswers(200, {
      ...readings[ATTENTION],
      tldr: "The lead.",
      summary_markdown: "The lead.\n\nA point with **weight** and a [link](https://elsewhere.example/x).",
    });
    await openTab(`/readings/${ATTENTION}`);

    expect(screen.getByText("weight").tagName).toBe("STRONG");
    const link = screen.getByRole("link", { name: "link" });
    expect(link).toHaveAttribute("href", "https://elsewhere.example/x");
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  });

  // The captured page is untrusted and the summary is written from it, so
  // markup in a summary is text, never elements on this page.
  it("does not let markup in a summary reach the page", async () => {
    backendAnswers(200, {
      ...readings[ATTENTION],
      tldr: undefined,
      summary_markdown: '<img src="x" onerror="alert(1)"><script>alert(2)</script>\n\nThe argument.',
    });
    await openTab(`/readings/${ATTENTION}`);

    const prose = document.querySelector(".reading-prose")!;
    expect(prose.querySelector("img")).toBeNull();
    expect(prose.querySelector("script")).toBeNull();
    expect(screen.getByText("The argument.")).toBeInTheDocument();
  });

  // Design spec, Source content: remote images are never loaded on their own,
  // so an image host cannot learn what is being read. A Markdown image
  // survives the sanitizer, so the renderer has to refuse it — the summarizer
  // is asked for paragraphs, and an image in one is nothing the reader loses.
  it("never requests a remote image a summary asks for", async () => {
    backendAnswers(200, {
      ...readings[ATTENTION],
      tldr: undefined,
      summary_markdown: "![a tracking pixel](https://tracker.example/p.gif?id=1)\n\nThe argument.",
    });
    await openTab(`/readings/${ATTENTION}`);

    const prose = document.querySelector(".reading-prose")!;
    expect(prose.querySelector("img")).toBeNull();
    expect(prose.innerHTML).not.toContain("tracker.example");
    // The alt text survives, so nothing the writer said is lost.
    expect(screen.getByText("a tracking pixel")).toBeInTheDocument();
    expect(screen.getByText("The argument.")).toBeInTheDocument();
  });

  it("offers each tag as a link into the library filtered by it", async () => {
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);

    const tags = within(screen.getByRole("list", { name: "Tags" })).getAllByRole("link");
    expect(tags.map((tag) => tag.textContent)).toEqual(["attention", "design"]);
    expect(tags[0]).toHaveAttribute("href", "/?tag=attention");
  });

  it("shows no tag list for a reading that has none", async () => {
    backendAnswers(200, { ...readings[ATTENTION], tags: [] });
    await openTab(`/readings/${ATTENTION}`);

    expect(screen.queryByRole("list", { name: "Tags" })).not.toBeInTheDocument();
  });

  it("names what a degraded YouTube reading was missing", async () => {
    backendAnswers(200, readings.rd_FXYTDEGRD1);
    await openTab("/readings/rd_FXYTDEGRD1");

    expect(
      screen.getByText(
        "This video's transcript couldn't be read, so the summary is based on its title, channel, and description.",
      ),
    ).toBeInTheDocument();
  });

  it("says nothing about enrichment for a reading that was not degraded", async () => {
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);

    expect(screen.queryByText(/couldn't be read/)).not.toBeInTheDocument();
  });
});

describe("the novelty panel", () => {
  it("gives the verdict a label and its sentence", async () => {
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);

    const panel = screen.getByRole("region", { name: "What this adds" });
    expect(within(panel).getByText("Familiar")).toBeInTheDocument();
    expect(within(panel).getByText("Overlaps with readings already in your library.")).toBeInTheDocument();
  });

  // A library with nothing close to compare against is its own sentence: the
  // page must not imply a comparison it never made.
  it("says a sparse archive had nothing close to compare with", async () => {
    backendAnswers(200, readings.rd_FXSPARSE01);
    await openTab("/readings/rd_FXSPARSE01");

    const panel = screen.getByRole("region", { name: "What this adds" });
    expect(within(panel).getByText("Your library had no close readings when this was processed.")).toBeInTheDocument();
    expect(within(panel).queryByText("Nothing already in your library covers this closely.")).not.toBeInTheDocument();
  });

  it("omits the panel on a manifest with no verdict, and never says unclassified", async () => {
    backendAnswers(200, readings.rd_FXPAST0001);
    await openTab("/readings/rd_FXPAST0001");

    expect(screen.queryByRole("region", { name: "What this adds" })).not.toBeInTheDocument();
    expect(screen.queryByText(/unclassified/i)).not.toBeInTheDocument();
  });

  it("shows no novelty for a reading that is not ready", async () => {
    backendAnswers(200, readings.rd_FXPENDNG01);
    await openTab("/readings/rd_FXPENDNG01");

    expect(screen.queryByRole("region", { name: "What this adds" })).not.toBeInTheDocument();
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

// A reprocess of a ready reading keeps `status: "ready"` and adds a running
// active_attempt (backend `reprocessPending`), so status alone cannot answer
// "is something happening now?". The acceptance matrix puts this reading in the
// Pending row — status card at the top, prior ready content below.
describe("a ready reading being reprocessed", () => {
  /** What reprocessPending writes over a ready prior: spread, running attempt, new updated_at. */
  function reprocessing(reading: Reading, stage?: ProcessingStage): Reading {
    return {
      ...reading,
      active_attempt: {
        id: "at_FXREPROC01",
        trigger: "reprocess",
        status: "running",
        ...(stage === undefined ? {} : { stage }),
        started_at: "2026-09-12T08:00:00.000Z",
      },
      updated_at: "2026-09-12T08:00:00.000Z",
    };
  }

  it("shows the processing card even though the manifest still says ready", async () => {
    backendAnswers(200, reprocessing(readings[ATTENTION], "summarize"));
    await openTab(`/readings/${ATTENTION}`);

    expect(screen.getByLabelText("Processing status")).toBeInTheDocument();
    expect(screen.getByText("Summarizing.")).toBeInTheDocument();
  });

  // The reader is looking at the previous summary while this runs, so "still
  // being processed" would be a lie about what is on the page.
  it("says the reading is being processed again, not processed for the first time", async () => {
    backendAnswers(200, reprocessing(readings[ATTENTION]));
    await openTab(`/readings/${ATTENTION}`);

    expect(screen.getByText("This reading is being processed again.")).toBeInTheDocument();
    expect(screen.queryByText("This reading is still being processed.")).not.toBeInTheDocument();
  });

  it("keeps the reading's own heading and metadata above the status", async () => {
    backendAnswers(200, reprocessing(readings[ATTENTION]));
    await openTab(`/readings/${ATTENTION}`);

    expect(heading()).toBe(readings[ATTENTION].title);
    expect(screen.getByText("fieldnotes.example")).toBeInTheDocument();
  });

  it("leaves a ready reading whose last attempt finished without a status card", async () => {
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);

    expect(screen.queryByLabelText("Processing status")).not.toBeInTheDocument();
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

// Connections and tensions beside the reading (#371): cards from
// relationship_targets, the removed and non-ready states, and the phone jump.
describe("connections and tensions", () => {
  const GARDENS = "rd_FXGARDEN01";

  function context() {
    return screen.getByRole("complementary", { name: "Connections & tensions" });
  }

  it("titles and links connection cards from relationship_targets", async () => {
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);

    const connections = within(context()).getByRole("region", { name: "Connections" });
    const link = within(connections).getByRole("link", { name: "Libraries are gardens, not warehouses" });
    expect(link).toHaveAttribute("href", `/readings/${GARDENS}`);
    expect(within(connections).getByText("Computed 8 September 2026")).toBeInTheDocument();
    expect(within(connections).getByText(/Both treat revisiting as the work/)).toBeInTheDocument();
  });

  it("gives tension cards the danger rule and the kind label", async () => {
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);

    const tensions = within(context()).getByRole("region", { name: "Tensions" });
    expect(within(tensions).getByText("Contradicts")).toBeInTheDocument();
    const card = within(tensions).getByRole("link", { name: "The case for a little friction" }).closest("article");
    expect(card).toHaveClass("relationship-card-tension");
  });

  // Acceptance matrix, Removed target: dashed card, "Reading removed", the
  // reason kept, and nothing to follow.
  it("renders a removed target as a dashed card with its reason and no link", async () => {
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);

    const card = within(context()).getByText("Reading removed").closest("article")!;
    expect(card).toHaveClass("relationship-card-removed");
    expect(within(card).getByText(/has since been removed/)).toBeInTheDocument();
    expect(within(card).queryByRole("link")).not.toBeInTheDocument();
    expect(document.querySelector(`a[href="/readings/${pack.removed_target_id}"]`)).toBeNull();
  });

  // Acceptance matrix, Non-ready target: the card links, with a text badge.
  it("links pending and failed targets with a text status badge", async () => {
    backendAnswers(200, readings[GARDENS]);
    await openTab(`/readings/${GARDENS}`);

    const pending = within(context())
      .getByRole("link", { name: "https://fieldnotes.example/making-room-for-slow-work" })
      .closest("article")!;
    expect(within(pending).getByText("Processing")).toBeInTheDocument();
    const failed = within(context())
      .getByRole("link", { name: "https://consent-walls.example/teaser-article" })
      .closest("article")!;
    expect(within(failed).getByText("Failed")).toBeInTheDocument();
  });

  // Sparse archive: the novelty panel already says the library had nothing
  // close; there is no column to jump to.
  it("shows no context column or jump link when there is nothing to show", async () => {
    backendAnswers(200, readings.rd_FXSPARSE01);
    await openTab("/readings/rd_FXSPARSE01");

    expect(screen.queryByRole("complementary", { name: "Connections & tensions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connections & tensions" })).not.toBeInTheDocument();
  });

  it("links a Familiar verdict to the connections, and only then", async () => {
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);
    const panel = screen.getByRole("region", { name: "What this adds" });
    expect(within(panel).getByRole("link", { name: "See the connections" })).toBeInTheDocument();

    // Tensions alone are not connections: `friction` is Familiar with one
    // tension and no connections, so there is no Connections group to send
    // the reader to.
    cleanup();
    backendAnswers(200, readings.rd_FXFRICTN01);
    await openTab("/readings/rd_FXFRICTN01");
    expect(screen.getByRole("complementary", { name: "Connections & tensions" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "What this adds" })).queryByRole("link"),
    ).not.toBeInTheDocument();
  });

  // Design spec, Keyboard, focus, and motion: the jump moves focus to the
  // section heading and the return moves it back to the jump link. Neither
  // writes a hash into the URL.
  it("moves focus between the jump link and the context heading", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    backendAnswers(200, readings[ATTENTION]);
    const { router } = await openTab(`/readings/${ATTENTION}`);

    await userEvent.click(screen.getByRole("link", { name: "Connections & tensions" }));
    expect(screen.getByRole("heading", { level: 2, name: "Connections & tensions" })).toHaveFocus();
    expect(router.state.location.hash).toBe("");

    await userEvent.click(screen.getByRole("link", { name: "Back to the reading" }));
    expect(screen.getByRole("link", { name: "Connections & tensions" })).toHaveFocus();
    expect(router.state.location.hash).toBe("");
  });
});

// The return trail (#371; design spec, Routes and navigation state): following
// a relationship records where the reader came from and why, in history state.
describe("the return trail", () => {
  const GARDENS = "rd_FXGARDEN01";
  const FRICTION = "rd_FXFRICTN01";
  const ATTENTION_TITLE = "A quieter internet is a choice we can make";
  const GARDENS_TITLE = "Libraries are gardens, not warehouses";

  function trail() {
    return screen.queryByRole("navigation", { name: "Return trail" });
  }

  async function follow(name: string, heading: string) {
    await userEvent.click(screen.getByRole("link", { name }));
    await screen.findByRole("heading", { level: 1, name: heading });
  }

  beforeEach(() => {
    backendServes({
      [ATTENTION]: readings[ATTENTION],
      [GARDENS]: readings[GARDENS],
      [FRICTION]: readings[FRICTION],
    });
  });

  it("shows the previous title and reason after following a connection", async () => {
    await openTab(`/readings/${ATTENTION}`);
    expect(trail()).toBeNull();

    await follow(GARDENS_TITLE, GARDENS_TITLE);

    expect(within(trail()!).getByText(/You followed a connection from/)).toHaveTextContent(ATTENTION_TITLE);
    expect(within(trail()!).getByText(/Both treat revisiting as the work/)).toBeInTheDocument();
    expect(within(trail()!).getByRole("button", { name: `Back to ${ATTENTION_TITLE}` })).toBeInTheDocument();
  });

  it("names a tension as one", async () => {
    await openTab(`/readings/${ATTENTION}`);
    await follow("The case for a little friction", "The case for a little friction");

    expect(within(trail()!).getByText(/You followed a tension from/)).toHaveTextContent(ATTENTION_TITLE);
  });

  it("returns to the previous reading, which carries no trail of its own", async () => {
    await openTab(`/readings/${ATTENTION}`);
    await follow(GARDENS_TITLE, GARDENS_TITLE);

    await userEvent.click(within(trail()!).getByRole("button", { name: `Back to ${ATTENTION_TITLE}` }));
    await screen.findByRole("heading", { level: 1, name: ATTENTION_TITLE });

    expect(trail()).toBeNull();
  });

  // Several hops: each destination names the reading it was reached from, and
  // going back restores the trail that reading had.
  it("keeps one hop per reading across several hops, and browser Back restores each", async () => {
    const { router } = await openTab(`/readings/${ATTENTION}`);
    await follow(GARDENS_TITLE, GARDENS_TITLE);
    await follow(ATTENTION_TITLE, ATTENTION_TITLE);

    expect(within(trail()!).getByText(/You followed a connection from/)).toHaveTextContent(GARDENS_TITLE);
    expect(within(trail()!).getByText(/garden metaphor into a design principle/)).toBeInTheDocument();

    await act(() => router.history.back());
    await waitFor(() => expect(heading()).toBe(GARDENS_TITLE));
    expect(within(trail()!).getByText(/You followed a connection from/)).toHaveTextContent(ATTENTION_TITLE);

    await act(() => router.history.back());
    await waitFor(() => expect(heading()).toBe(ATTENTION_TITLE));
    expect(trail()).toBeNull();
  });

  it("keeps at most ten hops", async () => {
    const { router } = await openTab(`/readings/${ATTENTION}`);
    for (let hop = 0; hop < 12; hop += 1) {
      const toGardens = hop % 2 === 0;
      await follow(toGardens ? GARDENS_TITLE : ATTENTION_TITLE, toGardens ? GARDENS_TITLE : ATTENTION_TITLE);
    }

    expect(router.state.location.state.trail?.hops).toHaveLength(10);
    expect(within(trail()!).getByText(/You followed a connection from/)).toHaveTextContent(GARDENS_TITLE);
  });

  // A shared link or a reload arrives without a trail from this document
  // load. The reading renders; the trail does not.
  it("shows no trail on a direct link, nor for state another document load wrote", async () => {
    const { router } = await openTab(`/readings/${GARDENS}`);
    expect(trail()).toBeNull();

    await act(() =>
      router.navigate({
        to: "/readings/$id",
        params: { id: ATTENTION },
        state: {
          trail: {
            load: "a previous document load",
            hops: [{ id: GARDENS, title: GARDENS_TITLE, kind: "connection", reason: "stale" }],
          },
        },
      }),
    );
    await screen.findByRole("heading", { level: 1, name: ATTENTION_TITLE });
    expect(trail()).toBeNull();
  });

  // Acceptance matrix, Arrived from a removed target: the target was in the
  // map when the page rendered and gone by the time the reader followed it.
  it("explains a target that is gone on arrival, and offers the way back", async () => {
    const REMOVED = pack.removed_target_id;
    const attention = readings[ATTENTION]!;
    backendServes({
      [ATTENTION]: {
        ...attention,
        relationship_targets: {
          ...attention.relationship_targets,
          [REMOVED]: { url: "https://feeds.example/infinite", title: "Infinite feeds", status: "ready" },
        },
      },
    });
    await openTab(`/readings/${ATTENTION}`);
    await follow("Infinite feeds", "This reading isn't in your library.");

    expect(screen.getByText(/You followed a connection from/)).toHaveTextContent(ATTENTION_TITLE);
    expect(screen.getByText(/This earlier reading linked infinite feeds/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to library" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: `Back to ${ATTENTION_TITLE}` }));
    await screen.findByRole("heading", { level: 1, name: ATTENTION_TITLE });
  });

  it("offers only the library from a missing reading reached directly", async () => {
    backendAnswers(404, { error: "not found" });
    await openTab(`/readings/${ATTENTION}`);

    expect(screen.queryByText(/You followed/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Back to / })).not.toBeInTheDocument();
  });
});

// The Source view (#372; design spec: Source content; Routes and navigation
// state; Keyboard, focus, and motion). The reading comes from the server path
// as above; the source is the browser's own request, so `fetch` is stubbed
// with the content the backend would stream.
describe("the Source view", () => {
  const RAW_ONLY = "rd_FXRAWSRC01";
  const SOURCE = "# Somewhere to return\n\nOn a Sunday morning, I opened a folder.\n\n## From collection to conversation\n\nAn old idea meets a new question.";

  function markdownResponse(body: string, status = 200): Response {
    return new Response(body, { status, headers: { "content-type": "text/markdown; charset=utf-8" } });
  }

  /** The browser's /content endpoint answers with this, or per call. */
  function contentAnswers(...responses: (() => Response)[]) {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toMatch(/^\/api\/readings\/[^/]+\/content$/);
      const next = responses.length > 1 ? responses.shift()! : responses[0]!;
      return next();
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function tab(name: "Summary" | "Source") {
    return screen.getByRole("tab", { name });
  }

  function panel(name: "Summary" | "Source") {
    return screen.getByRole("tabpanel", { name });
  }

  async function selectSource() {
    await userEvent.click(tab("Source"));
    return panel("Source");
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers Summary and Source tabs on a ready reading, with Summary selected", async () => {
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);

    const list = screen.getByRole("tablist", { name: "View" });
    expect(within(list).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Summary", "Source"]);
    expect(tab("Summary")).toHaveAttribute("aria-selected", "true");
    expect(tab("Source")).toHaveAttribute("aria-selected", "false");
    expect(panel("Summary")).toHaveAttribute("tabindex", "0");
    expect(within(panel("Summary")).getByText(readings[ATTENTION]!.tldr!)).toBeInTheDocument();
  });

  it("shows no tabs on a pending or failed reading", async () => {
    backendServes({ rd_FXPENDNG01: readings.rd_FXPENDNG01, rd_FXERR00001: readings.rd_FXERR00001 });
    await openTab("/readings/rd_FXPENDNG01?view=source");
    expect(screen.queryByRole("tablist")).toBeNull();
    cleanup();
    await openTab("/readings/rd_FXERR00001");
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  // Design spec, Source content: fetched on demand, never during the server
  // render. Nothing asks for the source until the reader selects the view.
  it("requests the source only once Source is selected, pinned like the reading", async () => {
    const fetchMock = contentAnswers(() => markdownResponse(SOURCE));
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);
    expect(fetchMock).not.toHaveBeenCalled();

    const source = await selectSource();
    await within(source).findByText("On a Sunday morning, I opened a folder.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(new URL(request.url).pathname).toBe(`/api/readings/${ATTENTION}/content`);
    expect(request.headers.get("x-expected-tenant")).toBe("usr_a");
    expect(tab("Source")).toHaveAttribute("aria-selected", "true");
  });

  it("selects Source from a ?view=source deep link", async () => {
    contentAnswers(() => markdownResponse(SOURCE));
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}?view=source`);

    expect(tab("Source")).toHaveAttribute("aria-selected", "true");
    await within(panel("Source")).findByText("On a Sunday morning, I opened a folder.");
  });

  // Routes and navigation state: switching replaces the history entry, keeps
  // the reading's history state, and does not touch the hash.
  it("switches views by replacing the URL rather than adding history", async () => {
    contentAnswers(() => markdownResponse(SOURCE));
    backendAnswers(200, readings[ATTENTION]);
    const { router } = await openTab(`/readings/${ATTENTION}`);
    expect(router.history.canGoBack()).toBe(false);

    await selectSource();
    await waitFor(() => expect(router.state.location.search).toEqual({ view: "source" }));
    expect(router.history.canGoBack()).toBe(false);

    await userEvent.click(tab("Summary"));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(router.state.location.href).toBe(`/readings/${ATTENTION}`);
    expect(router.history.canGoBack()).toBe(false);
  });

  it("follows the ARIA tabs pattern from the keyboard", async () => {
    contentAnswers(() => markdownResponse(SOURCE));
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);
    tab("Summary").focus();
    expect(tab("Source")).toHaveAttribute("tabindex", "-1");

    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(tab("Source")).toHaveAttribute("aria-selected", "true"));
    expect(tab("Source")).toHaveFocus();
    expect(tab("Source")).toHaveAttribute("tabindex", "0");
    expect(tab("Summary")).toHaveAttribute("tabindex", "-1");

    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(tab("Summary")).toHaveAttribute("aria-selected", "true"));
    expect(tab("Summary")).toHaveFocus();

    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(tab("Source")).toHaveAttribute("aria-selected", "true"));

    await userEvent.keyboard("{Home}");
    await waitFor(() => expect(tab("Summary")).toHaveAttribute("aria-selected", "true"));
    expect(tab("Summary")).toHaveFocus();

    await userEvent.keyboard("{End}");
    await waitFor(() => expect(tab("Source")).toHaveAttribute("aria-selected", "true"));
    expect(tab("Source")).toHaveFocus();

    // The panel is a tab stop of its own, after the tabs.
    await userEvent.tab();
    expect(panel("Source")).toHaveFocus();
  });

  it("demotes source headings one level under the page title", async () => {
    contentAnswers(() => markdownResponse("# Top\n\n## Second\n\n###### Sixth\n\nText."));
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}?view=source`);

    const source = panel("Source");
    expect((await within(source).findByText("Top")).tagName).toBe("H2");
    expect(within(source).getByText("Second").tagName).toBe("H3");
    expect(within(source).getByText("Sixth").tagName).toBe("H6");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("never lets raw HTML from the captured page reach the DOM", async () => {
    contentAnswers(() =>
      markdownResponse('<img src="https://x.example/p.gif" onerror="alert(1)">\n\n<script>alert(2)</script>\n\nSafe text.'),
    );
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}?view=source`);

    const source = panel("Source");
    await within(source).findByText("Safe text.");
    expect(source.querySelector("img")).toBeNull();
    expect(source.querySelector("script")).toBeNull();
    expect(source.innerHTML).not.toContain("onerror");
  });

  // A captured page's site-relative links belong to its site, not to this host.
  it("resolves relative links against the captured page's URL", async () => {
    contentAnswers(() => markdownResponse("See [part two](/2026/part-2) and [the anchor](#notes)."));
    backendAnswers(200, { ...readings[ATTENTION], url: "https://fieldnotes.example/quiet/part-1" });
    await openTab(`/readings/${ATTENTION}?view=source`);

    const source = panel("Source");
    expect(await within(source).findByRole("link", { name: "part two" })).toHaveAttribute(
      "href",
      "https://fieldnotes.example/2026/part-2",
    );
    expect(within(source).getByRole("link", { name: "the anchor" })).toHaveAttribute(
      "href",
      "https://fieldnotes.example/quiet/part-1#notes",
    );
  });

  it("opens links in a new tab without a referrer, opener, or endorsement", async () => {
    contentAnswers(() => markdownResponse("See [elsewhere](https://elsewhere.example/x) and <javascript:alert(1)>."));
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}?view=source`);

    const link = await within(panel("Source")).findByRole("link", { name: "elsewhere" });
    expect(link).toHaveAttribute("href", "https://elsewhere.example/x");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    // The autolink's text survives; its href does not.
    const links = within(panel("Source")).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["https://elsewhere.example/x"]);
  });

  it("renders GFM tables and fenced code in their own containers", async () => {
    contentAnswers(() => markdownResponse("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```sh\necho hi\n```"));
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}?view=source`);

    const source = panel("Source");
    const table = await within(source).findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "a" })).toBeInTheDocument();
    expect(source.querySelector("pre > code")?.textContent).toBe("echo hi\n");
    // Each scrolls on its own, so each is reachable from the keyboard.
    expect(table).toHaveAttribute("tabindex", "0");
    expect(source.querySelector("pre")).toHaveAttribute("tabindex", "0");
  });

  // Design spec, Source content: a placeholder with the alt text and host, and
  // the image itself only on request, over https:, with no referrer.
  it("shows a remote image as its alt text and host until the reader loads it", async () => {
    contentAnswers(() => markdownResponse("![The desk on Friday](https://images.example/desk.jpg?w=800)\n\nText."));
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}?view=source`);

    const source = panel("Source");
    await within(source).findByText("The desk on Friday");
    expect(within(source).getByText("images.example")).toBeInTheDocument();
    expect(source.querySelector("img")).toBeNull();

    await userEvent.click(within(source).getByRole("button", { name: "Load image" }));
    const image = within(source).getByRole("img", { name: "The desk on Friday" });
    expect(image).toHaveAttribute("src", "https://images.example/desk.jpg?w=800");
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(within(source).queryByRole("button", { name: "Load image" })).toBeNull();
  });

  it("remembers a loaded image across a switch to Summary and back", async () => {
    contentAnswers(() => markdownResponse("![The desk](https://images.example/desk.jpg)\n\nText."));
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}?view=source`);
    await userEvent.click(await within(panel("Source")).findByRole("button", { name: "Load image" }));
    expect(within(panel("Source")).getByRole("img", { name: "The desk" })).toBeInTheDocument();

    await userEvent.click(tab("Summary"));
    await waitFor(() => expect(tab("Summary")).toHaveAttribute("aria-selected", "true"));
    await selectSource();
    expect(await within(panel("Source")).findByRole("img", { name: "The desk" })).toBeInTheDocument();
    expect(within(panel("Source")).queryByRole("button", { name: "Load image" })).toBeNull();
  });

  it("offers no load for http: or relative images", async () => {
    contentAnswers(() => markdownResponse("![Plain](http://images.example/a.png)\n\n![Local](/a.png)\n\nText."));
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}?view=source`);

    const source = panel("Source");
    await within(source).findByText("Plain");
    expect(within(source).getByText("images.example")).toBeInTheDocument();
    expect(within(source).getByText("Local")).toBeInTheDocument();
    expect(within(source).queryByRole("button", { name: "Load image" })).toBeNull();
    expect(source.querySelector("img")).toBeNull();
  });

  // Acceptance matrix, Source unavailable: `/content` 404s.
  it("says the source is unavailable on a 404 and keeps the rest of the reading", async () => {
    contentAnswers(() => Response.json({ error: "extracted markdown not available" }, { status: 404 }));
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}?view=source`);

    const source = panel("Source");
    await within(source).findByRole("heading", { level: 2, name: "Source text is unavailable" });
    expect(screen.getByRole("heading", { level: 2, name: "What this adds" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Connections & tensions" })).toBeInTheDocument();

    await userEvent.click(within(source).getByRole("button", { name: "Read summary" }));
    await waitFor(() => expect(tab("Summary")).toHaveAttribute("aria-selected", "true"));
    expect(tab("Summary")).toHaveFocus();
    expect(within(panel("Summary")).getByText(readings[ATTENTION]!.tldr!)).toBeInTheDocument();
  });

  // ... or `content_status` is not `captured`: then there is nothing to ask.
  it("says the source is unavailable without a request when the manifest already says so", async () => {
    const fetchMock = contentAnswers(() => markdownResponse("never"));
    backendAnswers(200, readings[RAW_ONLY]);
    await openTab(`/readings/${RAW_ONLY}?view=source`);

    expect(within(panel("Source")).getByRole("heading", { level: 2, name: "Source text is unavailable" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // 403 and 412 are not retryable; the view says what the reading's own pages
  // would say, without touching the reading, novelty, or relationships.
  it("shows the account-changed and forbidden states inside the view without a Retry", async () => {
    contentAnswers(() => Response.json({ error: "expected tenant mismatch", acting_tenant: "usr_b" }, { status: 412 }));
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}?view=source`);
    const source = panel("Source");
    await within(source).findByRole("button", { name: "Reload" });
    expect(within(source).getByText(/different account/)).toBeInTheDocument();
    expect(within(source).getByText("Signed in as usr_b.")).toBeInTheDocument();
    expect(within(source).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(heading()).toBe("A quieter internet is a choice we can make");
    cleanup();
    vi.unstubAllGlobals();

    contentAnswers(() => Response.json({ error: "forbidden" }, { status: 403 }));
    await openTab(`/readings/${ATTENTION}?view=source`);
    await within(panel("Source")).findByText(/don't have access/);
    expect(within(panel("Source")).queryByRole("button")).toBeNull();
  });

  it("shows a failure inside the view and retries from it", async () => {
    contentAnswers(
      () => Response.json({ error: "storage unavailable" }, { status: 503 }),
      () => markdownResponse(SOURCE),
    );
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}?view=source`);

    const source = panel("Source");
    await within(source).findByText(/storage unavailable/);
    expect(heading()).toBe("A quieter internet is a choice we can make");

    await userEvent.click(within(source).getByRole("button", { name: "Retry" }));
    await within(source).findByText("On a Sunday morning, I opened a folder.");
  });

  it("keeps the novelty panel below either view", async () => {
    contentAnswers(() => markdownResponse(SOURCE));
    backendAnswers(200, readings[ATTENTION]);
    await openTab(`/readings/${ATTENTION}`);
    const novelty = () => screen.getByRole("region", { name: "What this adds" });
    expect(novelty()).toBeInTheDocument();
    expect(panel("Summary").contains(novelty())).toBe(false);

    await selectSource();
    await within(panel("Source")).findByText("On a Sunday morning, I opened a folder.");
    expect(novelty()).toBeInTheDocument();
    expect(panel("Source").contains(novelty())).toBe(false);
  });
});
