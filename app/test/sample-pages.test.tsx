import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SampleLibraryPage, SampleReadingPage } from "../src/components/SamplePages";
import { whoamiQueryKey, type Identity } from "../src/identity";
import { SAMPLE_READINGS } from "../src/samples";

// The public sample library (reading-lite-gh341.10): bundled readings, so
// neither page makes a request. The call to action follows the identity the
// shell reads (AppFrame), which these tests seed or leave unanswered.
vi.mock("@tanstack/react-start", async (importOriginal) =>
  (await import("./start-client-mock")).clientBranchOnly(importOriginal));

const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

let requested: string[];

beforeEach(() => {
  requested = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requested.push(new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname);
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderSamples(path: string, identity?: Identity | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (identity !== undefined) queryClient.setQueryData(whoamiQueryKey, identity);
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const samplesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/samples", component: SampleLibraryPage });
  const sampleRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/samples/$id",
    component: function SampleRoute() {
      const { id } = sampleRoute.useParams();
      return <SampleReadingPage id={id} />;
    },
  });
  const routes = [
    samplesRoute,
    sampleRoute,
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <h1>Library</h1> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/login", component: () => <h1>Sign in</h1> }),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { level: 1 });
  return router;
}

describe("sample library", () => {
  it("lists every sample, each linking to its page, with what it relates to", async () => {
    await renderSamples("/samples");
    expect(screen.getByRole("heading", { level: 1, name: "Sample library" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Sample readings" });
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(SAMPLE_READINGS.length);
    for (const reading of SAMPLE_READINGS) {
      expect(within(list).getByRole("link", { name: reading.title })).toHaveAttribute("href", `/samples/${reading.id}`);
    }
    expect(within(cards[0]).getByText("fieldnotes.example · 1 connection · 1 tension")).toBeInTheDocument();
  });

  it("offers sign-in to a signed-out reader", async () => {
    await renderSamples("/samples", null);
    const about = screen.getByRole("complementary", { name: "About the samples" });
    expect(within(about).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  });

  it("offers a signed-in reader their own library", async () => {
    await renderSamples("/samples/a-quieter-internet", reader);
    const about = screen.getByRole("complementary", { name: "About the samples" });
    expect(within(about).getByRole("link", { name: "Open your library" })).toHaveAttribute("href", "/");
    expect(within(about).queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(requested).toEqual([]);
  });
});

describe("sample reading", () => {
  it("renders the summary, novelty, and relationships without a request", async () => {
    await renderSamples("/samples/a-quieter-internet");
    expect(screen.getByRole("heading", { level: 1, name: "A quieter internet is a choice we can make" })).toBeInTheDocument();
    expect(screen.getByText("Sample reading")).toBeInTheDocument();
    expect(screen.getByText("TL;DR")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What this adds" })).toBeInTheDocument();
    const context = screen.getByRole("complementary", { name: "Connections & tensions" });
    expect(within(context).getByRole("link", { name: "Libraries are gardens, not warehouses" })).toHaveAttribute(
      "href",
      "/samples/libraries-are-gardens",
    );
    expect(within(context).getByRole("link", { name: "The case for a little friction" })).toHaveAttribute(
      "href",
      "/samples/the-case-for-a-little-friction",
    );
    expect(screen.getByRole("link", { name: "All samples" })).toHaveAttribute("href", "/samples");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(requested).toEqual([]);
  });

  it("offers nothing that writes, and tags that do not lead into a library", async () => {
    await renderSamples("/samples/a-quieter-internet");
    const tags = screen.getByRole("list", { name: "Tags" });
    expect(within(tags).getByText("attention")).toBeInTheDocument();
    expect(within(tags).queryByRole("link")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    // The only buttons on a reading page are Reprocess, Retry, Import a copy,
    // and the Source and Details controls; a sample has none of them.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("follows a connection to another sample, with the way back", async () => {
    const router = await renderSamples("/samples/a-quieter-internet");
    await userEvent.setup().click(screen.getByRole("link", { name: "Libraries are gardens, not warehouses" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Libraries are gardens, not warehouses" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/samples/libraries-are-gardens");
    const trail = screen.getByRole("navigation", { name: "Return trail" });
    expect(within(trail).getByText(/You followed a connection from/)).toBeInTheDocument();
    expect(within(trail).getByRole("button", { name: "Back to A quieter internet is a choice we can make" })).toBeInTheDocument();
  });

  it("says so when the link names no sample", async () => {
    await renderSamples("/samples/rd_FXATTENT01");
    expect(screen.getByRole("heading", { level: 1, name: "This sample doesn't exist." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All samples" })).toHaveAttribute("href", "/samples");
  });
});
