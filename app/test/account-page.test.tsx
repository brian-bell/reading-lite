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
import { datetimeLocalValue, type TokenListItem } from "../src/tokens";

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

const SETTINGS = {
  user_id: "usr_a",
  notify_immediate: true,
  digest_cadence: "off",
  time_zone: "UTC",
  digest_hour_local: 8,
  digest_weekday: 1,
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
  onDeleteAccount?: () => Response;
  settings?: unknown;
  settingsStatus?: number;
  onSaveSettings?: (body: Record<string, unknown>) => Response | Promise<Response>;
  onEmailChange?: (body: { email: string }) => Response;
  onListTokens?: () => Response;
  onRevokeToken?: (id: string) => Response;
  onCreateToken?: (body: { name: string; scopes: string[] }) => Response;
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
    if (path === "/api/auth/tokens" && request.method === "GET") {
      return options?.onListTokens?.() ?? Response.json({ tokens: [] });
    }
    if (path === "/api/auth/tokens" && request.method === "POST") {
      const body = (await request.clone().json()) as { name: string; scopes: string[] };
      return (
        options?.onCreateToken?.(body) ??
        Response.json(
          { token: "tok_new.secret", id: "tok_new", name: body.name, scopes: body.scopes, created_at_ms: 1, expires_at_ms: 2 },
          { status: 201 },
        )
      );
    }
    if (request.method === "DELETE" && path.startsWith("/api/auth/tokens/")) {
      const id = decodeURIComponent(path.slice("/api/auth/tokens/".length));
      return options?.onRevokeToken?.(id) ?? Response.json({ ok: true });
    }
    if (path === "/api/auth/email-change" && request.method === "POST") {
      const body = (await request.clone().json()) as { email: string };
      return options?.onEmailChange?.(body) ?? Response.json({ ok: true });
    }
    if (path === "/api/account" && request.method === "DELETE") {
      return options?.onDeleteAccount?.() ?? Response.json({ ok: true });
    }
    if (path === "/api/auth/settings" && request.method === "GET") {
      return Response.json(options?.settings ?? SETTINGS, { status: options?.settingsStatus ?? 200 });
    }
    if (path === "/api/auth/settings" && request.method === "POST") {
      const body = (await request.clone().json()) as Record<string, unknown>;
      return (await options?.onSaveSettings?.(body)) ?? Response.json({ ...SETTINGS, ...body });
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
    expect(within(screen.getByRole("region", { name: "Sessions" })).getByRole("status")).toHaveTextContent("10-session limit");
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

  it("revokes another session, then refreshes the list", async () => {
    let sessions = [HERE, PHONE];
    mockApi({
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
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Revoke all sessions" }));

    await waitFor(() => expect(router.state.location.href).toBe("/login?next=%2Faccount%2Fsecurity"));
    expect(requestsOf(fetchMock, "POST", "/api/auth/sessions/revoke-all")).toHaveLength(1);
  });

  it("hands a 401 to the shell's expired-session page, at this URL", async () => {
    mockApi({ listStatus: 401, listed: { error: "unauthorized" } });
    const { router } = await openAccount();

    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your session ended."));
    expect(router.state.location.href).toBe("/account/security");
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login?next=%2Faccount%2Fsecurity",
    );
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

  it("shows the retryable server error for a list 5xx, and Retry reads the sessions again", async () => {
    let status = 503;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const request = asRequest(input);
        const path = new URL(request.url).pathname;
        if (path === "/api/auth/settings") return Response.json(SETTINGS);
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
    expect(screen.getByText("storage unavailable")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Firefox (this device)")).toBeVisible();
  });

  it("shows the retryable server error for a failed revoke, and Retry reads the list again", async () => {
    // Another tab already revoked the phone: this tab's list is stale.
    let sessions = [HERE, PHONE];
    mockApi({
      listed: {
        get sessions() {
          return sessions;
        },
        session_cap_warning: null,
      },
      onDelete: () => {
        sessions = [HERE, { ...PHONE, usable: false, revoked_at_ms: 4, revocation_reason: "user" }];
        return Response.json({ error: "session not found" }, { status: 404 });
      },
    });
    await openAccount();
    expect(await screen.findByText("Phone")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Something went wrong on our side."),
    );
    expect(screen.getByText("session not found")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Phone · revoked (user)")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Account");
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });
  it("keeps the list and shows the offline notice when a revoke fails while offline", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = asRequest(input);
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/settings") return Response.json(SETTINGS);
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
        if (path === "/api/auth/settings" && request.method === "GET") return Response.json(SETTINGS);
        if (path === "/api/auth/tokens" && request.method === "GET") return Response.json({ tokens: [] });
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

  // A state page replaces the page and its open dialog without a `close`
  // event, so nothing tells the owner it closed. Retry must not bring it back.
  it.each([
    ["Revoke all sessions", "Revoke all browser sessions?"],
    ["Delete account…", "Delete your account?"],
  ])("does not reopen the %s dialog after a state page replaced it", async (trigger, title) => {
    let status = 200;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const request = asRequest(input);
        const path = new URL(request.url).pathname;
        if (path === "/api/auth/sessions" && request.method === "GET") {
          return status === 200
            ? Response.json(listed)
            : Response.json({ error: "storage unavailable" }, { status });
        }
        if (path === "/api/auth/settings" && request.method === "GET") return Response.json(SETTINGS);
        return Response.json(reader);
      }),
    );
    const { queryClient } = await openAccount();
    expect(await screen.findByText("Firefox (this device)")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: trigger }));
    expect(screen.getByRole("dialog", { name: title })).toBeInTheDocument();

    status = 503;
    await queryClient.refetchQueries({ queryKey: ["sessions", "usr_a"] });
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Something went wrong on our side."),
    );
    status = 200;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Firefox (this device)")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: title })).not.toBeInTheDocument();
  });

  it("keeps the Account heading while the list is in flight", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    await openAccount();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Account");
    expect(screen.getByRole("button", { name: "Revoke all sessions" })).toBeInTheDocument();
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
  });
});

// Immediate email (#340.6.1): read, save, and the common states on the
// settings read and save. Parsing is settings.test.ts's; request shape is
// settings-api.test.ts's.
describe("notification settings on the account page", () => {
  const toggle = () => screen.getByRole("checkbox", { name: "Email me when a reading is ready" });

  it("shows the saved immediate-email setting and saves a change", async () => {
    const fetchMock = mockApi();
    await openAccount();
    await waitFor(() => expect(toggle()).toBeChecked());

    await userEvent.click(toggle());

    await waitFor(() => expect(toggle()).not.toBeChecked());
    const [saved] = requestsOf(fetchMock, "POST", "/api/auth/settings");
    await expect(saved!.json()).resolves.toEqual({ notify_immediate: false });
    await waitFor(() => expect(toggle()).toBeEnabled());
  });

  it("shows the server error for an unparseable settings body, and keeps the sessions list", async () => {
    mockApi({ settings: { notify_immediate: "yes" } });
    await openAccount();

    const section = screen.getByRole("region", { name: "Notifications" });
    expect(await within(section).findByText("Something went wrong on our side.")).toBeVisible();
    expect(within(section).getByText("settings returned an unexpected body")).toBeVisible();
    expect(within(section).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(await screen.findByText("Firefox (this device)")).toBeVisible();
  });

  it("keeps the reader's choice through a failed save, and Retry sends it again", async () => {
    let fail = true;
    const fetchMock = mockApi({
      onSaveSettings: (body) => {
        if (!fail) return Response.json({ ...SETTINGS, ...body });
        fail = false;
        return Response.json({ error: "control plane unavailable" }, { status: 503 });
      },
    });
    await openAccount();
    await waitFor(() => expect(toggle()).toBeChecked());

    await userEvent.click(toggle());

    const section = screen.getByRole("region", { name: "Notifications" });
    expect(await within(section).findByText("control plane unavailable")).toBeVisible();
    expect(within(section).getByText(/Your change wasn't saved/)).toBeVisible();
    expect(toggle()).not.toBeChecked();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Account");

    await userEvent.click(within(section).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(within(section).queryByText("control plane unavailable")).not.toBeInTheDocument();
    const saves = requestsOf(fetchMock, "POST", "/api/auth/settings");
    expect(saves).toHaveLength(2);
    await expect(saves[1]!.json()).resolves.toEqual({ notify_immediate: false });
  });

  it("keeps the unsaved choice through a save that fails offline, and Discard puts back the stored one", async () => {
    mockApi({
      onSaveSettings: () => {
        onlineManager.setOnline(false);
        throw new TypeError("Failed to fetch");
      },
    });
    await openAccount();
    await waitFor(() => expect(toggle()).toBeChecked());

    await userEvent.click(toggle());

    const section = screen.getByRole("region", { name: "Notifications" });
    expect(await within(section).findByText("You're offline. Your change wasn't saved.")).toBeVisible();
    expect(toggle()).not.toBeChecked();
    expect(within(section).getByRole("button", { name: "Retry" })).toBeInTheDocument();

    await userEvent.click(within(section).getByRole("button", { name: "Discard" }));

    expect(toggle()).toBeChecked();
    expect(within(section).queryByText(/Your change wasn't saved/)).not.toBeInTheDocument();
  });

  it.each([
    ["read", 403, "You don't have access to this."],
    ["read", 412, "This tab is signed in to a different account than the page expects."],
    ["save", 403, "You don't have access to this."],
    ["save", 412, "This tab is signed in to a different account than the page expects."],
  ])("shows the page's refusal state for a settings %s %i", async (step, status, heading) => {
    const body =
      status === 412 ? { error: "expected tenant mismatch", acting_tenant: "usr_b" } : { error: "forbidden" };
    mockApi(
      step === "read"
        ? { settingsStatus: status, settings: body }
        : { onSaveSettings: () => Response.json(body, { status }) },
    );
    const { queryClient } = await openAccount();
    if (step === "save") {
      await waitFor(() => expect(toggle()).toBeChecked());
      await userEvent.click(toggle());
    }

    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(heading));
    expect(queryClient.getQueryData(whoamiQueryKey)).toEqual(reader);
  });

  it("hands a 401 from a save to the shell's expired-session page", async () => {
    mockApi({ onSaveSettings: () => Response.json({ error: "unauthorized" }, { status: 401 }) });
    const { router } = await openAccount();
    await waitFor(() => expect(toggle()).toBeChecked());

    await userEvent.click(toggle());

    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your session ended."));
    expect(router.state.location.href).toBe("/account/security");
  });
});

// API tokens (#340.7): the list and the common states on its read. Parsing
// and the status words are tokens.test.ts's; request shape is
// tokens-api.test.ts's.
describe("API tokens on the account page", () => {
  const token = (over: Partial<TokenListItem> = {}): TokenListItem => ({
    id: "tok_ci",
    name: "CI",
    format: "standard",
    scopes: ["readings:read", "readings:write"],
    created_at_ms: 1,
    expires_at_ms: 2,
    revoked_at_ms: null,
    last_used_at_ms: null,
    usable: true,
    ...over,
  });
  const section = () => screen.getByRole("region", { name: "API tokens" });

  it("lists each token's name, status, scopes, and times, revoked and expired included", async () => {
    mockApi({
      onListTokens: () =>
        Response.json({
          tokens: [
            token(),
            token({ id: "tok_old", name: "Old", usable: false }),
            token({ id: "tok_gone", name: "Gone", usable: false, revoked_at_ms: 3, last_used_at_ms: 2 }),
          ],
        }),
    });
    await openAccount();

    const list = await within(section()).findByRole("list", { name: "API tokens" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual([
      "CI (standard) · usable",
      "Old (standard) · expired",
      "Gone (standard) · revoked",
    ]);
    expect(within(rows[0]!).getByText("readings:read, readings:write")).toBeVisible();
    expect(within(rows[0]!).getByText(/never used$/)).toBeVisible();
    expect(within(rows[2]!).getByText(/last used/)).toBeVisible();
  });

  it("says when there are no tokens", async () => {
    mockApi();
    await openAccount();

    expect(await within(section()).findByText("No API tokens yet.")).toBeVisible();
  });

  it.each([
    [403, "You don't have access to this."],
    [412, "This tab is signed in to a different account than the page expects."],
  ])("shows the page's refusal state for a token list %i", async (status, heading) => {
    const body =
      status === 412 ? { error: "expected tenant mismatch", acting_tenant: "usr_b" } : { error: "forbidden" };
    mockApi({ onListTokens: () => Response.json(body, { status }) });
    const { queryClient } = await openAccount();

    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(heading));
    expect(queryClient.getQueryData(whoamiQueryKey)).toEqual(reader);
  });

  it("shows a list 5xx inside the section, keeps the rest of the page, and Retry reads the tokens again", async () => {
    let fail = true;
    mockApi({
      onListTokens: () => {
        if (!fail) return Response.json({ tokens: [] });
        fail = false;
        return Response.json({ error: "control plane unavailable" }, { status: 503 });
      },
    });
    await openAccount();

    expect(await within(section()).findByText("control plane unavailable")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Account");
    expect(await screen.findByText("Firefox (this device)")).toBeVisible();

    await userEvent.click(within(section()).getByRole("button", { name: "Retry" }));

    expect(await within(section()).findByText("No API tokens yet.")).toBeVisible();
    expect(within(section()).queryByText("control plane unavailable")).not.toBeInTheDocument();
  });

  it("shows the offline notice in the section when the list cannot reach the network", async () => {
    mockApi({
      onListTokens: () => {
        onlineManager.setOnline(false);
        throw new TypeError("Failed to fetch");
      },
    });
    await openAccount();

    expect(await within(section()).findByText(/offline/i)).toBeVisible();
    expect(within(section()).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Account");
  });

  const revokeDialog = () => screen.queryByRole("dialog", { name: "Revoke this API token?" });

  async function revokeCi() {
    await userEvent.click(await within(section()).findByRole("button", { name: "Revoke CI" }));
    await userEvent.click(within(revokeDialog()!).getByRole("button", { name: "Revoke token" }));
  }

  it("revokes a token after confirming, with CSRF and the tenant pin, and shows it revoked", async () => {
    let tokens = [token()];
    const fetchMock = mockApi({
      onListTokens: () => Response.json({ tokens }),
      onRevokeToken: () => {
        tokens = [token({ usable: false, revoked_at_ms: 9 })];
        return Response.json({ ok: true });
      },
    });
    await openAccount();

    await revokeCi();

    expect(await within(section()).findByText("CI (standard) · revoked")).toBeVisible();
    expect(within(section()).queryByRole("button", { name: "Revoke CI" })).not.toBeInTheDocument();
    const [revoked] = requestsOf(fetchMock, "DELETE", "/api/auth/tokens/");
    expect(new URL(revoked!.url).pathname).toBe("/api/auth/tokens/tok_ci");
    expect(revoked!.headers.get("x-csrf-token")).toBe("csrf-a");
    expect(revoked!.headers.get("x-expected-tenant")).toBe("usr_a");
    await waitFor(() => expect(within(section()).getByRole("heading", { name: "API tokens" })).toHaveFocus());
  });

  it("sends nothing when the confirmation is cancelled", async () => {
    const fetchMock = mockApi({ onListTokens: () => Response.json({ tokens: [token()] }) });
    await openAccount();

    await userEvent.click(await within(section()).findByRole("button", { name: "Revoke CI" }));
    await userEvent.click(within(revokeDialog()!).getByRole("button", { name: "Cancel" }));

    expect(revokeDialog()).not.toBeInTheDocument();
    expect(within(section()).getByRole("button", { name: "Revoke CI" })).toHaveFocus();
    expect(requestsOf(fetchMock, "DELETE", "/api/auth/tokens/")).toHaveLength(0);
  });

  it.each([
    ["an out-of-date list read", 200],
    ["a 404 because another tab already revoked it", 404],
  ])("keeps a revoked token revoked through %s", async (_, status) => {
    // The list keeps answering with the token usable.
    mockApi({
      onListTokens: () => Response.json({ tokens: [token()] }),
      onRevokeToken: () =>
        status === 200 ? Response.json({ ok: true }) : Response.json({ error: "not found" }, { status }),
    });
    await openAccount();

    await revokeCi();

    expect(await within(section()).findByText("CI (standard) · revoked")).toBeVisible();
    expect(within(section()).queryByRole("button", { name: "Revoke CI" })).not.toBeInTheDocument();
    expect(within(section()).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a failed revoke in the section, and Retry reads the list without revoking again", async () => {
    let tokens = [token()];
    const fetchMock = mockApi({
      onListTokens: () => Response.json({ tokens }),
      onRevokeToken: () => {
        tokens = [token({ usable: false, revoked_at_ms: 9 })];
        return Response.json({ error: "control plane unavailable" }, { status: 503 });
      },
    });
    await openAccount();

    await revokeCi();

    expect(await within(section()).findByText("control plane unavailable")).toBeVisible();
    expect(within(section()).getByText(/The token wasn't revoked/)).toBeVisible();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Account");

    await userEvent.click(within(section()).getByRole("button", { name: "Retry" }));

    expect(await within(section()).findByText("CI (standard) · revoked")).toBeVisible();
    expect(within(section()).queryByText("control plane unavailable")).not.toBeInTheDocument();
    expect(requestsOf(fetchMock, "DELETE", "/api/auth/tokens/")).toHaveLength(1);
  });

  it("keeps the list and says so when a revoke fails offline", async () => {
    mockApi({
      onListTokens: () => Response.json({ tokens: [token()] }),
      onRevokeToken: () => {
        onlineManager.setOnline(false);
        throw new TypeError("Failed to fetch");
      },
    });
    await openAccount();

    await revokeCi();

    expect(await within(section()).findByText("You're offline. The token wasn't revoked.")).toBeVisible();
    expect(within(section()).getByText("CI (standard) · usable")).toBeVisible();
  });

  const nameField = () => within(section()).getByRole("textbox", { name: "Name" });
  const createButton = () => within(section()).getByRole("button", { name: "Create token" });

  it("creates a token with every scope by default, shows its value once, and lists it", async () => {
    let tokens: TokenListItem[] = [];
    const fetchMock = mockApi({
      onListTokens: () => Response.json({ tokens }),
      onCreateToken: (body) => {
        tokens = [token({ id: "tok_new", name: body.name, scopes: body.scopes })];
        return Response.json(
          { token: "tok_new.s3cret", id: "tok_new", name: body.name, scopes: body.scopes, created_at_ms: 1, expires_at_ms: 2 },
          { status: 201 },
        );
      },
    });
    await openAccount();

    await userEvent.type(await within(section()).findByRole("textbox", { name: "Name" }), "  Laptop  ");
    await userEvent.click(createButton());

    const reveal = await within(section()).findByText("tok_new.s3cret");
    expect(within(section()).getByText("Copy the token for “Laptop” now. It won't be shown again.")).toBeVisible();
    await waitFor(() => expect(reveal.closest(".token-reveal")).toHaveFocus());
    expect(await within(section()).findByText("Laptop (standard) · usable")).toBeVisible();
    expect(nameField()).toHaveValue("");
    const [created] = requestsOf(fetchMock, "POST", "/api/auth/tokens");
    await expect(created!.json()).resolves.toEqual({
      name: "Laptop",
      scopes: ["readings:read", "readings:write", "readings:import", "readings:delete"],
    });
    expect(created!.headers.get("x-csrf-token")).toBe("csrf-a");
    expect(created!.headers.get("x-expected-tenant")).toBe("usr_a");
  });

  it("sends only the scopes left checked", async () => {
    const fetchMock = mockApi();
    await openAccount();

    await userEvent.type(await within(section()).findByRole("textbox", { name: "Name" }), "Reader");
    await userEvent.click(within(section()).getByRole("checkbox", { name: "readings:write" }));
    await userEvent.click(within(section()).getByRole("checkbox", { name: "readings:delete" }));
    await userEvent.click(createButton());

    await within(section()).findByText("tok_new.secret");
    const [created] = requestsOf(fetchMock, "POST", "/api/auth/tokens");
    await expect(created!.json()).resolves.toEqual({ name: "Reader", scopes: ["readings:read", "readings:import"] });
  });

  it.each([
    ["a blank name", "Enter a name.", async (): Promise<void> => {}, "textbox"],
    [
      "no scope",
      "Select at least one scope.",
      async (): Promise<void> => {
        await userEvent.type(nameField(), "CI");
        for (const scope of ["readings:read", "readings:write", "readings:import", "readings:delete"]) {
          await userEvent.click(within(section()).getByRole("checkbox", { name: scope }));
        }
      },
      "checkbox",
    ],
  ] as const)("refuses %s before any request", async (_, message, fill, focused) => {
    const fetchMock = mockApi();
    await openAccount();
    await within(section()).findByRole("textbox", { name: "Name" });

    await fill();
    await userEvent.click(createButton());

    expect(within(section()).getByText(message)).toBeVisible();
    expect(document.activeElement?.getAttribute("type")).toBe(focused === "textbox" ? "text" : "checkbox");
    expect(requestsOf(fetchMock, "POST", "/api/auth/tokens")).toHaveLength(0);
  });

  const expiryField = () => within(section()).getByLabelText("Expires (optional)");
  const inDays = (days: number) => datetimeLocalValue(Date.now() + days * 24 * 60 * 60 * 1000);

  it("sends a chosen expiry, and shows it in the list", async () => {
    let tokens: TokenListItem[] = [];
    const fetchMock = mockApi({
      onListTokens: () => Response.json({ tokens }),
      onCreateToken: (body) => {
        const expires = (body as { expires_at_ms?: number }).expires_at_ms ?? 0;
        tokens = [token({ id: "tok_new", name: body.name, expires_at_ms: expires })];
        return Response.json({ token: "tok_new.secret", id: "tok_new", name: body.name }, { status: 201 });
      },
    });
    await openAccount();
    const expiry = inDays(30);

    await userEvent.type(await within(section()).findByRole("textbox", { name: "Name" }), "CI");
    fireEvent.change(expiryField(), { target: { value: expiry } });
    await userEvent.click(createButton());

    await within(section()).findByText("tok_new.secret");
    const [created] = requestsOf(fetchMock, "POST", "/api/auth/tokens");
    await expect(created!.json()).resolves.toMatchObject({ name: "CI", expires_at_ms: Date.parse(expiry) });
    const shown = `expires ${new Date(Date.parse(expiry)).toLocaleString()}`;
    expect(await within(section()).findByText((text) => text.includes(shown))).toBeVisible();
    expect(expiryField()).toHaveValue("");
  });

  it.each([
    ["in the past", () => inDays(-1), "Expiry must be in the future."],
    ["more than 90 days away", () => inDays(91), "Expiry cannot be more than 90 days from now."],
  ])("refuses an expiry %s before any request", async (_, value, message) => {
    const fetchMock = mockApi();
    await openAccount();

    await userEvent.type(await within(section()).findByRole("textbox", { name: "Name" }), "CI");
    fireEvent.change(expiryField(), { target: { value: value() } });
    await userEvent.click(createButton());

    expect(within(section()).getByText(message)).toBeVisible();
    expect(expiryField()).toHaveFocus();
    expect(expiryField()).toHaveAttribute("aria-invalid", "true");
    expect(requestsOf(fetchMock, "POST", "/api/auth/tokens")).toHaveLength(0);
  });

  it("keeps the value only until Dismiss, and never in the query client", async () => {
    mockApi();
    const { router, queryClient } = await openAccount();

    await userEvent.type(await within(section()).findByRole("textbox", { name: "Name" }), "CI");
    await userEvent.click(createButton());
    await within(section()).findByText("tok_new.secret");

    const cached = JSON.stringify([
      queryClient.getQueryCache().getAll().map((query) => query.state.data),
      queryClient.getMutationCache().getAll().map((mutation) => mutation.state),
    ]);
    expect(cached).not.toContain("tok_new.secret");

    await userEvent.click(within(section()).getByRole("button", { name: "Dismiss" }));
    expect(within(section()).queryByText("tok_new.secret")).not.toBeInTheDocument();
    expect(nameField()).toHaveFocus();

    await userEvent.type(nameField(), "Again");
    await userEvent.click(createButton());
    await within(section()).findByText("tok_new.secret");
    await router.navigate({ to: "/" });
    await router.navigate({ to: "/account/security" });
    await within(section()).findByRole("textbox", { name: "Name" });
    expect(screen.queryByText("tok_new.secret")).not.toBeInTheDocument();
  });

  it("keeps the value on screen when the list read after the create fails", async () => {
    let reads = 0;
    mockApi({
      onListTokens: () => {
        reads += 1;
        return reads === 1
          ? Response.json({ tokens: [] })
          : Response.json({ error: "control plane unavailable" }, { status: 503 });
      },
    });
    await openAccount();

    await userEvent.type(await within(section()).findByRole("textbox", { name: "Name" }), "CI");
    await userEvent.click(createButton());

    expect(await within(section()).findByText("control plane unavailable")).toBeVisible();
    expect(within(section()).getByText("tok_new.secret")).toBeVisible();
    expect(within(section()).getByRole("button", { name: "Copy" })).toBeVisible();
  });

  it("keeps the value through a page state and shows it again after Retry", async () => {
    mockApi({ onDelete: () => Response.json({ error: "control plane unavailable" }, { status: 503 }) });
    await openAccount();
    await userEvent.type(await within(section()).findByRole("textbox", { name: "Name" }), "CI");
    await userEvent.click(createButton());
    await within(section()).findByText("tok_new.secret");

    // A failed session revoke replaces the whole page with its server error.
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Something went wrong on our side."),
    );
    expect(screen.queryByText("tok_new.secret")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await within(section()).findByText("tok_new.secret")).toBeVisible();
  });

  it("says the account is at the limit when a create answers 409", async () => {
    mockApi({ onCreateToken: () => Response.json({ error: "too many active tokens" }, { status: 409 }) });
    await openAccount();

    await userEvent.type(await within(section()).findByRole("textbox", { name: "Name" }), "CI");
    await userEvent.click(createButton());

    expect(await within(section()).findByRole("alert")).toHaveTextContent(
      "This account is at the 10-token limit. Revoke a token before creating another.",
    );
    expect(within(section()).queryByText(/went wrong/)).not.toBeInTheDocument();
  });

  it("copies the value to the clipboard", async () => {
    mockApi();
    await openAccount();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    await userEvent.type(await within(section()).findByRole("textbox", { name: "Name" }), "CI");
    await userEvent.click(createButton());
    await userEvent.click(await within(section()).findByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith("tok_new.secret");
    expect(within(section()).getByRole("button", { name: "Copied" })).toBeVisible();
  });

  it("asks the reader to check the name and scopes when a create answers 400", async () => {
    mockApi({ onCreateToken: () => Response.json({ error: "invalid body" }, { status: 400 }) });
    await openAccount();

    await userEvent.type(await within(section()).findByRole("textbox", { name: "Name" }), "CI");
    await userEvent.click(createButton());

    expect(await within(section()).findByRole("alert")).toHaveTextContent(
      "The token wasn't created. Check the name and scopes, then try again.",
    );
    expect(nameField()).toHaveValue("CI");
  });

  it("sends a stale sign-in to step-up, and creates once the reader is back with a fresh one", async () => {
    let recent = false;
    mockApi({
      onCreateToken: (body) =>
        recent
          ? Response.json({ token: "tok_new.secret", id: "tok_new", name: body.name }, { status: 201 })
          : Response.json({ error: "recent authentication required" }, { status: 403 }),
    });
    const { router, queryClient } = await openAccount();

    await userEvent.type(await within(section()).findByRole("textbox", { name: "Name" }), "CI");
    await userEvent.click(createButton());

    const alert = await within(section()).findByRole("alert");
    expect(alert).toHaveTextContent(
      "Recent sign-in required. The token wasn't created. Request a fresh sign-in link to confirm a sensitive change.",
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Account");
    expect(queryClient.getQueryData(whoamiQueryKey)).toEqual(reader);

    await userEvent.click(within(alert).getByRole("link", { name: "Request a fresh sign-in link" }));
    await waitFor(() => expect(router.state.location.href).toBe("/login?step_up=1&next=%2Faccount%2Fsecurity"));

    // The emailed link signs in again and verify returns to `next`.
    recent = true;
    await router.navigate({ to: "/account/security" });
    await userEvent.type(await within(section()).findByRole("textbox", { name: "Name" }), "CI");
    await userEvent.click(createButton());

    expect(await within(section()).findByText("tok_new.secret")).toBeVisible();
    expect(within(section()).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a failed create in the section, keeps the form, and Retry reads the list without creating again", async () => {
    let listReads = 0;
    const fetchMock = mockApi({
      onListTokens: () => {
        listReads += 1;
        return Response.json({ tokens: [] });
      },
      onCreateToken: () => Response.json({ error: "control plane unavailable" }, { status: 503 }),
    });
    await openAccount();

    await userEvent.type(await within(section()).findByRole("textbox", { name: "Name" }), "CI");
    await userEvent.click(createButton());

    expect(await within(section()).findByText("control plane unavailable")).toBeVisible();
    expect(within(section()).getByText(/The token wasn't created/)).toBeVisible();
    expect(nameField()).toHaveValue("CI");
    const readsBefore = listReads;

    await userEvent.click(within(section()).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(listReads).toBe(readsBefore + 1));
    expect(within(section()).queryByText("control plane unavailable")).not.toBeInTheDocument();
    expect(requestsOf(fetchMock, "POST", "/api/auth/tokens")).toHaveLength(1);
  });

  it.each([
    [403, { error: "forbidden" }, "You don't have access to this."],
    [412, { error: "expected tenant mismatch", acting_tenant: "usr_b" }, "This tab is signed in to a different account than the page expects."],
  ])("shows the page's refusal state for a create %i", async (status, body, heading) => {
    mockApi({ onCreateToken: () => Response.json(body, { status }) });
    await openAccount();

    await userEvent.type(await within(section()).findByRole("textbox", { name: "Name" }), "CI");
    await userEvent.click(createButton());

    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(heading));
  });

  it.each([
    [403, "You don't have access to this."],
    [412, "This tab is signed in to a different account than the page expects."],
  ])("shows the page's refusal state for a revoke %i", async (status, heading) => {
    const body =
      status === 412 ? { error: "expected tenant mismatch", acting_tenant: "usr_b" } : { error: "forbidden" };
    mockApi({
      onListTokens: () => Response.json({ tokens: [token()] }),
      onRevokeToken: () => Response.json(body, { status }),
    });
    const { queryClient } = await openAccount();

    await revokeCi();

    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(heading));
    expect(queryClient.getQueryData(whoamiQueryKey)).toEqual(reader);
  });
});

// The digest schedule (#340.6.3): saved values, the off-to-on draft, saves
// while on, and a failed save. The draft rules themselves are digest.test.ts's.
describe("the digest schedule on the account page", () => {
  const cadence = () => screen.getByRole("combobox", { name: "Cadence" });
  const WEEKLY = { ...SETTINGS, digest_cadence: "weekly", time_zone: "Europe/London", digest_hour_local: 7, digest_weekday: 3 };

  it.each([
    ["weekly", { "Time zone": "Europe/London", "Local hour": "7", Weekday: "3" }],
    ["daily", { "Time zone": "Europe/London", "Local hour": "7", Weekday: null }],
    ["off", { "Time zone": null, "Local hour": null, Weekday: null }],
  ])("shows a saved %s schedule, with the weekday only for weekly", async (saved, controls) => {
    mockApi({ settings: { ...WEEKLY, digest_cadence: saved } });
    await openAccount();

    await waitFor(() => expect(cadence()).toHaveValue(saved));
    for (const [name, value] of Object.entries(controls)) {
      if (value === null) expect(screen.queryByRole("combobox", { name })).not.toBeInTheDocument();
      else expect(screen.getByRole("combobox", { name })).toHaveValue(value);
    }
  });

  it("carries a change that failed to save into the next one", async () => {
    let fail = true;
    const fetchMock = mockApi({
      settings: WEEKLY,
      onSaveSettings: (body) => {
        if (!fail) return Response.json({ ...WEEKLY, ...body });
        fail = false;
        return Response.json({ error: "control plane unavailable" }, { status: 503 });
      },
    });
    await openAccount();
    await waitFor(() => expect(cadence()).toHaveValue("weekly"));

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Local hour" }), "21");
    expect(await screen.findByText("control plane unavailable")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Local hour" })).toHaveValue("21");

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Weekday" }), "5");

    await waitFor(() => expect(requestsOf(fetchMock, "POST", "/api/auth/settings")).toHaveLength(2));
    await expect(requestsOf(fetchMock, "POST", "/api/auth/settings")[1]!.json()).resolves.toMatchObject({
      digest_hour_local: 21,
      digest_weekday: 5,
    });
  });

  it("drafts a digest turned on from off, and saves it only on Save digest", async () => {
    const fetchMock = mockApi({ settings: { ...WEEKLY, digest_cadence: "off" } });
    await openAccount();
    await waitFor(() => expect(cadence()).toHaveValue("off"));

    await userEvent.selectOptions(cadence(), "weekly");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Local hour" }), "18");

    expect(screen.getByText(/Digest stays off until you save/)).toBeVisible();
    expect(requestsOf(fetchMock, "POST", "/api/auth/settings")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Save digest" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Save digest" })).not.toBeInTheDocument());
    const [saved] = requestsOf(fetchMock, "POST", "/api/auth/settings");
    await expect(saved!.json()).resolves.toEqual({
      notify_immediate: true,
      digest_cadence: "weekly",
      time_zone: "Europe/London",
      digest_hour_local: 18,
      digest_weekday: 3,
    });
    expect(cadence()).toHaveValue("weekly");
    expect(screen.getByRole("combobox", { name: "Local hour" })).toHaveValue("18");
  });

  it("discards the draft on Cancel without saving", async () => {
    const fetchMock = mockApi({ settings: { ...WEEKLY, digest_cadence: "off" } });
    await openAccount();
    await waitFor(() => expect(cadence()).toHaveValue("off"));

    await userEvent.selectOptions(cadence(), "daily");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(cadence()).toHaveValue("off");
    expect(screen.queryByRole("combobox", { name: "Local hour" })).not.toBeInTheDocument();
    expect(requestsOf(fetchMock, "POST", "/api/auth/settings")).toHaveLength(0);
  });

  it.each([
    ["a new hour", "Local hour", "21", { digest_hour_local: 21 }],
    ["turning it off, keeping the schedule", "Cadence", "off", { digest_cadence: "off" }],
  ])("saves %s at once while the digest is on", async (_case, control, value, patch) => {
    const fetchMock = mockApi({ settings: WEEKLY });
    await openAccount();
    await waitFor(() => expect(cadence()).toHaveValue("weekly"));

    await userEvent.selectOptions(screen.getByRole("combobox", { name: control }), value);

    await waitFor(() => expect(requestsOf(fetchMock, "POST", "/api/auth/settings")).toHaveLength(1));
    const [saved] = requestsOf(fetchMock, "POST", "/api/auth/settings");
    await expect(saved!.json()).resolves.toEqual({
      notify_immediate: true,
      digest_cadence: "weekly",
      time_zone: "Europe/London",
      digest_hour_local: 7,
      digest_weekday: 3,
      ...patch,
    });
    await waitFor(() => expect(screen.getByRole("combobox", { name: control })).toBeEnabled());
    expect(screen.getByRole("combobox", { name: control })).toHaveValue(value);
  });

  it.each([
    ["Cancel", (section: HTMLElement) => userEvent.click(within(section).getByRole("button", { name: "Cancel" }))],
    ["Discard", (section: HTMLElement) => userEvent.click(within(section).getByRole("button", { name: "Discard" }))],
    ["choosing Off", () => userEvent.selectOptions(cadence(), "off")],
  ])("keeps the draft through a failed Save digest, and %s puts the digest back off", async (_case, dropDraft) => {
    const fetchMock = mockApi({
      settings: { ...WEEKLY, digest_cadence: "off" },
      onSaveSettings: () => Response.json({ error: "control plane unavailable" }, { status: 503 }),
    });
    await openAccount();
    await waitFor(() => expect(cadence()).toHaveValue("off"));

    await userEvent.selectOptions(cadence(), "daily");
    await userEvent.click(screen.getByRole("button", { name: "Save digest" }));

    const section = screen.getByRole("region", { name: "Notifications" });
    expect(await within(section).findByText("control plane unavailable")).toBeVisible();
    expect(cadence()).toHaveValue("daily");
    expect(screen.getByRole("button", { name: "Save digest" })).toBeEnabled();

    await dropDraft(section);

    expect(cadence()).toHaveValue("off");
    expect(screen.queryByRole("button", { name: "Save digest" })).not.toBeInTheDocument();
    expect(within(section).queryByText(/Your change wasn't saved/)).not.toBeInTheDocument();
    expect(requestsOf(fetchMock, "POST", "/api/auth/settings")).toHaveLength(1);
  });

  it("leaves a failed immediate-email save alone when the draft is cancelled", async () => {
    mockApi({
      settings: { ...WEEKLY, digest_cadence: "off" },
      onSaveSettings: () => Response.json({ error: "control plane unavailable" }, { status: 503 }),
    });
    await openAccount();
    await waitFor(() => expect(cadence()).toHaveValue("off"));

    await userEvent.selectOptions(cadence(), "daily");
    await userEvent.click(screen.getByRole("checkbox", { name: "Email me when a reading is ready" }));
    expect(await screen.findByText("control plane unavailable")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("control plane unavailable")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Email me when a reading is ready" })).not.toBeChecked();
  });
});

// Email change (#340.6.2): the request, the check-your-inbox confirmation, the
// recent-auth step-up, and the common states. Outcome mapping and the request
// shape are email-change.test.ts's.
describe("email change on the account page", () => {
  const field = () => screen.getByRole("textbox", { name: "New email" });
  const send = () => screen.getByRole("button", { name: "Send confirmation" });
  const section = () => screen.getByRole("region", { name: "Email" });

  async function requestChange(address = "new@example.com") {
    await userEvent.type(field(), address);
    await userEvent.click(send());
  }

  it("sends the new address and says to check the inbox, keeping what was typed", async () => {
    const fetchMock = mockApi();
    await openAccount();

    await requestChange();

    expect(await within(section()).findByRole("status")).toHaveTextContent(
      "If that address can be used, we sent a short-lived confirmation link.",
    );
    expect(field()).toHaveValue("new@example.com");
    expect(requestsOf(fetchMock, "POST", "/api/auth/email-change")).toHaveLength(1);

    // A different address has had nothing sent yet.
    await userEvent.type(field(), "x");
    expect(within(section()).getByRole("status")).toBeEmptyDOMElement();
  });

  it("asks for a fresh sign-in on a recent-auth 403, not the permission page", async () => {
    mockApi({ onEmailChange: () => Response.json({ error: "recent authentication required" }, { status: 403 }) });
    const { queryClient } = await openAccount();

    await requestChange();

    expect(await within(section()).findByRole("alert")).toHaveTextContent("Recent sign-in required.");
    expect(within(section()).getByRole("link", { name: "Request a fresh sign-in link" })).toHaveAttribute(
      "href",
      "/login?step_up=1&next=%2Faccount%2Fsecurity",
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Account");
    expect(screen.queryByText("You don't have access to this.")).not.toBeInTheDocument();
    expect(queryClient.getQueryData(whoamiQueryKey)).toEqual(reader);
  });

  it("marks the field and focuses it when the backend rejects the address", async () => {
    mockApi({ onEmailChange: () => Response.json({ error: "invalid body" }, { status: 400 }) });
    await openAccount();

    await requestChange("not-an-address");

    expect(await within(section()).findByText("Enter a valid email address.")).toBeVisible();
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(field()).toHaveFocus();
  });

  it("keeps the typed address offline, and Retry sends it", async () => {
    let offline = true;
    const fetchMock = mockApi({
      onEmailChange: () => {
        if (!offline) return Response.json({ ok: true });
        offline = false;
        onlineManager.setOnline(false);
        throw new TypeError("Failed to fetch");
      },
    });
    await openAccount();

    await requestChange();

    expect(await within(section()).findByText("You're offline. The confirmation link wasn't sent.")).toBeVisible();
    expect(field()).toHaveValue("new@example.com");

    onlineManager.setOnline(true);
    await userEvent.click(within(section()).getByRole("button", { name: "Retry" }));

    expect(await within(section()).findByRole("status")).toHaveTextContent(/confirmation link/);
    expect(requestsOf(fetchMock, "POST", "/api/auth/email-change")).toHaveLength(2);
  });

  it("shows the retryable server error for a 5xx inside the section", async () => {
    mockApi({ onEmailChange: () => Response.json({ error: "auth misconfigured" }, { status: 500 }) });
    await openAccount();

    await requestChange();

    expect(await within(section()).findByText("auth misconfigured")).toBeVisible();
    expect(within(section()).getByText(/Something went wrong on our side/)).toBeVisible();
    expect(within(section()).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(field()).toHaveValue("new@example.com");
  });

  it("shows the account-changed page for a 412", async () => {
    mockApi({
      onEmailChange: () => Response.json({ error: "expected tenant mismatch", acting_tenant: "usr_b" }, { status: 412 }),
    });
    await openAccount();

    await requestChange();

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "This tab is signed in to a different account than the page expects.",
      ),
    );
  });
});

describe("account deletion", () => {
  function deleteDialog() {
    return screen.queryByRole("dialog", { name: "Delete your account?" });
  }

  async function openDeleteDialog() {
    expect(await screen.findByText("Firefox (this device)")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Delete account…" }));
    return deleteDialog()!;
  }

  async function confirmDelete() {
    const opened = await openDeleteDialog();
    await userEvent.type(within(opened).getByLabelText("Type delete to confirm"), "delete");
    await userEvent.click(within(opened).getByRole("button", { name: "Delete account" }));
  }

  it("is the last section and explains the grace and the immediate revocation", async () => {
    mockApi();
    await openAccount();

    const sections = await screen.findAllByRole("region");
    const last = sections[sections.length - 1]!;
    expect(last).toHaveAccessibleName("Delete account");
    expect(last).toHaveTextContent("revokes every browser session and API token right away");
    expect(last).toHaveTextContent("permanently deleted after seven days");
    expect(last).not.toHaveTextContent(/export|download|archive/i);
  });

  it("enables Delete only once delete is typed, and sends nothing until then", async () => {
    const fetchMock = mockApi();
    await openAccount();
    const opened = await openDeleteDialog();
    const field = within(opened).getByLabelText("Type delete to confirm");
    const confirm = within(opened).getByRole("button", { name: "Delete account" });

    expect(field).toHaveFocus();
    expect(confirm).toBeDisabled();
    for (const attempt of ["Delete", "delet", "deleted", "DELETE"]) {
      await userEvent.clear(field);
      await userEvent.type(field, attempt);
      expect(confirm).toBeDisabled();
    }
    await userEvent.click(confirm);
    expect(requestsOf(fetchMock, "DELETE", "/api/account")).toHaveLength(0);

    await userEvent.clear(field);
    await userEvent.type(field, " delete ");
    expect(confirm).toBeEnabled();
  });

  it("sends nothing when the dialog is cancelled", async () => {
    const fetchMock = mockApi();
    await openAccount();
    const opened = await openDeleteDialog();
    await userEvent.type(within(opened).getByLabelText("Type delete to confirm"), "delete");

    await userEvent.click(within(opened).getByRole("button", { name: "Cancel" }));

    expect(deleteDialog()).not.toBeInTheDocument();
    expect(requestsOf(fetchMock, "DELETE", "/api/account")).toHaveLength(0);
  });

  it("asks for a fresh sign-in when the backend needs recent authentication", async () => {
    mockApi({
      onDeleteAccount: () => Response.json({ error: "recent authentication required" }, { status: 403 }),
    });
    const { queryClient } = await openAccount();

    await confirmDelete();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Request a fresh sign-in link to confirm a sensitive change.");
    expect(within(alert).getByRole("link", { name: "Request a fresh sign-in link" })).toHaveAttribute(
      "href",
      "/login?step_up=1&next=%2Faccount%2Fsecurity",
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Account");
    expect(queryClient.getQueryData(whoamiQueryKey)).toEqual(reader);
  });

  it("signs out, forgets the account, and shows the closing page at this URL", async () => {
    const fetchMock = mockApi();
    const { router, queryClient } = await openAccount();

    await confirmDelete();

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your account is being deleted."),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    expect(screen.getByRole("main")).toHaveTextContent("permanently deleted after seven days");
    expect(router.state.location.href).toBe("/account/security");
    expect(queryClient.getQueryData(whoamiQueryKey)).toBeNull();
    expect(queryClient.getQueryData(["sessions", "usr_a"])).toBeUndefined();
    expect(requestsOf(fetchMock, "DELETE", "/api/account")).toHaveLength(1);
    expect(requestsOf(fetchMock, "POST", "/api/auth/logout")).toHaveLength(0);
  });

  it("shows the account-changed state for a 412", async () => {
    mockApi({
      onDeleteAccount: () =>
        Response.json({ error: "expected tenant mismatch", acting_tenant: "usr_b" }, { status: 412 }),
    });
    await openAccount();

    await confirmDelete();

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "This tab is signed in to a different account than the page expects.",
      ),
    );
    expect(screen.getByText("Signed in as usr_b.")).toBeVisible();
  });

  it("keeps the page for a server error, and Retry reopens the dialog without resending", async () => {
    const fetchMock = mockApi({
      onDeleteAccount: () => Response.json({ error: "storage unavailable" }, { status: 503 }),
    });
    await openAccount();

    await confirmDelete();

    expect(await screen.findByText("Something went wrong on our side. storage unavailable")).toBeVisible();
    expect(screen.getByText("Firefox (this device)")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(deleteDialog()).toBeInTheDocument();
    expect(requestsOf(fetchMock, "DELETE", "/api/account")).toHaveLength(1);
  });

  it("shows the offline notice in place when the delete cannot reach the network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const request = asRequest(input);
        const path = new URL(request.url).pathname;
        if (path === "/api/auth/sessions") return Response.json(listed);
        if (path === "/api/auth/settings") return Response.json(SETTINGS);
        if (path === "/api/account") {
          onlineManager.setOnline(false);
          throw new TypeError("Failed to fetch");
        }
        return Response.json(reader);
      }),
    );
    const { queryClient } = await openAccount();

    await confirmDelete();

    expect(await screen.findByText("You're offline. Check your connection and try again.")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Account");
    expect(queryClient.getQueryData(whoamiQueryKey)).toEqual(reader);
  });
});

