import {
  cleanup,
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tokenStorageKey } from "./api";
import { App } from "./App";
import type { Manifest, ListReadingsResponse } from "./types";

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_ONE",
    url: "https://example.com/one",
    url_hash: "a".repeat(64),
    status: "ready",
    title: "Operator Notes",
    tldr: "A concise result from the reader agent.",
    tags: ["agents", "ops"],
    keywords: ["sqlite"],
    people: ["Ada"],
    orgs: ["Initech"],
    novelty_verdict: "novel",
    connections: [{ id: "rd_TWO", reason: "same operations theme" }],
    summary_markdown: "# Heading\n\nA detailed summary for operators.",
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 100,
    content_sha256: "0".repeat(64),
    created_at: "2026-04-25T16:00:00.000Z",
    updated_at: "2026-04-25T16:00:00.000Z",
    ...overrides
  };
}

const onePage: ListReadingsResponse = {
  readings: [manifest()],
  limit: 20,
  offset: 0,
  has_more: false
};

const emptyPage: ListReadingsResponse = {
  readings: [],
  limit: 20,
  offset: 0,
  has_more: false
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function stubJSON(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_request: Request) => jsonResponse(body, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
    stubJSON(onePage);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the reading library shell and list results", async () => {
    render(<App initialPath="/" />);

    expect(screen.getByRole("heading", { name: "Reading Library" })).toBeInTheDocument();
    expect(screen.getByText("Loading readings")).toBeInTheDocument();

    await waitForElementToBeRemoved(() => screen.queryByText("Loading readings"));

    expect(screen.getByRole("link", { name: "Operator Notes" })).toBeInTheDocument();
    expect(screen.getByText("A concise result from the reader agent.")).toBeInTheDocument();
    expect(screen.getByText("novel")).toBeInTheDocument();
    expect(screen.getByText("agents")).toBeInTheDocument();
  });

  it("shows the reading-lite brand", async () => {
    render(<App initialPath="/" />);
    await waitForElementToBeRemoved(() => screen.queryByText("Loading readings"));
    expect(screen.getByText("reading-lite")).toBeInTheDocument();
  });

  it("renders an empty state when no readings exist", async () => {
    stubJSON(emptyPage);
    render(<App initialPath="/" />);
    expect(await screen.findByText("No readings yet")).toBeInTheDocument();
  });

  it("renders a clear auth failure state", async () => {
    stubJSON({ error: "missing or invalid bearer token" }, 401);
    render(<App initialPath="/" />);
    expect(
      await screen.findByText("Authentication failed. Check your bearer token.")
    ).toBeInTheDocument();
  });

  it("persists a bearer token and sends it on authenticated requests", async () => {
    const fetchMock = stubJSON(emptyPage);
    const user = userEvent.setup();

    render(<App initialPath="/" />);
    expect(await screen.findByText("No readings yet")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Bearer token"), "secret-token");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(window.localStorage.getItem(tokenStorageKey)).toBe("secret-token");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const [request] = fetchMock.mock.calls[1] as [Request];
    expect(request.headers.get("Authorization")).toBe("Bearer secret-token");
  });

  it("renders reading detail fields (title, url, tldr, summary, entities)", async () => {
    stubJSON(manifest());
    render(<App initialPath="/readings/rd_ONE" />);

    expect(await screen.findByRole("heading", { name: "Operator Notes" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://example.com/one" })).toHaveAttribute(
      "href",
      "https://example.com/one"
    );
    expect(screen.getByText("A concise result from the reader agent.")).toBeInTheDocument();
    expect(screen.getByText(/A detailed summary for operators/)).toBeInTheDocument();
    expect(screen.getByText("sqlite")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    const orgSection = screen.getByRole("heading", { name: "Organizations" }).closest("section");
    expect(orgSection).not.toBeNull();
    expect(within(orgSection as HTMLElement).getByText("Initech")).toBeInTheDocument();
  });

  it("renders summary markdown as a rendered heading", async () => {
    stubJSON(manifest());
    render(<App initialPath="/readings/rd_ONE" />);
    expect(await screen.findByRole("heading", { name: "Heading" })).toBeInTheDocument();
  });

  it("renders the connections list with id and reason", async () => {
    stubJSON(manifest());
    render(<App initialPath="/readings/rd_ONE" />);
    const heading = await screen.findByRole("heading", { name: "Connections" });
    const panel = heading.closest("section") as HTMLElement;
    expect(within(panel).getByRole("link", { name: "rd_TWO" })).toHaveAttribute(
      "href",
      "/readings/rd_TWO"
    );
    expect(within(panel).getByText(/same operations theme/)).toBeInTheDocument();
  });

  it("renders an empty connections state when none exist", async () => {
    stubJSON(manifest({ connections: [] }));
    render(<App initialPath="/readings/rd_ONE" />);
    const heading = await screen.findByRole("heading", { name: "Connections" });
    const panel = heading.closest("section") as HTMLElement;
    expect(within(panel).getByText(/no connections/i)).toBeInTheDocument();
  });

  it("renders a status badge for pending readings on the list", async () => {
    stubJSON({
      ...onePage,
      readings: [manifest({ status: "pending", title: "Pending One", tldr: undefined })]
    });
    render(<App initialPath="/" />);
    await waitForElementToBeRemoved(() => screen.queryByText("Loading readings"));
    expect(screen.getByText(/processing/i)).toBeInTheDocument();
  });

  it("renders a failed badge with the error message on the list", async () => {
    stubJSON({
      ...onePage,
      readings: [
        manifest({
          status: "failed",
          title: "Bad One",
          tldr: undefined,
          error: { code: "BadStatusError", message: "404 from upstream" }
        })
      ]
    });
    render(<App initialPath="/" />);
    await waitForElementToBeRemoved(() => screen.queryByText("Loading readings"));
    expect(screen.getByText(/404 from upstream/i)).toBeInTheDocument();
  });

  it("submits a search query and refetches with q on the request URL", async () => {
    const fetchMock = vi.fn(async (_request: Request) => jsonResponse(onePage));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const initialUrl = new URL((fetchMock.mock.calls[0] as [Request])[0].url);
    expect(initialUrl.searchParams.get("q")).toBeNull();

    const searchInput = screen.getByLabelText("Search readings");
    await user.type(searchInput, "sqlite");
    await user.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const refetchUrl = new URL((fetchMock.mock.calls[1] as [Request])[0].url);
    expect(refetchUrl.searchParams.get("q")).toBe("sqlite");
  });

  it("hydrates the search input from the URL ?q= param", async () => {
    stubJSON(onePage);
    render(<App initialPath="/?q=cached" />);
    const input = (await screen.findByLabelText("Search readings")) as HTMLInputElement;
    expect(input.value).toBe("cached");
  });

  it("filters by clicking a tag chip and clears with the active-tag control", async () => {
    const fetchMock = vi.fn(async (_request: Request) => jsonResponse(onePage));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/" />);

    await user.click(await screen.findByRole("button", { name: "Filter by tag agents" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const tagUrl = new URL((fetchMock.mock.calls[1] as [Request])[0].url);
    expect(tagUrl.searchParams.get("tag")).toBe("agents");

    const clearTag = await screen.findByRole("button", { name: /clear tag agents/i });
    await user.click(clearTag);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const clearedUrl = new URL((fetchMock.mock.calls[2] as [Request])[0].url);
    expect(clearedUrl.searchParams.get("tag")).toBeNull();
  });

  it("submits a new URL via SubmitForm and invalidates the list", async () => {
    let pageBody: ListReadingsResponse = emptyPage;
    const fetchMock = vi.fn<(req: Request) => Promise<Response>>(async (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/readings") {
        pageBody = {
          ...emptyPage,
          readings: [manifest({ status: "pending", title: "New One", tldr: undefined })]
        };
        return jsonResponse({ id: "rd_NEW", status: "pending", poll: "/readings/rd_NEW" }, 202);
      }
      return jsonResponse(pageBody);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/" />);

    expect(await screen.findByText("No readings yet")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/submit a url/i), "https://example.com/new");
    await user.click(screen.getByRole("button", { name: /submit/i }));

    // POST request body matches.
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => (c[0] as Request).method === "POST"
      ) as [Request] | undefined;
      expect(post).toBeDefined();
    });
    const post = fetchMock.mock.calls.find(
      (c) => (c[0] as Request).method === "POST"
    ) as [Request];
    const body = (await post[0].clone().json()) as { url: string };
    expect(body.url).toBe("https://example.com/new");

    // List query refetched after invalidation.
    expect(await screen.findByRole("link", { name: "New One" })).toBeInTheDocument();
  });

  it("shows an inline error when SubmitForm fails", async () => {
    const fetchMock = vi.fn<(req: Request) => Promise<Response>>(async (req) => {
      if (req.method === "POST") {
        return jsonResponse({ error: "missing or invalid bearer token" }, 401);
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/" />);
    expect(await screen.findByText("No readings yet")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/submit a url/i), "https://example.com/x");
    await user.click(screen.getByRole("button", { name: /submit/i }));

    expect(
      await screen.findByText(/missing or invalid bearer token/i)
    ).toBeInTheDocument();
  });
});
