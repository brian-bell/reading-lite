import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { onlineManager } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { loginNextStorageKey, STEP_UP_LOGIN_HREF } from "./login-return-path";
import { clearMagicLinkCredential } from "./magic-link-credential";
import { resetTurnstileLoaderForTests, TURNSTILE_SCRIPT_SRC, type TurnstileRenderOptions } from "./turnstile";
import type {
  ApiTokenListItem,
  ListReading,
  Manifest,
  ListReadingsResponse,
  ReadingDiagnostics,
  UserSettingsResponse
} from "./types";

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

const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";

function installTurnstileMock(options?: { autoToken?: string }) {
  const renderWidget = vi.fn((_container: HTMLElement | string, opts: TurnstileRenderOptions) => {
    if (options?.autoToken && opts.callback) opts.callback(options.autoToken);
    return "widget-1";
  });
  window.turnstile = {
    render: renderWidget,
    reset: vi.fn(),
    remove: vi.fn()
  };
  return {
    renderWidget,
    complete(token: string) {
      const last = renderWidget.mock.calls.at(-1);
      last?.[1]?.callback?.(token);
    },
    expire() {
      const last = renderWidget.mock.calls.at(-1);
      last?.[1]?.["expired-callback"]?.();
    },
    fail(errorCode?: string) {
      const last = renderWidget.mock.calls.at(-1);
      last?.[1]?.["error-callback"]?.(errorCode);
    },
    timeout() {
      const last = renderWidget.mock.calls.at(-1);
      last?.[1]?.["timeout-callback"]?.();
    }
  };
}

function challengeCall(fetchMock: ReturnType<typeof vi.fn>): Request | undefined {
  const found = fetchMock.mock.calls.find((c) => {
    const req = c[0] as Request;
    return req.method === "POST" && new URL(req.url).pathname === "/api/auth/challenge";
  });
  return found ? (found[0] as Request) : undefined;
}

const ALL_SCOPES = ["readings:read", "readings:write", "readings:import", "readings:delete"] as const;
const mintedSecret = "tok_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa." + "ab".repeat(32);

function apiToken(overrides: Partial<ApiTokenListItem> = {}): ApiTokenListItem {
  return {
    id: "tok_11111111-1111-4111-8111-111111111111",
    name: "ops",
    format: "standard",
    scopes: [...ALL_SCOPES],
    created_at_ms: 1,
    expires_at_ms: 2,
    revoked_at_ms: null,
    last_used_at_ms: null,
    user_agent_label: "Firefox",
    usable: true,
    ...overrides
  };
}

function emptySessions() {
  return { sessions: [], session_cap_warning: null };
}

function defaultSettings(overrides: Partial<UserSettingsResponse> = {}): UserSettingsResponse {
  return {
    user_id: sessionWhoami.user_id,
    schema_version: 1,
    notify_immediate: true,
    digest_cadence: "off",
    time_zone: "UTC",
    digest_hour_local: 9,
    digest_weekday: 1,
    created_at_ms: 1,
    updated_at_ms: 2,
    ...overrides
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function stubJSON(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/login-options") {
      return jsonResponse({ turnstile_site_key: null });
    }
    if (url.pathname === "/api/whoami") {
      if (status === 401) return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse(sessionWhoami);
    }
    if (url.pathname === "/api/auth/sessions") {
      return jsonResponse({ sessions: [], session_cap_warning: null });
    }
    if (url.pathname === "/api/auth/tokens") {
      return jsonResponse({ tokens: [] });
    }
    if (url.pathname === "/api/auth/settings" && request.method === "GET") {
      return jsonResponse(defaultSettings());
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
    delete window.turnstile;
    resetTurnstileLoaderForTests();
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
      if (url.pathname === "/api/auth/login-options") return jsonResponse({ turnstile_site_key: null });
      if (url.pathname === "/api/auth/challenge") return jsonResponse({ ok: true });
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/login" />);
    await user.type(await screen.findByLabelText("Email"), "invited@example.com");
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Email me a link" }));

    const challenge = await waitFor(() => {
      const req = challengeCall(fetchMock);
      expect(req).toBeDefined();
      return req!;
    });
    expect(await challenge.clone().json()).toEqual({ email: "invited@example.com" });
    expect(await screen.findByText(/if that address can sign in/i)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Human check" })).not.toBeInTheDocument();
    const optionsReq = fetchMock.mock.calls
      .map((c) => c[0] as Request)
      .find((req) => new URL(req.url).pathname === "/api/auth/login-options");
    expect(optionsReq).toBeDefined();
    expect(optionsReq!.method).toBe("GET");
    expect(optionsReq!.credentials).toBe("include");
  });

  it("redirects a signed-in visitor away from /login unless step-up is requested", async () => {
    render(<App initialPath="/login" />);
    expect(await screen.findByRole("heading", { name: "Reading Library" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("shows the magic-link form for recent-auth step-up while a session is still valid", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/login-options") return jsonResponse({ turnstile_site_key: null });
      if (url.pathname === "/api/auth/challenge") return jsonResponse({ ok: true });
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens") return jsonResponse({ tokens: [] });
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath={STEP_UP_LOGIN_HREF} />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText("reader@example.com")).toBeInTheDocument();
    await waitFor(() => {
      expect(window.localStorage.getItem(loginNextStorageKey)).toBe("/account/security");
    });
    const emailField = screen.getByLabelText("Email");
    expect(emailField).toHaveValue("reader@example.com");
    expect(emailField).toHaveAttribute("readonly");
    expect(screen.queryByRole("group", { name: "Human check" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    expect(await screen.findByText(/if that address can sign in/i)).toBeInTheDocument();
    const challenge = challengeCall(fetchMock);
    expect(challenge).toBeDefined();
    expect(await challenge!.clone().json()).toEqual({ email: "reader@example.com" });
  });

  it("does not render a Turnstile widget when login-options returns a null site key", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/auth/login-options") return jsonResponse({ turnstile_site_key: null });
      if (url.pathname === "/api/auth/challenge") return jsonResponse({ ok: true });
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    installTurnstileMock();
    const user = userEvent.setup();

    render(<App initialPath="/login" />);
    await user.type(await screen.findByLabelText("Email"), "anyone@example.com");
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    expect(screen.queryByRole("group", { name: "Human check" })).not.toBeInTheDocument();
    expect(window.turnstile?.render).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    const challenge = await waitFor(() => {
      const req = challengeCall(fetchMock);
      expect(req).toBeDefined();
      return req!;
    });
    expect(await challenge.clone().json()).toEqual({ email: "anyone@example.com" });
  });

  it("shows the Turnstile widget for every email when login-options returns a site key", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/auth/login-options") {
        return jsonResponse({ turnstile_site_key: TURNSTILE_TEST_SITE_KEY });
      }
      if (url.pathname === "/api/auth/challenge") return jsonResponse({ ok: true });
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const turnstile = installTurnstileMock();
    const user = userEvent.setup();

    render(<App initialPath="/login" />);
    expect(await screen.findByRole("group", { name: "Human check" })).toBeInTheDocument();
    await waitFor(() => expect(turnstile.renderWidget).toHaveBeenCalled());
    expect(turnstile.renderWidget.mock.calls[0]![1]).toMatchObject({ sitekey: TURNSTILE_TEST_SITE_KEY });

    await user.type(screen.getByLabelText("Email"), "unknown@example.com");
    expect(screen.getByRole("group", { name: "Human check" })).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "reader@example.com");
    expect(screen.getByRole("group", { name: "Human check" })).toBeInTheDocument();
    expect(challengeCall(fetchMock)).toBeUndefined();
  });

  it("blocks sign-in and allows retry when login-options fails", async () => {
    let optionsOk = false;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/auth/login-options") {
        if (!optionsOk) return jsonResponse({ error: "failed to load sign-in options" }, 500);
        return jsonResponse({ turnstile_site_key: null });
      }
      if (url.pathname === "/api/auth/challenge") return jsonResponse({ ok: true });
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/login" />);
    await user.type(await screen.findByLabelText("Email"), "invited@example.com");
    expect(await screen.findByText("failed to load sign-in options")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email me a link" })).toBeDisabled();
    expect(screen.queryByRole("group", { name: "Human check" })).not.toBeInTheDocument();
    expect(screen.queryByText(/if that address can sign in/i)).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole("button", { name: "Email me a link" }).closest("form")!);
    expect(challengeCall(fetchMock)).toBeUndefined();

    optionsOk = true;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    expect(screen.queryByText("failed to load sign-in options")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    const challenge = await waitFor(() => {
      const req = challengeCall(fetchMock);
      expect(req).toBeDefined();
      return req!;
    });
    expect(await challenge.clone().json()).toEqual({ email: "invited@example.com" });
    expect(await screen.findByText(/if that address can sign in/i)).toBeInTheDocument();
  });

  it("blocks sign-in and allows retry when login-options is a malformed 200", async () => {
    let optionsOk = false;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/auth/login-options") {
        if (!optionsOk) return jsonResponse({});
        return jsonResponse({ turnstile_site_key: null });
      }
      if (url.pathname === "/api/auth/challenge") return jsonResponse({ ok: true });
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/login" />);
    await user.type(await screen.findByLabelText("Email"), "invited@example.com");
    expect(await screen.findByText("failed to load sign-in options")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email me a link" })).toBeDisabled();
    expect(screen.queryByRole("group", { name: "Human check" })).not.toBeInTheDocument();
    expect(screen.queryByText(/if that address can sign in/i)).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole("button", { name: "Email me a link" }).closest("form")!);
    expect(challengeCall(fetchMock)).toBeUndefined();

    optionsOk = true;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    expect(screen.queryByText("failed to load sign-in options")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    const challenge = await waitFor(() => {
      const req = challengeCall(fetchMock);
      expect(req).toBeDefined();
      return req!;
    });
    expect(await challenge.clone().json()).toEqual({ email: "invited@example.com" });
  });

  it("requires a Turnstile token before challenge when a site key is present", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/auth/login-options") {
        return jsonResponse({ turnstile_site_key: TURNSTILE_TEST_SITE_KEY });
      }
      if (url.pathname === "/api/auth/challenge") return jsonResponse({ ok: true });
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const turnstile = installTurnstileMock();
    const user = userEvent.setup();

    render(<App initialPath="/login" />);
    await user.type(await screen.findByLabelText("Email"), "invited@example.com");
    await waitFor(() => expect(turnstile.renderWidget).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Email me a link" })).toBeDisabled();
    expect(challengeCall(fetchMock)).toBeUndefined();

    act(() => {
      turnstile.complete("widget-ok");
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Email me a link" }));

    const challenge = await waitFor(() => {
      const req = challengeCall(fetchMock);
      expect(req).toBeDefined();
      return req!;
    });
    expect(await challenge.clone().json()).toEqual({
      email: "invited@example.com",
      turnstile_token: "widget-ok"
    });
    expect(await screen.findByText(/if that address can sign in/i)).toBeInTheDocument();
  });

  it("does not post a second challenge while the first request is in flight", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let challengeStarts = 0;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/auth/login-options") {
        return jsonResponse({ turnstile_site_key: TURNSTILE_TEST_SITE_KEY });
      }
      if (url.pathname === "/api/auth/challenge") {
        challengeStarts += 1;
        await held;
        if (challengeStarts === 1) return jsonResponse({ ok: true });
        return jsonResponse({ error: "failed to request sign-in link" }, 500);
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const turnstile = installTurnstileMock();
    const user = userEvent.setup();

    render(<App initialPath="/login" />);
    await user.type(await screen.findByLabelText("Email"), "invited@example.com");
    await waitFor(() => expect(turnstile.renderWidget).toHaveBeenCalled());
    act(() => {
      turnstile.complete("widget-ok");
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    const form = screen.getByRole("button", { name: "Email me a link" }).closest("form")!;
    const firstSubmit = user.click(screen.getByRole("button", { name: "Email me a link" }));
    await waitFor(() => expect(challengeStarts).toBe(1));
    expect(screen.getByRole("button", { name: "Email me a link" })).toBeDisabled();
    fireEvent.submit(form);
    expect(challengeStarts).toBe(1);
    release();
    await firstSubmit;
    expect(await screen.findByText(/if that address can sign in/i)).toBeInTheDocument();
    expect(screen.queryByText("failed to request sign-in link")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter((c) => new URL((c[0] as Request).url).pathname === "/api/auth/challenge")
    ).toHaveLength(1);
  });

  it("resets the Turnstile widget after a successful challenge so a resend cannot reuse the token", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/auth/login-options") {
        return jsonResponse({ turnstile_site_key: TURNSTILE_TEST_SITE_KEY });
      }
      if (url.pathname === "/api/auth/challenge") return jsonResponse({ ok: true });
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const turnstile = installTurnstileMock();
    const user = userEvent.setup();

    render(<App initialPath="/login" />);
    await user.type(await screen.findByLabelText("Email"), "invited@example.com");
    await waitFor(() => expect(turnstile.renderWidget).toHaveBeenCalledTimes(1));
    act(() => {
      turnstile.complete("widget-ok");
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    expect(await screen.findByText(/if that address can sign in/i)).toBeInTheDocument();
    await waitFor(() => expect(turnstile.renderWidget).toHaveBeenCalledTimes(2));
    expect(window.turnstile?.remove).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Email me a link" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    expect(
      fetchMock.mock.calls.filter((c) => new URL((c[0] as Request).url).pathname === "/api/auth/challenge")
    ).toHaveLength(1);

    act(() => {
      turnstile.complete("widget-ok-2");
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter((c) => new URL((c[0] as Request).url).pathname === "/api/auth/challenge")
      ).toHaveLength(2);
    });
    const bodies = await Promise.all(
      fetchMock.mock.calls
        .filter((c) => {
          const req = c[0] as Request;
          return req.method === "POST" && new URL(req.url).pathname === "/api/auth/challenge";
        })
        .map((c) => (c[0] as Request).clone().json())
    );
    expect(bodies).toEqual([
      { email: "invited@example.com", turnstile_token: "widget-ok" },
      { email: "invited@example.com", turnstile_token: "widget-ok-2" }
    ]);
    expect(screen.getByText(/if that address can sign in/i)).toBeInTheDocument();
  });

  it("resets the Turnstile widget after a failed challenge", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/auth/login-options") {
        return jsonResponse({ turnstile_site_key: TURNSTILE_TEST_SITE_KEY });
      }
      if (url.pathname === "/api/auth/challenge") {
        return jsonResponse({ error: "failed to request sign-in link" }, 500);
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const turnstile = installTurnstileMock();
    const user = userEvent.setup();

    render(<App initialPath="/login" />);
    await user.type(await screen.findByLabelText("Email"), "invited@example.com");
    await waitFor(() => expect(turnstile.renderWidget).toHaveBeenCalledTimes(1));
    act(() => {
      turnstile.complete("widget-bad");
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    expect(await screen.findByText("failed to request sign-in link")).toBeInTheDocument();
    expect(screen.queryByText(/if that address can sign in/i)).not.toBeInTheDocument();
    await waitFor(() => expect(turnstile.renderWidget).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Email me a link" })).toBeDisabled();
  });

  it("lets the user complete Turnstile again after the token expires", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/auth/login-options") {
        return jsonResponse({ turnstile_site_key: TURNSTILE_TEST_SITE_KEY });
      }
      if (url.pathname === "/api/auth/challenge") return jsonResponse({ ok: true });
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const turnstile = installTurnstileMock();
    const user = userEvent.setup();

    render(<App initialPath="/login" />);
    await user.type(await screen.findByLabelText("Email"), "invited@example.com");
    await waitFor(() => expect(turnstile.renderWidget).toHaveBeenCalledTimes(1));
    act(() => {
      turnstile.complete("widget-stale");
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    act(() => {
      turnstile.expire();
    });
    expect(window.turnstile?.reset).toHaveBeenCalledWith("widget-1");
    expect(screen.getByRole("button", { name: "Email me a link" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();

    act(() => {
      turnstile.complete("widget-fresh");
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    const challenge = await waitFor(() => {
      const req = challengeCall(fetchMock);
      expect(req).toBeDefined();
      return req!;
    });
    expect(await challenge.clone().json()).toEqual({
      email: "invited@example.com",
      turnstile_token: "widget-fresh"
    });
  });

  it("surfaces a Turnstile load error, blocks submit, and recovers on retry", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/auth/login-options") {
        return jsonResponse({ turnstile_site_key: TURNSTILE_TEST_SITE_KEY });
      }
      if (url.pathname === "/api/auth/challenge") return jsonResponse({ ok: true });
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/login" />);
    await user.type(await screen.findByLabelText("Email"), "invited@example.com");
    const failedScript = await waitFor(() => {
      const el = document.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
      expect(el).toBeInstanceOf(HTMLScriptElement);
      return el as HTMLScriptElement;
    });
    act(() => {
      failedScript.dispatchEvent(new Event("error"));
    });
    expect(await screen.findByText("Turnstile failed to load")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email me a link" })).toBeDisabled();
    expect(screen.queryByText(/if that address can sign in/i)).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole("button", { name: "Email me a link" }).closest("form")!);
    expect(challengeCall(fetchMock)).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByText("Turnstile failed to load")).not.toBeInTheDocument();
    const retryScript = await waitFor(() => {
      const el = document.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
      expect(el).toBeInstanceOf(HTMLScriptElement);
      return el as HTMLScriptElement;
    });
    const turnstile = installTurnstileMock();
    act(() => {
      retryScript.dispatchEvent(new Event("load"));
    });
    await waitFor(() => expect(turnstile.renderWidget).toHaveBeenCalled());
    act(() => {
      turnstile.complete("widget-ok");
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    const challenge = await waitFor(() => {
      const req = challengeCall(fetchMock);
      expect(req).toBeDefined();
      return req!;
    });
    expect(await challenge.clone().json()).toEqual({
      email: "invited@example.com",
      turnstile_token: "widget-ok"
    });
    expect(await screen.findByText(/if that address can sign in/i)).toBeInTheDocument();
  });

  it("surfaces a Turnstile widget error, blocks submit, and recovers on retry", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/auth/login-options") {
        return jsonResponse({ turnstile_site_key: TURNSTILE_TEST_SITE_KEY });
      }
      if (url.pathname === "/api/auth/challenge") return jsonResponse({ ok: true });
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const turnstile = installTurnstileMock();
    const user = userEvent.setup();

    render(<App initialPath="/login" />);
    await user.type(await screen.findByLabelText("Email"), "invited@example.com");
    await waitFor(() => expect(turnstile.renderWidget).toHaveBeenCalledTimes(1));
    act(() => {
      turnstile.fail("110200");
    });
    expect(await screen.findByText("Turnstile check failed (110200)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email me a link" })).toBeDisabled();
    expect(window.turnstile?.reset).not.toHaveBeenCalled();
    expect(screen.queryByText(/if that address can sign in/i)).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole("button", { name: "Email me a link" }).closest("form")!);
    expect(challengeCall(fetchMock)).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByText(/Turnstile check failed/)).not.toBeInTheDocument();
    await waitFor(() => expect(turnstile.renderWidget).toHaveBeenCalledTimes(2));
    act(() => {
      turnstile.complete("widget-ok");
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    const challenge = await waitFor(() => {
      const req = challengeCall(fetchMock);
      expect(req).toBeDefined();
      return req!;
    });
    expect(await challenge.clone().json()).toEqual({
      email: "invited@example.com",
      turnstile_token: "widget-ok"
    });
    expect(await screen.findByText(/if that address can sign in/i)).toBeInTheDocument();
  });

  it("sends a Turnstile token on step-up login when a site key is present", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/login-options") {
        return jsonResponse({ turnstile_site_key: TURNSTILE_TEST_SITE_KEY });
      }
      if (url.pathname === "/api/auth/challenge") return jsonResponse({ ok: true });
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens") return jsonResponse({ tokens: [] });
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const turnstile = installTurnstileMock({ autoToken: "step-up-token" });
    const user = userEvent.setup();

    render(<App initialPath={STEP_UP_LOGIN_HREF} />);
    expect(await screen.findByRole("group", { name: "Human check" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Email me a link" }));

    const challenge = await waitFor(() => {
      const req = challengeCall(fetchMock);
      expect(req).toBeDefined();
      return req!;
    });
    expect(await challenge.clone().json()).toEqual({
      email: "reader@example.com",
      turnstile_token: "step-up-token"
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

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Complete sign-in" })).not.toBeInTheDocument();
    });
    await user.type(await screen.findByLabelText(/submit a url/i), "https://example.com/new");
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

  it("returns to Security after Continue when next is the security path", async () => {
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
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens") return jsonResponse({ tokens: [] });
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <App initialPath="/auth/verify?next=/account/security#ml_550e8400-e29b-41d4-a716-446655440000.deadbeef" />
    );
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Complete sign-in" })).not.toBeInTheDocument();
    });
    expect(await screen.findByRole("heading", { name: "Security" })).toBeInTheDocument();
    expect(window.localStorage.getItem(loginNextStorageKey)).toBeNull();
  });

  it("does not keep the previous mailbox after redeeming while a session is live", async () => {
    const otherWhoami = {
      tenant_id: "usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      user_id: "usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      principal: "session" as const,
      tenant_data_plane: true,
      email: "other@example.com",
      csrf_token: "cd".repeat(32)
    };
    let mailbox: "a" | "b" = "a";
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        return jsonResponse(mailbox === "a" ? sessionWhoami : otherWhoami);
      }
      if (url.pathname === "/api/auth/redeem") {
        mailbox = "b";
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        if (mailbox === "a") {
          return jsonResponse({ tokens: [apiToken({ name: "prior-token" })] });
        }
        return jsonResponse({ tokens: [] });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <App initialPath="/auth/verify?next=/account/security#ml_550e8400-e29b-41d4-a716-446655440000.deadbeef" />
    );
    expect(await screen.findByText("reader@example.com")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText("other@example.com")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Security" })).toBeInTheDocument();
    expect(screen.queryByText("reader@example.com")).not.toBeInTheDocument();
    expect(screen.queryByText(/prior-token/)).not.toBeInTheDocument();
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

  it("tells the user to confirm email change from the requesting browser on 401", async () => {
    let redeemed = false;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/auth/redeem") {
        redeemed = true;
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <App initialPath="/auth/verify?purpose=email_change#ml_550e8400-e29b-41d4-a716-446655440000.deadbeef" />
    );
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("Open this link in the signed-in browser that requested the email change.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/failed to complete sign-in/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Reading Library" })).not.toBeInTheDocument();
    expect(redeemed).toBe(false);
  });

  it("tells the user to confirm email change from the requesting browser on 403", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/redeem") return jsonResponse({ error: "forbidden" }, 403);
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <App initialPath="/auth/verify?purpose=email_change#ml_550e8400-e29b-41d4-a716-446655440000.deadbeef" />
    );
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("Open this link in the signed-in browser that requested the email change.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/failed to complete sign-in/i)).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Complete sign-in" })).toBeInTheDocument();
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
    expect(within(panel).queryByText(/connections as of/i)).not.toBeInTheDocument();
  });

  it("renders the connection computation date when present", async () => {
    stubJSON(manifest({ connections_computed_at: "2026-08-31T12:00:00.000Z" }));
    render(<App initialPath="/readings/rd_ONE" />);
    const heading = await screen.findByRole("heading", { name: "Connections" });
    const panel = heading.closest("section") as HTMLElement;
    const time = within(panel).getByText(/aug 31, 2026/i);
    expect(time).toHaveAttribute("datetime", "2026-08-31T12:00:00.000Z");
    expect(within(panel).getByText(/connections as of/i)).toBeInTheDocument();
  });

  it("renders an empty connections state when none exist", async () => {
    stubJSON(manifest({ connections: [] }));
    render(<App initialPath="/readings/rd_ONE" />);
    const heading = await screen.findByRole("heading", { name: "Connections" });
    const panel = heading.closest("section") as HTMLElement;
    expect(within(panel).getByText(/no connections/i)).toBeInTheDocument();
  });

  it("renders a directional tension from this reading's point of view", async () => {
    stubJSON(
      manifest({
        tensions: [
          {
            id: "rd_TWO",
            kind: "superseded_by",
            reason: "rd_TWO reports the retraction",
            computed_at: "2026-08-31T12:00:00.000Z"
          }
        ]
      })
    );
    render(<App initialPath="/readings/rd_ONE" />);
    const heading = await screen.findByRole("heading", { name: "Tensions" });
    const panel = heading.closest("section") as HTMLElement;
    expect(within(panel).getByText("Superseded by")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "rd_TWO" })).toHaveAttribute(
      "href",
      "/readings/rd_TWO"
    );
    expect(within(panel).getByText(/reports the retraction/)).toBeInTheDocument();
    expect(within(panel).getByText(/aug 31, 2026/i)).toHaveAttribute(
      "datetime",
      "2026-08-31T12:00:00.000Z"
    );
  });

  it("renders the other side of the same pair with the inverse label", async () => {
    stubJSON(
      manifest({
        id: "rd_TWO",
        url: "https://example.com/two",
        tensions: [
          {
            id: "rd_ONE",
            kind: "supersedes",
            reason: "rd_TWO reports the retraction",
            computed_at: "2026-08-31T12:00:00.000Z"
          },
          {
            id: "rd_THREE",
            kind: "contradicts",
            reason: "opposing claims about caffeine",
            computed_at: "2026-08-31T12:00:00.000Z"
          }
        ]
      })
    );
    render(<App initialPath="/readings/rd_TWO" />);
    const heading = await screen.findByRole("heading", { name: "Tensions" });
    const panel = heading.closest("section") as HTMLElement;
    expect(within(panel).getByText("Supersedes")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "rd_ONE" })).toHaveAttribute(
      "href",
      "/readings/rd_ONE"
    );
    expect(within(panel).getByText("Contradicts")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "rd_THREE" })).toBeInTheDocument();
    expect(within(panel).getByText(/opposing claims/)).toBeInTheDocument();
  });

  it("renders an empty tensions state for readings without any", async () => {
    stubJSON(manifest());
    render(<App initialPath="/readings/rd_ONE" />);
    const heading = await screen.findByRole("heading", { name: "Tensions" });
    const panel = heading.closest("section") as HTMLElement;
    expect(within(panel).getByText(/no tensions/i)).toBeInTheDocument();
    expect(within(panel).queryByRole("link")).not.toBeInTheDocument();
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

  it("lists sessions from IdentityBar Security and shows the cap warning", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: [] });
      }
      if (url.pathname === "/api/auth/sessions") {
        return jsonResponse({
          sessions: [
            {
              id: "ses_11111111-1111-4111-8111-111111111111",
              current: true,
              created_at_ms: 1,
              authenticated_at_ms: 1,
              last_seen_at_ms: 1,
              idle_expires_at_ms: 2,
              absolute_expires_at_ms: 3,
              revoked_at_ms: null,
              revocation_reason: null,
              user_agent_label: "Firefox",
              usable: true
            }
          ],
          session_cap_warning: "This account is at the 10-session limit."
        });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/" />);
    await user.click(await screen.findByRole("link", { name: "Security" }));
    expect(await screen.findByRole("heading", { name: "Security" })).toBeInTheDocument();
    expect(await screen.findByText(/Firefox \(this device\)/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("10-session limit");
  });

  it("keeps expired sessions visible without a Revoke button", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: [] });
      }
      if (url.pathname === "/api/auth/sessions") {
        return jsonResponse({
          sessions: [
            {
              id: "ses_11111111-1111-4111-8111-111111111111",
              current: true,
              created_at_ms: 1,
              authenticated_at_ms: 1,
              last_seen_at_ms: 1,
              idle_expires_at_ms: 2,
              absolute_expires_at_ms: 3,
              revoked_at_ms: null,
              revocation_reason: null,
              user_agent_label: "Firefox",
              usable: true
            },
            {
              id: "ses_22222222-2222-4222-8222-222222222222",
              current: false,
              created_at_ms: 1,
              authenticated_at_ms: 1,
              last_seen_at_ms: 1,
              idle_expires_at_ms: 1,
              absolute_expires_at_ms: 3,
              revoked_at_ms: null,
              revocation_reason: null,
              user_agent_label: "Old laptop",
              usable: false
            },
            {
              id: "ses_33333333-3333-4333-8333-333333333333",
              current: false,
              created_at_ms: 1,
              authenticated_at_ms: 1,
              last_seen_at_ms: 1,
              idle_expires_at_ms: 2,
              absolute_expires_at_ms: 3,
              revoked_at_ms: 4,
              revocation_reason: "user",
              user_agent_label: "Phone",
              usable: false
            }
          ],
          session_cap_warning: null
        });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/account/security" />);
    expect(await screen.findByText(/Firefox \(this device\)/)).toBeInTheDocument();
    expect(screen.getByText(/Old laptop · expired/)).toBeInTheDocument();
    expect(screen.getByText(/Phone · revoked \(user\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke this device" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("revokes another session with CSRF and revoke-all signs out", async () => {
    let signedOut = false;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        if (signedOut) return jsonResponse({ error: "unauthorized" }, 401);
        return jsonResponse(sessionWhoami);
      }
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: [] });
      }
      if (url.pathname === "/api/auth/sessions" && request.method === "GET") {
        return jsonResponse({
          sessions: [
            {
              id: "ses_11111111-1111-4111-8111-111111111111",
              current: true,
              created_at_ms: 1,
              authenticated_at_ms: 1,
              last_seen_at_ms: 1,
              idle_expires_at_ms: 2,
              absolute_expires_at_ms: 3,
              revoked_at_ms: null,
              revocation_reason: null,
              user_agent_label: "Here",
              usable: true
            },
            {
              id: "ses_22222222-2222-4222-8222-222222222222",
              current: false,
              created_at_ms: 1,
              authenticated_at_ms: 1,
              last_seen_at_ms: 1,
              idle_expires_at_ms: 2,
              absolute_expires_at_ms: 3,
              revoked_at_ms: null,
              revocation_reason: null,
              user_agent_label: "Phone",
              usable: true
            }
          ],
          session_cap_warning: null
        });
      }
      if (url.pathname.endsWith("/ses_22222222-2222-4222-8222-222222222222") && request.method === "DELETE") {
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/api/auth/sessions/revoke-all") {
        signedOut = true;
        return jsonResponse({ ok: true });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();

    render(<App initialPath="/account/security" />);
    expect(await screen.findByText(/Phone/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => {
      const del = fetchMock.mock.calls.find((c) => {
        const req = c[0] as Request;
        return req.method === "DELETE";
      });
      expect(del).toBeDefined();
      expect((del![0] as Request).headers.get("x-csrf-token")).toBe(sessionWhoami.csrf_token);
    });

    await user.click(screen.getByRole("button", { name: "Revoke all sessions" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    const revokeAll = fetchMock.mock.calls.find((c) => {
      const req = c[0] as Request;
      return req.method === "POST" && new URL(req.url).pathname === "/api/auth/sessions/revoke-all";
    });
    expect(revokeAll).toBeDefined();
    expect((revokeAll![0] as Request).headers.get("x-csrf-token")).toBe(sessionWhoami.csrf_token);
  });

  it("does not show the previous account's sessions after logout then a later login", async () => {
    const otherWhoami = {
      tenant_id: "usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      user_id: "usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      principal: "session" as const,
      tenant_data_plane: true,
      email: "other@example.com",
      csrf_token: "cd".repeat(32)
    };
    let identity: "a" | "b" = "a";
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        if (identity === "a") return jsonResponse(sessionWhoami);
        return jsonResponse(otherWhoami);
      }
      if (url.pathname === "/api/auth/logout") {
        identity = "b";
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: [] });
      }
      if (url.pathname === "/api/auth/sessions" && request.method === "GET") {
        if (identity === "a") {
          return jsonResponse({
            sessions: [
              {
                id: "ses_11111111-1111-4111-8111-111111111111",
                current: true,
                created_at_ms: 1,
                authenticated_at_ms: 1,
                last_seen_at_ms: 1,
                idle_expires_at_ms: 2,
                absolute_expires_at_ms: 3,
                revoked_at_ms: null,
                revocation_reason: null,
                user_agent_label: "Firefox",
                usable: true
              }
            ],
            session_cap_warning: null
          });
        }
        return jsonResponse({ error: "failed to list sessions" }, 500);
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/account/security" />);
    expect(await screen.findByText(/Firefox \(this device\)/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByText("other@example.com")).toBeInTheDocument();
    expect(screen.queryByText(/Firefox/)).not.toBeInTheDocument();
    if (!screen.queryByRole("heading", { name: "Security" })) {
      await user.click(screen.getByRole("link", { name: "Security" }));
    }
    expect(await screen.findByText("failed to list sessions")).toBeInTheDocument();
    expect(screen.queryByText(/Firefox/)).not.toBeInTheDocument();
  });

  it("does not sign out when revoke-all returns 401", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: [] });
      }
      if (url.pathname === "/api/auth/sessions" && request.method === "GET") {
        return jsonResponse({
          sessions: [
            {
              id: "ses_11111111-1111-4111-8111-111111111111",
              current: true,
              created_at_ms: 1,
              authenticated_at_ms: 1,
              last_seen_at_ms: 1,
              idle_expires_at_ms: 2,
              absolute_expires_at_ms: 3,
              revoked_at_ms: null,
              revocation_reason: null,
              user_agent_label: "Firefox",
              usable: true
            }
          ],
          session_cap_warning: null
        });
      }
      if (url.pathname === "/api/auth/sessions/revoke-all") {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();

    render(<App initialPath="/account/security" />);
    expect(await screen.findByText(/Firefox \(this device\)/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke all sessions" }));

    expect(await screen.findByText("unauthorized")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Security" })).toBeInTheDocument();
    expect(screen.getByText("reader@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => new URL((c[0] as Request).url).pathname === "/api/auth/logout")).toBe(
      false
    );
  });

  it("requests an email change with CSRF and shows a generic ack", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: [] });
      }
      if (url.pathname === "/api/auth/sessions" && request.method === "GET") {
        return jsonResponse({ sessions: [], session_cap_warning: null });
      }
      if (url.pathname === "/api/auth/email-change") return jsonResponse({ ok: true });
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/account/security" />);
    expect(await screen.findByRole("heading", { name: "Change email" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("New email"), "new@example.com");
    await user.click(screen.getByRole("button", { name: "Send confirmation" }));
    expect(await screen.findByText(/if that address can be used/i)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find((c) => {
      const req = c[0] as Request;
      return req.method === "POST" && new URL(req.url).pathname === "/api/auth/email-change";
    });
    expect(post).toBeDefined();
    expect((post![0] as Request).headers.get("x-csrf-token")).toBe(sessionWhoami.csrf_token);
    expect(await (post![0] as Request).clone().json()).toEqual({ email: "new@example.com" });
  });

  it("asks for a fresh sign-in link when email change requires recent auth", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: [] });
      }
      if (url.pathname === "/api/auth/sessions" && request.method === "GET") {
        return jsonResponse({ sessions: [], session_cap_warning: null });
      }
      if (url.pathname === "/api/auth/email-change") {
        return jsonResponse({ error: "recent authentication required" }, 403);
      }
      if (url.pathname === "/api/auth/challenge") return jsonResponse({ ok: true });
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/account/security" />);
    await user.type(await screen.findByLabelText("New email"), "new@example.com");
    await user.click(screen.getByRole("button", { name: "Send confirmation" }));
    expect(await screen.findByRole("link", { name: "Request a fresh sign-in link" })).toHaveAttribute(
      "href",
      STEP_UP_LOGIN_HREF
    );
    expect(screen.getByText(/recent sign-in required/i)).toBeInTheDocument();
  });

  it("loads the immediate-email toggle from GET /api/auth/settings", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: [] });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/account/security" />);
    const toggle = await screen.findByLabelText("Email me when a reading is ready");
    expect(toggle).toBeChecked();
    expect(screen.getByRole("heading", { name: "Immediate email" })).toBeInTheDocument();
    expect(screen.getByText(/uncheck to opt out/i)).toBeInTheDocument();
    const get = fetchMock.mock.calls.find((c) => {
      const req = c[0] as Request;
      return req.method === "GET" && new URL(req.url).pathname === "/api/auth/settings";
    });
    expect(get).toBeDefined();
    expect((get![0] as Request).credentials).toBe("include");
    expect((get![0] as Request).headers.get("x-csrf-token")).toBeNull();
  });

  it("opts out by POSTing notify_immediate false with CSRF", async () => {
    let row = defaultSettings();
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(row);
      }
      if (url.pathname === "/api/auth/settings" && request.method === "POST") {
        row = { ...row, notify_immediate: false, updated_at_ms: 9 };
        return jsonResponse(row);
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: [] });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/account/security" />);
    const toggle = await screen.findByLabelText("Email me when a reading is ready");
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    const post = fetchMock.mock.calls.find((c) => {
      const req = c[0] as Request;
      return req.method === "POST" && new URL(req.url).pathname === "/api/auth/settings";
    });
    expect(post).toBeDefined();
    expect((post![0] as Request).headers.get("x-csrf-token")).toBe(sessionWhoami.csrf_token);
    expect(await (post![0] as Request).clone().json()).toEqual({ notify_immediate: false });
  });

  it("opts in by POSTing notify_immediate true with CSRF", async () => {
    let row = defaultSettings({ notify_immediate: false });
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(row);
      }
      if (url.pathname === "/api/auth/settings" && request.method === "POST") {
        row = { ...row, notify_immediate: true, updated_at_ms: 9 };
        return jsonResponse(row);
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: [] });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/account/security" />);
    const toggle = await screen.findByLabelText("Email me when a reading is ready");
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    const post = fetchMock.mock.calls.find((c) => {
      const req = c[0] as Request;
      return req.method === "POST" && new URL(req.url).pathname === "/api/auth/settings";
    });
    expect(post).toBeDefined();
    expect((post![0] as Request).headers.get("x-csrf-token")).toBe(sessionWhoami.csrf_token);
    expect(await (post![0] as Request).clone().json()).toEqual({ notify_immediate: true });
  });

  it("shows a POST 403 without asking for recent-auth step-up", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/settings" && request.method === "POST") {
        return jsonResponse({ error: "forbidden" }, 403);
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: [] });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/account/security" />);
    const toggle = await screen.findByLabelText("Email me when a reading is ready");
    await user.click(toggle);
    expect(await screen.findByText("forbidden")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Request a fresh sign-in link" })).not.toBeInTheDocument();
    expect(screen.queryByText(/recent sign-in required/i)).not.toBeInTheDocument();
    expect(toggle).toBeChecked();
  });

  it("hides the toggle when GET settings is 404", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse({ error: "not found" }, 404);
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: [] });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/account/security" />);
    expect(await screen.findByText("not found")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email me when a reading is ready")).not.toBeInTheDocument();
  });

  it("does not leak the previous account's notify_immediate after logout", async () => {
    const otherWhoami = {
      tenant_id: "usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      user_id: "usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      principal: "session" as const,
      tenant_data_plane: true,
      email: "other@example.com",
      csrf_token: "cd".repeat(32)
    };
    let identity: "a" | "b" = "a";
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        if (identity === "a") return jsonResponse(sessionWhoami);
        return jsonResponse(otherWhoami);
      }
      if (url.pathname === "/api/auth/logout") {
        identity = "b";
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        if (identity === "a") return jsonResponse(defaultSettings({ notify_immediate: false }));
        return jsonResponse(defaultSettings({ user_id: otherWhoami.user_id, notify_immediate: true }));
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: [] });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/account/security" />);
    expect(await screen.findByLabelText("Email me when a reading is ready")).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByText("other@example.com")).toBeInTheDocument();
    if (!screen.queryByRole("heading", { name: "Security" })) {
      await user.click(screen.getByRole("link", { name: "Security" }));
    }
    expect(await screen.findByLabelText("Email me when a reading is ready")).toBeChecked();
  });

  it("lists usable, expired, and revoked tokens and warns at the 10-token cap", async () => {
    const tokens = [
      apiToken({ name: "live", usable: true }),
      apiToken({
        id: "tok_22222222-2222-4222-8222-222222222222",
        name: "old",
        usable: false,
        expires_at_ms: 1
      }),
      apiToken({
        id: "tok_33333333-3333-4333-8333-333333333333",
        name: "dead",
        usable: false,
        revoked_at_ms: 4
      }),
      ...Array.from({ length: 9 }, (_, i) =>
        apiToken({
          id: `tok_44444444-4444-4444-8444-44444444444${i}`,
          name: `cap-${i}`,
          format: i === 0 ? "legacy" : "standard"
        })
      )
    ];
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/account/security" />);
    expect(await screen.findByText(/live \(standard\) · usable/)).toBeInTheDocument();
    const panel = screen.getByRole("region", { name: "API tokens" });
    expect(within(panel).getByText(/old \(standard\) · expired/)).toBeInTheDocument();
    expect(within(panel).getByText(/dead \(standard\) · revoked/)).toBeInTheDocument();
    expect(within(panel).getByText(/cap-0 \(legacy\) · usable/)).toBeInTheDocument();
    expect(screen.getByText(/10-token limit/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Create token" })).toBeDisabled();
    expect(within(panel).getByLabelText("Name")).toBeDisabled();
    expect(within(panel).getAllByRole("button", { name: "Revoke" })).toHaveLength(10);
    expect(within(panel).getByLabelText("readings:delete")).toBeChecked();
    expect(within(panel).getByLabelText("readings:read")).toBeChecked();
    expect(within(panel).getByLabelText("readings:write")).toBeChecked();
    expect(within(panel).getByLabelText("readings:import")).toBeChecked();
  });

  it("reveals a minted token once, copies it, and sends CSRF on create", async () => {
    let listed = [apiToken({ name: "legacy", format: "legacy" })];
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: listed });
      }
      if (url.pathname === "/api/auth/tokens" && request.method === "POST") {
        listed = [
          apiToken({
            id: "tok_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            name: "laptop"
          }),
          ...listed
        ];
        return jsonResponse(
          {
            token: mintedSecret,
            id: "tok_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            name: "laptop",
            scopes: [...ALL_SCOPES],
            created_at_ms: 1,
            expires_at_ms: 2
          },
          201
        );
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    const { unmount } = render(<App initialPath="/account/security" />);
    const panel = await screen.findByRole("region", { name: "API tokens" });
    await waitFor(() => expect(within(panel).getByLabelText("Name")).toBeEnabled());
    await user.type(within(panel).getByLabelText("Name"), "laptop");
    await user.click(within(panel).getByRole("button", { name: "Create token" }));
    expect(await screen.findByText(mintedSecret)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/will not be shown again/i);
    expect(screen.getByRole("status")).not.toHaveTextContent(mintedSecret);
    const post = fetchMock.mock.calls.find((c) => {
      const req = c[0] as Request;
      return req.method === "POST" && new URL(req.url).pathname === "/api/auth/tokens";
    });
    expect(post).toBeDefined();
    expect((post![0] as Request).headers.get("x-csrf-token")).toBe(sessionWhoami.csrf_token);
    expect(await (post![0] as Request).clone().json()).toEqual({
      name: "laptop",
      scopes: [...ALL_SCOPES]
    });
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(mintedSecret);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(mintedSecret)).not.toBeInTheDocument();
    expect(screen.queryByText(/will not be shown again/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();

    unmount();
    render(<App initialPath="/account/security" />);
    expect(await screen.findByText(/laptop \(standard\) · usable/)).toBeInTheDocument();
    expect(screen.queryByText(mintedSecret)).not.toBeInTheDocument();
    expect(screen.queryByText(/will not be shown again/i)).not.toBeInTheDocument();
  });

  it("revokes a token with CSRF", async () => {
    let listed = [apiToken()];
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: listed });
      }
      if (url.pathname === `/api/auth/tokens/${listed[0].id}` && request.method === "DELETE") {
        listed = [{ ...listed[0], usable: false, revoked_at_ms: 9 }];
        return jsonResponse({ ok: true });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/account/security" />);
    const panel = await screen.findByRole("region", { name: "API tokens" });
    await user.click(await within(panel).findByRole("button", { name: "Revoke" }));
    await waitFor(() => {
      expect(screen.getByText(/ops \(standard\) · revoked/)).toBeInTheDocument();
    });
    const del = fetchMock.mock.calls.find((c) => {
      const req = c[0] as Request;
      return req.method === "DELETE" && new URL(req.url).pathname.startsWith("/api/auth/tokens/");
    });
    expect(del).toBeDefined();
    expect((del![0] as Request).headers.get("x-csrf-token")).toBe(sessionWhoami.csrf_token);
    expect(within(panel).queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("enables create after revoke even if list refetch still reports the cap", async () => {
    const tokens = Array.from({ length: 10 }, (_, i) =>
      apiToken({
        id: `tok_55555555-5555-4555-8555-55555555555${i}`,
        name: `cap-${i}`
      })
    );
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens });
      }
      if (url.pathname.startsWith("/api/auth/tokens/") && request.method === "DELETE") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/account/security" />);
    expect(await screen.findByText(/10-token limit/)).toBeInTheDocument();
    const panel = screen.getByRole("region", { name: "API tokens" });
    expect(within(panel).getByRole("button", { name: "Create token" })).toBeDisabled();
    await user.click(within(panel).getAllByRole("button", { name: "Revoke" })[0]);
    await waitFor(() => {
      expect(within(panel).getByRole("button", { name: "Create token" })).toBeEnabled();
    });
    expect(screen.getByText(/cap-0 \(standard\) · revoked/)).toBeInTheDocument();
    expect(screen.queryByText(/10-token limit/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Readings" }));
    expect(await screen.findByRole("heading", { name: "Reading Library" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Security" }));
    expect(await screen.findByRole("heading", { name: "Security" })).toBeInTheDocument();
    const panelAgain = await screen.findByRole("region", { name: "API tokens" });
    expect(await within(panelAgain).findByText(/cap-0 \(standard\) · revoked/)).toBeInTheDocument();
    expect(within(panelAgain).getByRole("button", { name: "Create token" })).toBeEnabled();
    expect(screen.queryByText(/10-token limit/)).not.toBeInTheDocument();
  });

  it("asks for a fresh sign-in link when creating a token requires recent auth", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: [] });
      }
      if (url.pathname === "/api/auth/tokens" && request.method === "POST") {
        return jsonResponse({ error: "recent authentication required" }, 403);
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/account/security" />);
    const panel = await screen.findByRole("region", { name: "API tokens" });
    await waitFor(() => expect(within(panel).getByLabelText("Name")).toBeEnabled());
    await user.type(within(panel).getByLabelText("Name"), "ops");
    await user.click(within(panel).getByRole("button", { name: "Create token" }));
    expect(await screen.findByRole("link", { name: "Request a fresh sign-in link" })).toHaveAttribute(
      "href",
      STEP_UP_LOGIN_HREF
    );
    expect(screen.getByText(/recent sign-in required/i)).toBeInTheDocument();
  });

  it("rejects a past or over-max expiry before minting", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ tokens: [] });
      }
      if (url.pathname === "/api/auth/tokens" && request.method === "POST") {
        return jsonResponse({ error: "invalid body" }, 400);
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App initialPath="/account/security" />);
    const panel = await screen.findByRole("region", { name: "API tokens" });
    const expiry = within(panel).getByLabelText("Expires (optional)");
    expect(expiry).toHaveAttribute("min");
    expect(expiry).toHaveAttribute("max");
    await waitFor(() => expect(within(panel).getByLabelText("Name")).toBeEnabled());
    await user.type(within(panel).getByLabelText("Name"), "ops");

    fireEvent.change(expiry, { target: { value: "2000-01-01T00:00" } });
    fireEvent.submit(expiry.closest("form")!);
    expect(await screen.findByText("Expiry must be in the future.")).toBeInTheDocument();

    fireEvent.change(expiry, { target: { value: "2099-01-01T00:00" } });
    fireEvent.submit(expiry.closest("form")!);
    expect(await screen.findByText("Expiry cannot be more than 90 days from now.")).toBeInTheDocument();

    expect(
      fetchMock.mock.calls.some((c) => {
        const req = c[0] as Request;
        return req.method === "POST" && new URL(req.url).pathname === "/api/auth/tokens";
      })
    ).toBe(false);
  });

  it("keeps create disabled until the token list loads", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        await held;
        return jsonResponse({ tokens: [] });
      }
      if (url.pathname === "/api/auth/tokens" && request.method === "POST") {
        return jsonResponse({ error: "too many active tokens" }, 409);
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/account/security" />);
    const panel = await screen.findByRole("region", { name: "API tokens" });
    expect(await screen.findByText("Loading tokens")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Create token" })).toBeDisabled();
    expect(within(panel).getByLabelText("Name")).toBeDisabled();
    expect(
      fetchMock.mock.calls.some((c) => {
        const req = c[0] as Request;
        return req.method === "POST" && new URL(req.url).pathname === "/api/auth/tokens";
      })
    ).toBe(false);

    release();
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Create token" })).toBeEnabled());
    expect(screen.queryByText("Loading tokens")).not.toBeInTheDocument();
  });

  it("keeps create disabled when the token list fails to load", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(defaultSettings());
      }
      if (url.pathname === "/api/auth/sessions") return jsonResponse(emptySessions());
      if (url.pathname === "/api/auth/tokens" && request.method === "GET") {
        return jsonResponse({ error: "failed to list tokens" }, 500);
      }
      if (url.pathname === "/api/auth/tokens" && request.method === "POST") {
        return jsonResponse({ error: "too many active tokens" }, 409);
      }
      return jsonResponse(emptyPage);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/account/security" />);
    expect(await screen.findByText("failed to list tokens")).toBeInTheDocument();
    const panel = screen.getByRole("region", { name: "API tokens" });
    expect(within(panel).getByRole("button", { name: "Create token" })).toBeDisabled();
    fireEvent.submit(within(panel).getByRole("button", { name: "Create token" }).closest("form")!);
    expect(
      fetchMock.mock.calls.some((c) => {
        const req = c[0] as Request;
        return req.method === "POST" && new URL(req.url).pathname === "/api/auth/tokens";
      })
    ).toBe(false);
  });
});
