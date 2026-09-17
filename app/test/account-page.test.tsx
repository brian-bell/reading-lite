import { QueryClientProvider, onlineManager } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "../src/api/client";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";
import { requireSignedIn } from "../src/auth/guards";
import { createQueryClient, hrefOnScreen } from "../src/auth/session";
import { AccountPage } from "../src/components/AccountPage";
import { AppFrame } from "../src/components/AppFrame";
import { PageHeading } from "../src/components/PageHeading";
import { SignInPage } from "../src/components/SignInPage";
import { whoamiQueryKey, type Identity } from "../src/identity";
import type { RouterContext } from "../src/router";
import { plainSearch } from "../src/search";
import type { SessionListItem } from "../src/sessions";

// Session management on /account/security (#340.1): list, revoke one, revoke
// all, including this device, and the acceptance matrix's common states. The
// browser's own /api/auth/sessions calls are a stubbed fetch; identity is
// seeded like the save page.

const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

const session = (over: Partial<SessionListItem> = {}): SessionListItem => ({
  id: "ses_here",
  current: false,
  authenticated_at_ms: 1,
  last_seen_at_ms: 2,
  revoked_at_ms: null,
  revocation_reason: null,
  user_agent_label: "Firefox",
  usable: true,
  ...over,
});

const HERE = session({ id: "ses_here", current: true, user_agent_label: "Firefox" });
const PHONE = session({ id: "ses_phone", user_agent_label: "Phone" });
const EXPIRED = session({
  id: "ses_old",
  user_agent_label: "Old laptop",
  usable: false,
});
const REVOKED = session({
  id: "ses_gone",
  user_agent_label: "Phone",
  usable: false,
  revoked_at_ms: 4,
  revocation_reason: "user",
});

const listed = {
  sessions: [HERE, PHONE],
  session_cap_warning: null as string | null,
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
const accountRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/account/security",
  component: AccountPage,
});
const routeTree = rootRoute.addChildren([indexRoute, loginRoute, authedRoute.addChildren([accountRoute])]);

function asRequest(input: RequestInfo | URL): Request {
  return input instanceof Request ? input : new Request(String(input));
}

function mockApi(options?: {
  listed?: unknown;
  listStatus?: number;
  whoami?: Identity | null;
  onDelete?: (id: string) => Response;
  onRevokeAll?: () => Response;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const request = asRequest(input);
    const path = new URL(request.url).pathname;
    if (path === "/api/whoami") {
      if (options?.whoami === null) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json(options?.whoami ?? reader);
    }
    if (path === "/api/auth/login-options") {
      return Response.json({ turnstile_site_key: null });
    }
    if (path === "/api/auth/sessions" && request.method === "GET") {
      return Response.json(options?.listed ?? listed, { status: options?.listStatus ?? 200 });
    }
    if (path === "/api/auth/sessions/revoke-all" && request.method === "POST") {
      return options?.onRevokeAll?.() ?? Response.json({ ok: true });
    }
    if (request.method === "DELETE" && path.startsWith("/api/auth/sessions/")) {
      const id = decodeURIComponent(path.slice("/api/auth/sessions/".length));
      return options?.onDelete?.(id) ?? Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestsOf(fetchMock: ReturnType<typeof vi.fn>, method: string, path = ""): Request[] {
  return fetchMock.mock.calls
    .map((call) => asRequest(call[0] as RequestInfo | URL))
    .filter((request) => request.method === method && new URL(request.url).pathname.includes(path));
}

async function openAccount(identity: Identity | null = reader) {
  const queryClient = createQueryClient(() => hrefOnScreen(router));
  queryClient.setQueryData(whoamiQueryKey, identity);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    ...plainSearch,
    history: createMemoryHistory({ initialEntries: ["/account/security"] }),
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.status).toBe("idle"));
  await screen.findByRole("heading", { level: 1 });
  return { router, queryClient };
}

function dialog() {
  return screen.queryByRole("dialog", { name: "Revoke all browser sessions?" });
}

beforeEach(() => {
  onlineManager.setOnline(true);
});

afterEach(() => {
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
  cleanup();
});

describe("the account page", () => {
  it("sends a signed-out reader to sign in and back", async () => {
    mockApi();
    const { router } = await openAccount(null);

    expect(router.state.location.href).toBe("/login?next=%2Faccount%2Fsecurity");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sign in");
  });

  it("lists sessions, names this device, and shows the cap warning", async () => {
    mockApi({
      listed: {
        sessions: [HERE, PHONE],
        session_cap_warning: "This account is at the 10-session limit.",
      },
    });
    await openAccount();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Account");
    expect(await screen.findByText("Firefox (this device)")).toBeVisible();
    expect(screen.getByText("Phone")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("10-session limit");
    expect(screen.getByRole("button", { name: "Revoke this device" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });

  it("keeps expired sessions visible without a Revoke button", async () => {
    mockApi({ listed: { sessions: [HERE, EXPIRED, REVOKED], session_cap_warning: null } });
    await openAccount();

    expect(await screen.findByText("Firefox (this device)")).toBeVisible();
    expect(screen.getByText("Old laptop · expired")).toBeVisible();
    expect(screen.getByText("Phone · revoked (user)")).toBeVisible();
    expect(screen.getByRole("button", { name: "Revoke this device" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("revokes another session with CSRF and the tenant pin, then refreshes the list", async () => {
    let sessions = [HERE, PHONE];
    const fetchMock = mockApi({
      listed: {
        get sessions() {
          return sessions;
        },
        session_cap_warning: null,
      },
      onDelete: (id) => {
        sessions = sessions.filter((row) => row.id !== id);
        return Response.json({ ok: true });
      },
    });
    await openAccount();
    expect(await screen.findByText("Phone")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(screen.queryByText("Phone")).not.toBeInTheDocument());
    const del = requestsOf(fetchMock, "DELETE", "/api/auth/sessions/")[0]!;
    expect(new URL(del.url).pathname).toBe("/api/auth/sessions/ses_phone");
    expect(del.headers.get(CSRF_HEADER)).toBe(reader.csrf_token);
    expect(del.headers.get(EXPECTED_TENANT_HEADER)).toBe(reader.tenant_id);
  });

  it("revoking this device signs the reader out and sends them to sign in", async () => {
    mockApi({ listed: { sessions: [HERE], session_cap_warning: null } });
    const { router, queryClient } = await openAccount();
    expect(await screen.findByText("Firefox (this device)")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Revoke this device" }));

    await waitFor(() => expect(router.state.location.href).toBe("/login?next=%2Faccount%2Fsecurity"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sign in");
    expect(queryClient.getQueryData(whoamiQueryKey)).toBeNull();
  });

  it("revoke-all confirms, then signs the reader out everywhere", async () => {
    const fetchMock = mockApi();
    const { router } = await openAccount();
    expect(await screen.findByText("Firefox (this device)")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Revoke all sessions" }));
    expect(dialog()).not.toBeNull();
    expect(within(dialog()!).getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    fireEvent.click(within(dialog()!).getByRole("button", { name: "Revoke all sessions" }));

    await waitFor(() => expect(router.state.location.href).toBe("/login?next=%2Faccount%2Fsecurity"));
    const posted = requestsOf(fetchMock, "POST", "/api/auth/sessions/revoke-all")[0]!;
    expect(posted.headers.get(CSRF_HEADER)).toBe(reader.csrf_token);
    expect(posted.headers.get("content-type")).toBe("application/json");
    await expect(posted.json()).resolves.toEqual({});
  });

  it("does not revoke all when the confirmation is cancelled", async () => {
    const fetchMock = mockApi();
    await openAccount();
    expect(await screen.findByText("Firefox (this device)")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Revoke all sessions" }));
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Cancel" }));

    expect(dialog()).toBeNull();
    expect(requestsOf(fetchMock, "POST", "/api/auth/sessions/revoke-all")).toEqual([]);
    expect(screen.getByText("Firefox (this device)")).toBeVisible();
  });

  it("hands a 401 to the shell's expired-session page, at this URL", async () => {
    mockApi({ listStatus: 401, listed: { error: "unauthorized" } });
    const { router } = await openAccount();

    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your session ended."));
    expect(router.state.location.href).toBe("/account/security");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login?next=%2Faccount%2Fsecurity");
  });

  it("shows permission denied without ending the session", async () => {
    mockApi({ listStatus: 403, listed: { error: "forbidden" } });
    const { queryClient } = await openAccount();

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("You don't have access to this."),
    );
    expect(screen.getByRole("link", { name: "Back to library" })).toBeInTheDocument();
    expect(queryClient.getQueryData(whoamiQueryKey)).toEqual(reader);
    expect(screen.queryByRole("heading", { name: "Your session ended." })).not.toBeInTheDocument();
  });

  it("shows the account-changed state for a 412", async () => {
    mockApi({ listStatus: 412, listed: { error: "expected tenant mismatch", acting_tenant: "usr_b" } });
    await openAccount();

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "This tab is signed in to a different account than the page expects.",
      ),
    );
    expect(screen.getByText("Signed in as usr_b.")).toBeVisible();
  });

  it("shows the retryable server error for a 5xx", async () => {
    mockApi({ listStatus: 503, listed: { error: "storage unavailable" } });
    await openAccount();

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Something went wrong on our side."),
    );
    expect(screen.getByText("storage unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("Retry after a list 5xx reads the sessions again", async () => {
    let status = 503;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const request = asRequest(input);
        const path = new URL(request.url).pathname;
        if (path === "/api/auth/sessions" && request.method === "GET") {
          if (status === 503) {
            status = 200;
            return Response.json({ error: "storage unavailable" }, { status: 503 });
          }
          return Response.json(listed);
        }
        return Response.json(reader);
      }),
    );
    await openAccount();
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Something went wrong on our side."),
    );

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Firefox (this device)")).toBeVisible();
  });

  it("shows the retryable server error for a 5xx from revoke, and Retry restores the list", async () => {
    mockApi({
      onDelete: () => Response.json({ error: "storage unavailable" }, { status: 503 }),
    });
    await openAccount();
    expect(await screen.findByText("Phone")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Something went wrong on our side."),
    );
    expect(screen.getByText("storage unavailable")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Account");
    expect(screen.getByText("Phone")).toBeVisible();
  });

  it("shows the offline notice when the list cannot be fetched", async () => {
    onlineManager.setOnline(false);
    mockApi();
    await openAccount();

    await waitFor(() =>
      expect(screen.getByText("You're offline. Check your connection and try again.")).toBeVisible(),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Account");
  });

  it("keeps the list and shows the offline notice when a revoke fails while offline", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = asRequest(input);
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/sessions" && request.method === "GET") return Response.json(listed);
      if (request.method === "DELETE") {
        onlineManager.setOnline(false);
        throw new TypeError("Failed to fetch");
      }
      return Response.json(reader);
    });
    vi.stubGlobal("fetch", fetchMock);
    await openAccount();
    expect(await screen.findByText("Firefox (this device)")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(screen.getByText("You're offline. Check your connection and try again.")).toBeVisible(),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Account");
    expect(screen.getByText("Firefox (this device)")).toBeVisible();
    expect(screen.getByText("Phone")).toBeVisible();
  });

  it("shows the account-changed state for a 403 when another account is signed in now", async () => {
    const other: Identity = { ...reader, tenant_id: "usr_b", user_id: "usr_b", email: "b@example.com" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const request = asRequest(input);
        const path = new URL(request.url).pathname;
        if (path === "/api/whoami") return Response.json(other);
        if (path === "/api/auth/sessions" && request.method === "GET") return Response.json(listed);
        return Response.json({ error: "forbidden" }, { status: 403 });
      }),
    );
    await openAccount();
    expect(await screen.findByText("Phone")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "This tab is signed in to a different account than the page expects.",
      ),
    );
    expect(screen.getByText("Signed in as usr_b.")).toBeVisible();
  });

  it("hands a 401 from revoke-all to the shell without treating success as a sign-out", async () => {
    mockApi({
      onRevokeAll: () => Response.json({ error: "unauthorized" }, { status: 401 }),
    });
    const { router } = await openAccount();
    expect(await screen.findByText("Firefox (this device)")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Revoke all sessions" }));
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Revoke all sessions" }));

    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your session ended."));
    expect(router.state.location.href).toBe("/account/security");
  });

  it("keeps the Account heading while the list is in flight", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    await openAccount();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Account");
    expect(screen.getByRole("button", { name: "Revoke all sessions" })).toBeInTheDocument();
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
  });
});
