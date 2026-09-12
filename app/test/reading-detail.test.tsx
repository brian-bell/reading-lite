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
import { readingQueryKey, type ProcessingStage, type Reading } from "../src/reading";
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
