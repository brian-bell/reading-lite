import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { onlineManager } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { loginNextStorageKey } from "./login-return-path";
import { clearMagicLinkCredential } from "./magic-link-credential";
import type { ListReading, Manifest, ListReadingsResponse, ReadingDiagnostics } from "./types";

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

function listReading(overrides: Partial<ListReading> = {}): ListReading {
  return {
    id: "rd_ONE",
    key_prefix: "readings/2026/04/25T160000Z-rd_ONE",
    url: "https://example.com/one",
    status: "ready",
    title: "Operator Notes",
    tldr: "A concise result from the reader agent.",
    tags: ["agents", "ops"],
    novelty_verdict: "novel",
    created_at: "2026-04-25T16:00:00.000Z",
    updated_at: "2026-04-25T16:00:00.000Z",
    ...overrides
  };
}

function diagnostics(overrides: Partial<ReadingDiagnostics> = {}): ReadingDiagnostics {
  return {
    id: "rd_ONE",
    key_prefix: "readings/2026/04/25T160000Z-rd_ONE",
    manifest: manifest(),
    index_item: listReading(),
    pointers: {
      by_id: {
        exists: true,
        pointer: { id: "rd_ONE", key_prefix: "readings/2026/04/25T160000Z-rd_ONE" },
        matches_manifest: true
      },
      by_url: {
        exists: true,
        pointer: { id: "rd_ONE", key_prefix: "readings/2026/04/25T160000Z-rd_ONE" },
        matches_manifest: true
      }
    },
    objects: [
      { key: "readings/2026/04/25T160000Z-rd_ONE/manifest.json", size: 500 },
      { key: "readings/2026/04/25T160000Z-rd_ONE/raw.html", size: 100 }
    ],
    attempts: [
      {
        id: "at_ONE",
        trigger: "submit",
        status: "succeeded",
        stage: "write_indexes",
        started_at: "2026-04-25T16:00:00.000Z",
        finished_at: "2026-04-25T16:00:05.000Z",
        reading_id: "rd_ONE",
        url: "https://example.com/one",
        url_hash: "a".repeat(64),
        key_prefix: "readings/2026/04/25T160000Z-rd_ONE",
        events: [
          { stage: "queued", status: "started", at: "2026-04-25T16:00:00.000Z" },
          { stage: "fetch_source", status: "succeeded", at: "2026-04-25T16:00:01.000Z" }
        ]
      }
    ],
    ...overrides
  };
}

const onePage: ListReadingsResponse = {
  readings: [listReading()],
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

const sessionWhoami = {
  tenant_id: "usr_550e8400-e29b-41d4-a716-446655440000",
  user_id: "usr_550e8400-e29b-41d4-a716-446655440000",
  principal: "session" as const,
  tenant_data_plane: true,
  email: "reader@example.com",
  csrf_token: "ab".repeat(32)
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function stubJSON(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/whoami") {
      if (status === 401) return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse(sessionWhoami);
    }
    return jsonResponse(body, status);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    stubJSON(onePage);
  });

  afterEach(() => {
    cleanup();
    clearMagicLinkCredential();
    onlineManager.setOnline(true);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the reading library shell and list results", async () => {
    render(<App initialPath="/" />);

    expect(await screen.findByRole("heading", { name: "Reading Library" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Operator Notes" })).toBeInTheDocument();
    expect(screen.getByText("A concise result from the reader agent.")).toBeInTheDocument();
    expect(screen.getByText("novel")).toBeInTheDocument();
    expect(screen.getByText("agents")).toBeInTheDocument();
  });

  it("allows long reading titles to wrap within the list card", async () => {
    const longUrl =
      "https://open.substack.com/pub/thebackenddevelopers/p/graphql-federation-in-2026-contracts?utm_campaign=post&utm_medium=web";
    stubJSON({
      ...onePage,
      readings: [listReading({ title: "", url: longUrl })]
    });

    render(<App initialPath="/" />);

    const link = await screen.findByRole("link", { name: longUrl });
    expect(getComputedStyle(link).overflowWrap).toBe("anywhere");
  });

  it("shows the reading-lite brand", async () => {
    render(<App initialPath="/" />);
    expect(await screen.findByRole("heading", { name: "Reading Library" })).toBeInTheDocument();
    expect(screen.getByText("reading-lite")).toBeInTheDocument();
  });

  it("renders an empty state when no readings exist", async () => {
    stubJSON(emptyPage);
    render(<App initialPath="/" />);
    expect(await screen.findByText("No readings yet")).toBeInTheDocument();
  });

  it("renders a clear auth failure state", async () => {
    stubJSON({ error: "unauthorized" }, 401);
    render(<App initialPath="/" />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("treats a 403 whoami like signed-out instead of a load error", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "forbidden" }, 403);
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/" />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText("Could not load readings.")).not.toBeInTheDocument();
  });

  it("shows a retryable identity error when whoami fails with 5xx instead of the sign-in form", async () => {
    let whoamiOk = false;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        if (!whoamiOk) return jsonResponse({ error: "whoami unavailable" }, 500);
        return jsonResponse(sessionWhoami);
      }
      return jsonResponse(onePage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/" />);
    expect(await screen.findByText("whoami unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();

    whoamiOk = true;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Reading Library" })).toBeInTheDocument();
  });

  it("shows a retryable identity error on a reading route when whoami cannot be fetched", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "whoami unavailable" }, 500);
      return jsonResponse(manifest());
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/readings/rd_ONE" />);
    expect(await screen.findByText("whoami unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Operator Notes" })).not.toBeInTheDocument();
  });

  it("does not treat a paused whoami as signed-out on home", async () => {
    onlineManager.setOnline(false);
    render(<App initialPath="/" />);
    expect(await screen.findByText("Loading")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Reading Library" })).not.toBeInTheDocument();
  });

  it("does not treat a paused whoami as signed-out on a reading route", async () => {
    onlineManager.setOnline(false);
    render(<App initialPath="/readings/rd_ONE" />);
    expect(await screen.findByText("Loading")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Operator Notes" })).not.toBeInTheDocument();
  });

  it("shows a retryable identity error on /login when whoami fails with 5xx", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "whoami unavailable" }, 500);
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/login" />);
    expect(await screen.findByText("whoami unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("invalidates whoami when a cookie-authed list call returns 401 so the login gate runs", async () => {
    let whoamiCalls = 0;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        whoamiCalls += 1;
        if (whoamiCalls === 1) return jsonResponse(sessionWhoami);
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      if (url.pathname === "/api/readings") return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/" />);
    expect(await screen.findByText("reader@example.com")).toBeInTheDocument();
    expect(await screen.findByText("Sign in to continue.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText("reader@example.com")).not.toBeInTheDocument();
  });

  it("sends a 401 reading detail back through login with a return path", async () => {
    let whoamiCalls = 0;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        whoamiCalls += 1;
        if (whoamiCalls === 1) return jsonResponse(sessionWhoami);
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      if (url.pathname === "/api/readings/rd_ONE") return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/readings/rd_ONE" />);
    expect(await screen.findByText("reader@example.com")).toBeInTheDocument();
    expect(await screen.findByText("Sign in to continue.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    await waitFor(() => {
      expect(window.localStorage.getItem(loginNextStorageKey)).toBe("/readings/rd_ONE");
    });
    expect(window.sessionStorage.getItem(loginNextStorageKey)).toBeNull();
  });

  it("shows authenticated identity and logs out without storing bearer material", async () => {
    let signedOut = false;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        if (signedOut) return jsonResponse({ error: "unauthorized" }, 401);
        return jsonResponse(sessionWhoami);
      }
      if (url.pathname === "/api/auth/logout") {
        signedOut = true;
        return jsonResponse({ ok: true });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/" />);
    expect(await screen.findByText("reader@example.com")).toBeInTheDocument();
    expect(window.localStorage.getItem("reading-lite.bearerToken")).toBeNull();
    expect(window.sessionStorage.getItem("reading-lite.bearerToken")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() => {
      const logout = fetchMock.mock.calls.find((c) => {
        const req = c[0] as Request;
        return req.method === "POST" && new URL(req.url).pathname === "/api/auth/logout";
      });
      expect(logout).toBeDefined();
      expect((logout![0] as Request).credentials).toBe("include");
      expect((logout![0] as Request).headers.get("x-csrf-token")).toBe(sessionWhoami.csrf_token);
    });
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(window.localStorage.getItem("reading-lite.bearerToken")).toBeNull();
  });

  it("deletes a leftover pre-cutover bearer token on load without sending it", async () => {
    window.localStorage.setItem("reading-lite.bearerToken", "founder-secret");
    const fetchMock = stubJSON(onePage);
    render(<App initialPath="/" />);
    await waitFor(() => {
      expect(window.localStorage.getItem("reading-lite.bearerToken")).toBeNull();
    });
    expect(await screen.findByRole("heading", { name: "Reading Library" })).toBeInTheDocument();
    for (const call of fetchMock.mock.calls) {
      const req = call[0] as Request;
      expect(req.headers.get("Authorization")).toBeNull();
    }
  });

  it("clears identity and reading caches when logout returns 401", async () => {
    window.localStorage.setItem("reading-lite.bearerToken", "founder-secret");
    let signedOut = false;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        if (signedOut) return jsonResponse({ error: "unauthorized" }, 401);
        return jsonResponse(sessionWhoami);
      }
      if (url.pathname === "/api/auth/logout") {
        signedOut = true;
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      if (url.pathname === "/api/readings/rd_ONE") return jsonResponse(manifest());
      if (url.pathname === "/api/readings/rd_ONE/diagnostics") return jsonResponse(diagnostics());
      return jsonResponse(onePage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/readings/rd_ONE" />);
    expect(await screen.findByText("reader@example.com")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Operator Notes" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Operator Notes" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("reading-lite.bearerToken")).toBeNull();
  });

  it("requests a magic link from the sign-in form", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/auth/challenge") return jsonResponse({ ok: true });
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/login" />);
    await user.type(await screen.findByLabelText("Email"), "invited@example.com");
    await user.click(screen.getByRole("button", { name: "Email me a link" }));

    await waitFor(() => {
      const challenge = fetchMock.mock.calls.find((c) => {
        const req = c[0] as Request;
        return req.method === "POST" && new URL(req.url).pathname === "/api/auth/challenge";
      });
      expect(challenge).toBeDefined();
    });
    expect(await screen.findByText(/if that address can sign in/i)).toBeInTheDocument();
  });

  it("strips the magic-link fragment and only redeems after an explicit click", async () => {
    let signedIn = false;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        if (!signedIn) return jsonResponse({ error: "unauthorized" }, 401);
        return jsonResponse(sessionWhoami);
      }
      if (url.pathname === "/api/auth/redeem") {
        signedIn = true;
        return jsonResponse({ ok: true, ignored: "redeem-json-must-not-be-cached" });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const replaceState = vi.spyOn(window.history, "replaceState");

    render(<App initialPath="/auth/verify#ml_550e8400-e29b-41d4-a716-446655440000.deadbeef" />);

    const continueButton = await screen.findByRole("button", { name: "Continue" });
    expect(
      fetchMock.mock.calls.some((c) => new URL((c[0] as Request).url).pathname === "/api/auth/redeem")
    ).toBe(false);
    expect(replaceState).toHaveBeenCalled();

    await user.click(continueButton);
    await waitFor(() => {
      const redeem = fetchMock.mock.calls.find((c) => {
        const req = c[0] as Request;
        return req.method === "POST" && new URL(req.url).pathname === "/api/auth/redeem";
      });
      expect(redeem).toBeDefined();
    });
    const redeemReq = fetchMock.mock.calls.find((c) => {
      const req = c[0] as Request;
      return req.method === "POST" && new URL(req.url).pathname === "/api/auth/redeem";
    })![0] as Request;
    const body = (await redeemReq.clone().json()) as { credential: string; redemption_id: string };
    expect(body.credential).toBe("ml_550e8400-e29b-41d4-a716-446655440000.deadbeef");
    expect(body.redemption_id).toMatch(/^clm_/);
    await waitFor(() => {
      const whoamiAfter = fetchMock.mock.calls.filter((c) => {
        const req = c[0] as Request;
        return req.method === "GET" && new URL(req.url).pathname === "/api/whoami";
      });
      expect(whoamiAfter.length).toBeGreaterThan(1);
    });
    expect(await screen.findByText("reader@example.com")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Reading Library" })).toBeInTheDocument();
  });

  it("does not join an in-flight signed-out whoami after redeem", async () => {
    let signedIn = false;
    let whoamiStarted = 0;
    let releaseFirstWhoami: () => void = () => undefined;
    const firstWhoamiStarted = new Promise<void>((resolve) => {
      releaseFirstWhoami = resolve;
    });
    let holdFirstWhoami: (value: void) => void = () => undefined;
    const firstWhoamiHeld = new Promise<void>((resolve) => {
      holdFirstWhoami = resolve;
    });

    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        const sessionAtStart = signedIn;
        whoamiStarted += 1;
        if (whoamiStarted === 1) {
          releaseFirstWhoami();
          await firstWhoamiHeld;
        }
        if (!sessionAtStart) return jsonResponse({ error: "unauthorized" }, 401);
        return jsonResponse(sessionWhoami);
      }
      if (url.pathname === "/api/auth/redeem") {
        signedIn = true;
        return jsonResponse({ ok: true });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/auth/verify#ml_550e8400-e29b-41d4-a716-446655440000.deadbeef" />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await firstWhoamiStarted;

    const clicked = user.click(continueButton);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((c) => new URL((c[0] as Request).url).pathname === "/api/auth/redeem")
      ).toBe(true);
    });
    holdFirstWhoami();
    await clicked;

    expect(await screen.findByText("reader@example.com")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Reading Library" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("does not let a cancelled pre-redeem whoami wipe the CSRF token on the next mutation", async () => {
    let signedIn = false;
    let whoamiStarted = 0;
    let releaseFirstWhoami: () => void = () => undefined;
    const firstWhoamiStarted = new Promise<void>((resolve) => {
      releaseFirstWhoami = resolve;
    });
    let holdFirstWhoami: (value: void) => void = () => undefined;
    const firstWhoamiHeld = new Promise<void>((resolve) => {
      holdFirstWhoami = resolve;
    });

    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        const sessionAtStart = signedIn;
        whoamiStarted += 1;
        if (whoamiStarted === 1) {
          releaseFirstWhoami();
          await firstWhoamiHeld;
        }
        if (!sessionAtStart) return jsonResponse({ error: "unauthorized" }, 401);
        return jsonResponse(sessionWhoami);
      }
      if (url.pathname === "/api/auth/redeem") {
        signedIn = true;
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/readings") {
        return jsonResponse({ id: "rd_NEW", status: "pending", poll: "/api/readings/rd_NEW" }, 202);
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/auth/verify#ml_550e8400-e29b-41d4-a716-446655440000.deadbeef" />);
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    await firstWhoamiStarted;

    const clicked = user.click(continueButton);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((c) => new URL((c[0] as Request).url).pathname === "/api/auth/redeem")
      ).toBe(true);
    });
    expect(await screen.findByText("reader@example.com")).toBeInTheDocument();
    holdFirstWhoami();
    await clicked;

    await user.type(screen.getByLabelText(/submit a url/i), "https://example.com/new");
    await user.click(screen.getByRole("button", { name: /submit/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => {
        const req = c[0] as Request;
        return req.method === "POST" && new URL(req.url).pathname === "/api/readings";
      });
      expect(post).toBeDefined();
      expect((post![0] as Request).headers.get("x-csrf-token")).toBe(sessionWhoami.csrf_token);
    });
  });

  it("sends a signed-out reading route to login with a return path", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse(manifest());
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/readings/rd_ONE" />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    await waitFor(() => {
      expect(window.localStorage.getItem(loginNextStorageKey)).toBe("/readings/rd_ONE");
    });
    expect(window.sessionStorage.getItem(loginNextStorageKey)).toBeNull();
  });

  it("returns to the reading after Continue when next is a safe readings path", async () => {
    let signedIn = false;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        if (!signedIn) return jsonResponse({ error: "unauthorized" }, 401);
        return jsonResponse(sessionWhoami);
      }
      if (url.pathname === "/api/auth/redeem") {
        signedIn = true;
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/api/readings/rd_ONE") return jsonResponse(manifest());
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <App initialPath="/auth/verify?next=/readings/rd_ONE#ml_550e8400-e29b-41d4-a716-446655440000.deadbeef" />
    );
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Operator Notes" })).toBeInTheDocument();
    expect(window.localStorage.getItem(loginNextStorageKey)).toBeNull();
  });

  it("returns home after Continue when next is an open redirect", async () => {
    let signedIn = false;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        if (!signedIn) return jsonResponse({ error: "unauthorized" }, 401);
        return jsonResponse(sessionWhoami);
      }
      if (url.pathname === "/api/auth/redeem") {
        signedIn = true;
        return jsonResponse({ ok: true });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <App initialPath="/auth/verify?next=https://evil.example/phish#ml_550e8400-e29b-41d4-a716-446655440000.deadbeef" />
    );
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Reading Library" })).toBeInTheDocument();
  });

  it("returns to a localStorage next after a new-tab verify hop", async () => {
    let signedIn = false;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        if (!signedIn) return jsonResponse({ error: "unauthorized" }, 401);
        return jsonResponse(sessionWhoami);
      }
      if (url.pathname === "/api/auth/redeem") {
        signedIn = true;
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/api/readings/rd_ONE") return jsonResponse(manifest());
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    const firstTab = render(<App initialPath="/readings/rd_ONE" />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    await waitFor(() => {
      expect(window.localStorage.getItem(loginNextStorageKey)).toBe("/readings/rd_ONE");
    });
    expect(window.sessionStorage.getItem(loginNextStorageKey)).toBeNull();
    firstTab.unmount();

    render(<App initialPath="/auth/verify#ml_550e8400-e29b-41d4-a716-446655440000.deadbeef" />);
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Operator Notes" })).toBeInTheDocument();
    expect(window.localStorage.getItem(loginNextStorageKey)).toBeNull();
  });

  it("recovers the magic-link secret after remount once the hash is stripped", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(
      <App initialPath="/auth/verify#ml_550e8400-e29b-41d4-a716-446655440000.deadbeef" />
    );
    expect(await screen.findByRole("button", { name: "Continue" })).toBeInTheDocument();
    unmount();

    render(<App initialPath="/auth/verify" />);
    expect(await screen.findByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.queryByText(/missing its secret/i)).not.toBeInTheDocument();
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

  it("allows a long URL title to wrap within the detail header", async () => {
    const longUrl =
      "https://open.substack.com/pub/thebackenddevelopers/p/graphql-federation-in-2026-contracts?utm_campaign=post&utm_medium=web";
    stubJSON(manifest({ title: "", url: longUrl }));

    render(<App initialPath="/readings/rd_ONE" />);

    const heading = await screen.findByRole("heading", { name: longUrl });
    expect(getComputedStyle(heading).overflowWrap).toBe("anywhere");
    expect(getComputedStyle(heading.parentElement as HTMLElement).minWidth).toBe("0px");
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

  it("renders diagnostics from the diagnostics endpoint", async () => {
    const fetchMock = vi.fn<(req: Request) => Promise<Response>>(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/readings/rd_ONE") return jsonResponse(manifest());
      if (url.pathname === "/api/readings/rd_ONE/diagnostics") return jsonResponse(diagnostics());
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/readings/rd_ONE" />);

    const heading = await screen.findByRole("heading", { name: "Diagnostics" });
    const panel = heading.closest("section") as HTMLElement;
    expect(await within(panel).findByText("write indexes")).toBeInTheDocument();
    expect(within(panel).getByText("Objects")).toBeInTheDocument();
    expect(within(panel).getByText("2")).toBeInTheDocument();
  });

  it("posts reprocess from the detail page and refreshes reading data", async () => {
    const fetchMock = vi.fn<(req: Request) => Promise<Response>>(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (req.method === "POST" && url.pathname === "/api/readings/rd_ONE/reprocess") {
        return jsonResponse(
          { id: "rd_ONE", status: "ready", poll: "/api/readings/rd_ONE", attempt_id: "at_TWO" },
          202
        );
      }
      if (url.pathname === "/api/readings/rd_ONE") return jsonResponse(manifest());
      if (url.pathname === "/api/readings/rd_ONE/diagnostics") return jsonResponse(diagnostics());
      if (url.pathname === "/api/readings") return jsonResponse(onePage);
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/readings/rd_ONE" />);

    await user.click(await screen.findByRole("button", { name: "Reprocess" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => {
        const req = c[0] as Request;
        return req.method === "POST" && new URL(req.url).pathname === "/api/readings/rd_ONE/reprocess";
      });
      expect(post).toBeDefined();
      expect((post![0] as Request).headers.get("x-csrf-token")).toBe(sessionWhoami.csrf_token);
    });
  });

  it("renders a status badge for pending readings on the list", async () => {
    stubJSON({
      ...onePage,
      readings: [
        listReading({
          status: "pending",
          title: "Pending One",
          tldr: undefined,
          active_attempt: {
            id: "at_submit",
            trigger: "submit",
            status: "running",
            stage: "fetch_source",
            started_at: "2026-04-25T16:00:00.000Z"
          }
        })
      ]
    });
    render(<App initialPath="/" />);
    expect(await screen.findByText(/processing/i)).toBeInTheDocument();
    expect(screen.queryByText(/reprocessing/i)).not.toBeInTheDocument();
  });

  it("renders a failed badge with the error message on the list", async () => {
    stubJSON({
      ...onePage,
      readings: [
        listReading({
          status: "failed",
          title: "Bad One",
          tldr: undefined,
          error: { code: "BadStatusError", message: "404 from upstream" }
        })
      ]
    });
    render(<App initialPath="/" />);
    expect(await screen.findByText(/404 from upstream/i)).toBeInTheDocument();
  });

  it("renders the X recent-window error on the list", async () => {
    const message =
      "This X thread is older than the 7-day recent-search window and cannot be imported.";
    stubJSON({
      ...onePage,
      readings: [
        listReading({
          status: "failed",
          title: "Old X thread",
          tldr: undefined,
          error: { code: "XThreadOutsideRecentWindowError", message }
        })
      ]
    });
    render(<App initialPath="/" />);
    expect(
      await screen.findByText(
        (_text, element) =>
          element?.classList.contains("status-pill") === true &&
          element.textContent === `Failed: ${message}`
      )
    ).toBeInTheDocument();
  });

  it("renders the X recent-window error on reading detail", async () => {
    const message =
      "This X thread is older than the 7-day recent-search window and cannot be imported.";
    stubJSON(
      manifest({
        status: "failed",
        title: "Old X thread",
        tldr: undefined,
        error: { code: "XThreadOutsideRecentWindowError", message }
      })
    );

    render(<App initialPath="/readings/rd_ONE" />);

    expect(
      await screen.findByText(
        (_text, element) =>
          element?.classList.contains("status-pill") === true &&
          element.textContent === `Failed: ${message}`
      )
    ).toBeInTheDocument();
  });

  it("submits a search query and refetches with q on the request URL", async () => {
    const fetchMock = stubJSON(onePage);
    const user = userEvent.setup();

    render(<App initialPath="/" />);
    await screen.findByLabelText("Search readings");

    const searchInput = screen.getByLabelText("Search readings");
    await user.type(searchInput, "sqlite");
    await user.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      const qCall = fetchMock.mock.calls.find((c) => {
        const url = new URL((c[0] as Request).url);
        return url.pathname === "/api/readings" && url.searchParams.get("q") === "sqlite";
      });
      expect(qCall).toBeDefined();
    });
  });

  it("hydrates the search input from the URL ?q= param", async () => {
    stubJSON(onePage);
    render(<App initialPath="/?q=cached" />);
    const input = (await screen.findByLabelText("Search readings")) as HTMLInputElement;
    expect(input.value).toBe("cached");
  });

  it("filters by clicking a tag chip and clears with the active-tag control", async () => {
    const fetchMock = stubJSON(onePage);
    const user = userEvent.setup();

    render(<App initialPath="/" />);

    await user.click(await screen.findByRole("button", { name: "Filter by tag agents" }));

    await waitFor(() => {
      const tagCall = fetchMock.mock.calls.find((c) => {
        const url = new URL((c[0] as Request).url);
        return url.pathname === "/api/readings" && url.searchParams.get("tag") === "agents";
      });
      expect(tagCall).toBeDefined();
    });

    const clearTag = await screen.findByRole("button", { name: /clear tag agents/i });
    await user.click(clearTag);

    await waitFor(() => {
      const cleared = fetchMock.mock.calls.filter((c) => {
        const url = new URL((c[0] as Request).url);
        return url.pathname === "/api/readings";
      });
      const last = new URL((cleared.at(-1)![0] as Request).url);
      expect(last.searchParams.get("tag")).toBeNull();
    });
  });

  it("submits a new URL via SubmitForm and invalidates the list", async () => {
    let pageBody: ListReadingsResponse = emptyPage;
    const fetchMock = vi.fn<(req: Request) => Promise<Response>>(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (req.method === "POST" && url.pathname === "/api/readings") {
        pageBody = {
          ...emptyPage,
          readings: [listReading({ status: "pending", title: "New One", tldr: undefined })]
        };
        return jsonResponse({ id: "rd_NEW", status: "pending", poll: "/api/readings/rd_NEW" }, 202);
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
    expect(post[0].headers.get("x-csrf-token")).toBe(sessionWhoami.csrf_token);

    // List query refetched after invalidation.
    expect(await screen.findByRole("link", { name: "New One" })).toBeInTheDocument();
  });

  it("snaps a non-pageSize-aligned ?offset to the page boundary in the request and label", async () => {
    // Without snapping, ?offset=15 with pageSize=20 would label "Page 1" while
    // serving items 15–34. Snap to the nearest page boundary: offset=0, page 1.
    const fetchMock = stubJSON(onePage);
    render(<App initialPath="/?offset=15" />);

    await waitFor(() => {
      const readings = fetchMock.mock.calls.find((c) => {
        const url = new URL((c[0] as Request).url);
        return url.pathname === "/api/readings";
      });
      expect(readings).toBeDefined();
      expect(new URL((readings![0] as Request).url).searchParams.get("offset")).toBe("0");
    });
    expect(await screen.findByText("Page 1")).toBeInTheDocument();
  });

  it("opens extracted markdown via an authed fetch + blob URL (not a raw <a> with no Authorization)", async () => {
    const fetchMock = vi.fn<(req: Request) => Promise<Response>>(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/readings/rd_ONE") return jsonResponse(manifest());
      if (url.pathname === "/api/readings/rd_ONE/content") {
        return new Response("# md body", {
          status: 200,
          headers: { "Content-Type": "text/markdown; charset=utf-8" }
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:fake-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    const user = userEvent.setup();
    render(<App initialPath="/readings/rd_ONE" />);

    const btn = await screen.findByRole("button", { name: /extracted markdown/i });
    await user.click(btn);

    await waitFor(() => {
      const contentCall = fetchMock.mock.calls.find(
        (c) => new URL((c[0] as Request).url).pathname === "/api/readings/rd_ONE/content"
      );
      expect(contentCall).toBeDefined();
      expect((contentCall![0] as Request).credentials).toBe("include");
      expect((contentCall![0] as Request).headers.get("Authorization")).toBeNull();
    });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(openSpy).toHaveBeenCalledWith("blob:fake-url", "_blank", "noopener");
  });

  it("opens raw bytes via an authed fetch + blob URL", async () => {
    const fetchMock = vi.fn<(req: Request) => Promise<Response>>(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/readings/rd_ONE") return jsonResponse(manifest());
      if (url.pathname === "/api/readings/rd_ONE/content/raw") {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" }
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:raw-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    const user = userEvent.setup();
    render(<App initialPath="/readings/rd_ONE" />);

    const btn = await screen.findByRole("button", { name: /raw bytes/i });
    await user.click(btn);

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith("blob:raw-url", "_blank", "noopener"));
  });

  it("surfaces an inline error when ContentLinks fetch fails (no broken new tab)", async () => {
    const fetchMock = vi.fn<(req: Request) => Promise<Response>>(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/readings/rd_ONE") return jsonResponse(manifest());
      return jsonResponse({ error: "extracted markdown not available" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const openSpy = vi.fn(() => null);
    vi.stubGlobal("open", openSpy);

    const user = userEvent.setup();
    render(<App initialPath="/readings/rd_ONE" />);

    const btn = await screen.findByRole("button", { name: /extracted markdown/i });
    await user.click(btn);

    expect(await screen.findByText(/extracted markdown not available/i)).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("shows an inline error when SubmitForm fails", async () => {
    const fetchMock = vi.fn<(req: Request) => Promise<Response>>(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (req.method === "POST") {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/" />);
    expect(await screen.findByText("No readings yet")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/submit a url/i), "https://example.com/x");
    await user.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByText(/unauthorized/i)).toBeInTheDocument();
  });
});
