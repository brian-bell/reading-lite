import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  useLocation,
} from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER, apiFetch } from "../src/api/client";
import { ApiError } from "../src/api/errors";
import { redirectSignedInFromLogin, requireSignedIn, validateLoginSearch } from "../src/auth/guards";
import { LEGACY_BEARER_TOKEN_KEY } from "../src/auth/legacy-storage";
import { LOGIN_NEXT_STORAGE_KEY } from "../src/auth/return-path";
import { createQueryClient, hrefOnScreen } from "../src/auth/session";
import { resetTurnstileLoaderForTests } from "../src/auth/turnstile";
import { AppFrame } from "../src/components/AppFrame";
import { PageHeading } from "../src/components/PageHeading";
import { SignInPage } from "../src/components/SignInPage";
import { VerifyPage, validateVerifySearch } from "../src/components/VerifyPage";
import { whoamiQueryKey, type Identity } from "../src/identity";
import type { RouterContext } from "../src/router";
import { plainSearch } from "../src/search";

// The sign-in loop through the real guards, pages, and AppFrame, on a route
// tree shaped like src/routes (which the Start plugin binds to the document
// shell). Each render is one tab: its own router and QueryClient, sharing
// localStorage as tabs do.

const readerA: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};
const readerB: Identity = { ...readerA, tenant_id: "usr_b", user_id: "usr_b", email: "b@example.com", csrf_token: "csrf-b" };

type Handler = (request: Request) => Response | Promise<Response>;

/** Backend stand-in: a handler per `METHOD /path`, 404 otherwise. */
function stubBackend(handlers: Record<string, Handler>) {
  const calls: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      calls.push(request);
      const handler = handlers[`${request.method} ${new URL(request.url).pathname}`];
      return handler ? handler(request) : Response.json({ error: "not found" }, { status: 404 });
    }),
  );
  return calls;
}

function ReadingProbe() {
  const { id } = readingRoute.useParams();
  const queryClient = useQueryClient();
  const reading = useQuery({
    queryKey: ["reading", id],
    queryFn: async () => {
      const response = await apiFetch(queryClient, `/api/readings/${id}`);
      if (!response.ok) throw new ApiError(response.status, `reading returned ${response.status}`);
      return (await response.json()) as { title: string };
    },
    retry: false,
  });
  return (
    <div className="page">
      <PageHeading>Reading</PageHeading>
      {reading.data ? <p>{reading.data.title}</p> : null}
      {reading.error instanceof ApiError && reading.error.status === 403 ? <p>You don’t have access to this.</p> : null}
    </div>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <AppFrame theme="system" onThemeChange={() => undefined}>
      <Outlet />
    </AppFrame>
  ),
});
function LibraryProbe() {
  const { data: identity } = useQuery({ queryKey: whoamiQueryKey, enabled: false });
  const href = useLocation({ select: (location) => location.href });
  if (identity === null) return <SignInPage next={href} />;
  return (
    <div className="page">
      <PageHeading>Library</PageHeading>
      <Link to="/save">Save</Link>
    </div>
  );
}
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: LibraryProbe });
const saveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/save",
  component: () => <PageHeading>Save reading</PageHeading>,
});
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: validateLoginSearch,
  beforeLoad: redirectSignedInFromLogin,
  component: function Login() {
    const { next, step_up } = loginRoute.useSearch();
    return <SignInPage next={next} stepUp={step_up === "1"} />;
  },
});
const authVerifyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/verify",
  validateSearch: validateVerifySearch,
  component: function AuthVerify() {
    const { next, purpose } = authVerifyRoute.useSearch();
    return <VerifyPage next={next} purpose={purpose} />;
  },
});
const loginVerifyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login/verify",
  validateSearch: validateVerifySearch,
  component: function LoginVerify() {
    const { next, purpose } = loginVerifyRoute.useSearch();
    return <VerifyPage next={next} purpose={purpose} />;
  },
});
const authedRoute = createRoute({ getParentRoute: () => rootRoute, id: "_authed", beforeLoad: requireSignedIn });
const readingRoute = createRoute({ getParentRoute: () => authedRoute, path: "/readings/$id", component: ReadingProbe });
const accountRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/account/security",
  component: () => <PageHeading>Account</PageHeading>,
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  saveRoute,
  loginRoute,
  authVerifyRoute,
  loginVerifyRoute,
  authedRoute.addChildren([readingRoute, accountRoute]),
]);

async function openTab(path: string, identity: Identity | null | "unavailable") {
  const queryClient = createQueryClient(() => hrefOnScreen(router));
  // Unseeded, the whoami query runs and fails (no backend in unit tests),
  // which is the unavailable state: neither signed in nor signed out.
  if (identity !== "unavailable") queryClient.setQueryData(whoamiQueryKey, identity);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    ...plainSearch,
    history: createMemoryHistory({ initialEntries: [path] }),
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  const view = render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { level: 1 });
  return { router, queryClient, view };
}

/** Every request made so far through the stubbed fetch. */
function stubBackendCalls() {
  return () => vi.mocked(fetch).mock.calls.map(([request]) => request as Request);
}

function nav() {
  return screen.getByRole("navigation", { name: "Main" });
}

const CREDENTIAL = "ml_550e8400-e29b-41d4-a716-446655440000.deadbeef";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  delete window.turnstile;
  resetTurnstileLoaderForTests();
});

describe("direct links while signed out", () => {
  it("sends a reading link to /login?next and does not remember it until a link is requested", async () => {
    stubBackend({ "GET /api/auth/login-options": () => Response.json({ turnstile_site_key: null }) });
    const { router } = await openTab("/readings/rd_ONE", null);
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    expect(router.state.location.href).toBe("/login?next=%2Freadings%2Frd_ONE");
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBeNull();
  });

  it("renders the sign-in form in place on the library, without a redirect", async () => {
    stubBackend({ "GET /api/auth/login-options": () => Response.json({ turnstile_site_key: null }) });
    const { router } = await openTab("/", null);
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    expect(router.state.location.href).toBe("/");
  });

  it("remembers the library's filters as the return path when a link is requested", async () => {
    stubBackend({
      "GET /api/auth/login-options": () => Response.json({ turnstile_site_key: null }),
      "POST /api/auth/challenge": () => Response.json({ ok: true }),
    });
    localStorage.setItem(LOGIN_NEXT_STORAGE_KEY, "/readings/rd_OLD");
    await openTab("/?q=rust&tag=lang", null);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "a@example.com");
    await user.click(await screen.findByRole("button", { name: "Email me a link" }));
    await waitFor(() => expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBe("/?q=rust&tag=lang"));
  });
});

describe("the sign-in loop", () => {
  it("returns to the reading in a new tab and leaves no stored path behind", async () => {
    let signedIn = false;
    const calls = stubBackend({
      "GET /api/auth/login-options": () => Response.json({ turnstile_site_key: null }),
      "POST /api/auth/challenge": () => Response.json({ ok: true }),
      "POST /api/auth/redeem": () => {
        signedIn = true;
        return Response.json({ ok: true });
      },
      "GET /api/whoami": () => (signedIn ? Response.json(readerA) : Response.json({ error: "unauthorized" }, { status: 401 })),
      "GET /api/readings/rd_ONE": () => Response.json({ title: "Operator Notes" }),
    });
    const user = userEvent.setup();

    // Tab 1: the direct link, then a link request.
    const first = await openTab("/readings/rd_ONE", null);
    await user.type(screen.getByLabelText("Email"), "a@example.com");
    await user.click(await screen.findByRole("button", { name: "Email me a link" }, { timeout: 2000 }));
    expect(await screen.findByText("If that address can sign in, we sent a short-lived link.")).toBeInTheDocument();
    const challenge = calls.find((call) => new URL(call.url).pathname === "/api/auth/challenge")!;
    await expect(challenge.json()).resolves.toEqual({ email: "a@example.com" });
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBe("/readings/rd_ONE");
    first.view.unmount();

    // Tab 2: the emailed link, which carries no next.
    const second = await openTab(`/auth/verify#${CREDENTIAL}`, null);
    await waitFor(() => expect(second.router.state.location.hash).toBe(""));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Operator Notes")).toBeInTheDocument();
    expect(second.router.state.location.href).toBe("/readings/rd_ONE");
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBeNull();
    const redeem = calls.find((call) => new URL(call.url).pathname === "/api/auth/redeem")!;
    await expect(redeem.json()).resolves.toMatchObject({ credential: CREDENTIAL, redemption_id: expect.stringMatching(/^clm_/) });
    expect(within(nav()).getByRole("group", { name: "Account menu, signed in as a@example.com" })).toBeInTheDocument();

    // The current SPA's defect: visiting /login?next again while signed in
    // redirected there but left the path stored. It must stay cleared.
    await act(() => second.router.navigate({ href: "/login?next=%2Freadings%2Frd_ONE" }));
    await waitFor(() => expect(second.router.state.location.href).toBe("/readings/rd_ONE"));
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBeNull();
  });

  it.each(["/auth/verify", "/login/verify"])("redeems on %s and prefers the link's own next", async (path) => {
    localStorage.setItem(LOGIN_NEXT_STORAGE_KEY, "/readings/rd_STORED");
    stubBackend({
      "POST /api/auth/redeem": () => Response.json({ ok: true }),
      "GET /api/whoami": () => Response.json(readerA),
    });
    const { router } = await openTab(`${path}?next=%2Fsave#${CREDENTIAL}`, null);
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(router.state.location.href).toBe("/save"));
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBeNull();
  });

  it("goes to the library for an unsafe next", async () => {
    stubBackend({
      "POST /api/auth/redeem": () => Response.json({ ok: true }),
      "GET /api/whoami": () => Response.json(readerA),
    });
    const { router } = await openTab(`/auth/verify?next=${encodeURIComponent("https://evil.example")}#${CREDENTIAL}`, null);
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(router.state.location.href).toBe("/"));
  });

  it("drops the previous account when a link is redeemed during a live session", async () => {
    stubBackend({
      "POST /api/auth/redeem": () => Response.json({ ok: true }),
      "GET /api/whoami": () => Response.json(readerB),
    });
    const { queryClient } = await openTab(`/auth/verify#${CREDENTIAL}`, readerA);
    queryClient.setQueryData(["reading", "rd_ONE"], { title: "A's reading" });
    expect(within(nav()).getByRole("group", { name: /a@example\.com/ })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue" }));
    expect(await within(nav()).findByRole("group", { name: /b@example\.com/ })).toBeInTheDocument();
    expect(queryClient.getQueryData(["reading", "rd_ONE"])).toBeUndefined();
  });

  it("explains a link without its secret and never redeems", async () => {
    const calls = stubBackend({});
    await openTab("/auth/verify", null);
    expect(await screen.findByText(/missing its secret/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("shows a failed redemption and stays on the page", async () => {
    stubBackend({ "POST /api/auth/redeem": () => Response.json({ error: "link expired" }, { status: 400 }) });
    const { router } = await openTab(`/auth/verify#${CREDENTIAL}`, null);
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("link expired");
    expect(router.state.location.pathname).toBe("/auth/verify");
  });

  // Redeeming an email change is the one redemption the backend gates on CSRF
  // (auth-handlers, EMAIL_CHANGE_PURPOSE), and apiFetch reads that token from
  // the cached identity. A cold cache must therefore be filled, not bypassed
  // with a bare fetch (#384 review).
  it("sends the CSRF token when an email change is redeemed on a cold cache", async () => {
    const calls = stubBackend({
      "GET /api/whoami": () => Response.json(readerA),
      "POST /api/auth/redeem": () => Response.json({ ok: true }),
    });
    await openTab(`/auth/verify?purpose=email_change#${CREDENTIAL}`, "unavailable");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Continue" }));
    const redeem = await waitFor(() => {
      const call = calls.find((request) => new URL(request.url).pathname === "/api/auth/redeem");
      expect(call).toBeDefined();
      return call!;
    });
    expect(redeem.headers.get(CSRF_HEADER)).toBe("csrf-a");
  });

  // The emailed link carries no `next`, and was asked for on the account page
  // (#340.6.2): confirming it goes back there, not to a path another request
  // left in storage.
  it("returns to the account page after an email change is confirmed", async () => {
    stubBackend({
      "GET /api/whoami": () => Response.json(readerA),
      "POST /api/auth/redeem": () => Response.json({ ok: true }),
    });
    localStorage.setItem(LOGIN_NEXT_STORAGE_KEY, "/save");
    const { router } = await openTab(`/auth/verify?purpose=email_change#${CREDENTIAL}`, readerA);
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(router.state.location.href).toBe("/account/security"));
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBeNull();
  });

  it("asks for the signed-in browser before confirming an email change", async () => {
    const calls = stubBackend({ "GET /api/whoami": () => Response.json({ error: "unauthorized" }, { status: 401 }) });
    await openTab(`/auth/verify?purpose=email_change#${CREDENTIAL}`, null);
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("signed-in browser that requested the email change");
    expect(calls.some((call) => new URL(call.url).pathname === "/api/auth/redeem")).toBe(false);
  });
});

describe("/login", () => {
  it("sends a signed-in reader straight to next", async () => {
    const { router } = await openTab("/login?next=%2Freadings%2Frd_ONE%3Fview%3Dsource", readerA);
    stubBackend({ "GET /api/readings/rd_ONE": () => Response.json({ title: "Operator Notes" }) });
    await waitFor(() => expect(router.state.location.href).toBe("/readings/rd_ONE?view=source"));
  });

  it("keeps a signed-in reader for step-up, with the email locked", async () => {
    const calls = stubBackend({
      "GET /api/auth/login-options": () => Response.json({ turnstile_site_key: null }),
      "POST /api/auth/challenge": () => Response.json({ ok: true }),
    });
    await openTab("/login?step_up=1&next=%2Faccount%2Fsecurity", readerA);
    const email = screen.getByLabelText("Email");
    expect(email).toHaveValue("a@example.com");
    expect(email).toHaveAttribute("readonly");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Email me a link" }));
    await screen.findByText(/we sent a short-lived link/);
    const challenge = calls.find((call) => new URL(call.url).pathname === "/api/auth/challenge")!;
    await expect(challenge.json()).resolves.toEqual({ email: "a@example.com" });
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBe("/account/security");
  });

  it("forgets an older stored path when a link is requested without next", async () => {
    localStorage.setItem(LOGIN_NEXT_STORAGE_KEY, "/readings/rd_OLD");
    stubBackend({
      "GET /api/auth/login-options": () => Response.json({ turnstile_site_key: null }),
      "POST /api/auth/challenge": () => Response.json({ ok: true }),
    });
    await openTab("/login", null);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "a@example.com");
    await user.click(await screen.findByRole("button", { name: "Email me a link" }));
    await screen.findByText(/we sent a short-lived link/);
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBeNull();
  });

  it("holds the request until the Turnstile check passes, and sends its token", async () => {
    let complete: (token: string) => void = () => undefined;
    window.turnstile = {
      render: vi.fn((_el, options) => {
        complete = (token) => options.callback?.(token);
        return "widget-1";
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    const calls = stubBackend({
      "GET /api/auth/login-options": () => Response.json({ turnstile_site_key: "site-key" }),
      "POST /api/auth/challenge": () => Response.json({ ok: true }),
    });
    await openTab("/login", null);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "a@example.com");
    expect(await screen.findByRole("group", { name: "Human check" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email me a link" })).toBeDisabled();
    act(() => complete("turnstile-ok"));
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    await screen.findByText(/we sent a short-lived link/);
    const challenge = calls.find((call) => new URL(call.url).pathname === "/api/auth/challenge")!;
    await expect(challenge.json()).resolves.toEqual({ email: "a@example.com", turnstile_token: "turnstile-ok" });
  });

  it("holds the request and offers Retry when sign-in options fail", async () => {
    stubBackend({ "GET /api/auth/login-options": () => Response.json({ error: "unavailable" }, { status: 503 }) });
    await openTab("/login", null);
    expect(await screen.findByRole("alert")).toHaveTextContent("unavailable");
    expect(screen.getByRole("button", { name: "Email me a link" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("sign-out", () => {
  it("signs out from the account menu and sends a reading page to sign-in with its return path", async () => {
    const calls = stubBackend({
      "GET /api/readings/rd_ONE": () => Response.json({ title: "Operator Notes" }),
      "POST /api/auth/logout": () => Response.json({ ok: true }),
      "GET /api/auth/login-options": () => Response.json({ turnstile_site_key: null }),
    });
    const { router, queryClient } = await openTab("/readings/rd_ONE", readerA);
    await screen.findByText("Operator Notes");
    const user = userEvent.setup();
    await user.click(within(nav()).getByText("Account", { selector: "summary *" }));
    await user.click(within(nav()).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(router.state.location.href).toBe("/login?next=%2Freadings%2Frd_ONE"));
    const logout = calls.find((call) => new URL(call.url).pathname === "/api/auth/logout")!;
    expect(logout.method).toBe("POST");
    expect(logout.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(queryClient.getQueryData(["reading", "rd_ONE"])).toBeUndefined();
    expect(within(nav()).queryByRole("group", { name: /Account menu/ })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toHaveFocus();
  });
});

describe("an account changed in another tab", () => {
  // The cookie now belongs to B, so A's cached CSRF token is refused and the
  // recovery read answers as B. The reader was not signed out, and this tab is
  // no longer the account they acted on (acceptance matrix, Account changed).
  it("says the account changed and offers a reload, not a failed sign-out", async () => {
    stubBackend({
      "GET /api/readings/rd_ONE": () => Response.json({ title: "Operator Notes" }),
      "POST /api/auth/logout": () => Response.json({ error: "forbidden" }, { status: 403 }),
      "GET /api/whoami": () => Response.json(readerB),
    });
    const { router, queryClient } = await openTab("/readings/rd_ONE", readerA);
    await screen.findByText("Operator Notes");
    const user = userEvent.setup();
    await user.click(within(nav()).getByText("Account", { selector: "summary *" }));
    await user.click(within(nav()).getByRole("button", { name: "Sign out" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/different account/i);
    expect(alert).not.toHaveTextContent(/still signed in/i);
    // The menu names who this tab is now, and a reload starts clean at this URL.
    expect(await within(nav()).findByRole("group", { name: /b@example\.com/ })).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Reload" })).toHaveAttribute("href", "/readings/rd_ONE");
    // Still signed in, so no redirect to sign-in, and A's data is gone.
    expect(router.state.location.pathname).toBe("/readings/rd_ONE");
    expect(queryClient.getQueryData(["reading", "rd_ONE"])).toBeUndefined();
  });
});

describe("expired session", () => {
  it("shows “Your session ended” in place on a 401, with sign-in back to the same URL", async () => {
    stubBackend({ "GET /api/readings/rd_ONE": () => Response.json({ error: "unauthorized" }, { status: 401 }) });
    const { router } = await openTab("/readings/rd_ONE?view=source", readerA);
    expect(await screen.findByRole("heading", { level: 1, name: "Your session ended." })).toBeInTheDocument();
    expect(router.state.location.href).toBe("/readings/rd_ONE?view=source");
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login?next=%2Freadings%2Frd_ONE%3Fview%3Dsource",
    );
    expect(within(nav()).getByRole("link", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows other pages normally after the reader moves on", async () => {
    stubBackend({
      "GET /api/readings/rd_ONE": () => Response.json({ error: "unauthorized" }, { status: 401 }),
      "GET /api/auth/login-options": () => Response.json({ turnstile_site_key: null }),
    });
    const calls = stubBackendCalls();
    await openTab("/readings/rd_ONE", readerA);
    await screen.findByRole("heading", { name: "Your session ended." });
    await userEvent.setup().click(within(nav()).getByRole("link", { name: /Library/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    // The ended page is not remounted and refetched on the way out.
    expect(calls().filter((call) => new URL(call.url).pathname === "/api/readings/rd_ONE")).toHaveLength(1);
  });

  it("never treats a 403 as sign-out", async () => {
    stubBackend({ "GET /api/readings/rd_ONE": () => Response.json({ error: "forbidden" }, { status: 403 }) });
    await openTab("/readings/rd_ONE", readerA);
    expect(await screen.findByText("You don’t have access to this.")).toBeInTheDocument();
    expect(screen.queryByText("Your session ended.")).toBeNull();
    expect(within(nav()).getByRole("group", { name: /a@example\.com/ })).toBeInTheDocument();
  });
});

describe("identity that cannot be determined", () => {
  it("offers a retry on /login instead of the form, and never an editable step-up address", async () => {
    const calls = stubBackend({ "GET /api/auth/login-options": () => Response.json({ turnstile_site_key: null }) });
    for (const path of ["/login?next=%2Fsave", "/login?step_up=1&next=%2Faccount%2Fsecurity"]) {
      const tab = await openTab(path, "unavailable");
      expect(await screen.findByText("We couldn’t check whether you’re signed in.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Email")).toBeNull();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      expect(tab.router.state.location.href).toBe(path);
      tab.view.unmount();
    }
    expect(calls.some((call) => new URL(call.url).pathname === "/api/auth/challenge")).toBe(false);
  });

  it("shows neither account state in the navigation", async () => {
    stubBackend({});
    await openTab("/save", "unavailable");
    await waitFor(() => expect(within(nav()).queryByRole("group", { name: /Account menu/ })).toBeNull());
    expect(within(nav()).queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(within(nav()).queryByRole("group", { name: /Account menu/ })).toBeNull();
  });
});

describe("a failed sign-out", () => {
  it("keeps the reader signed in and says so, rather than showing a signed-out page", async () => {
    stubBackend({
      "GET /api/readings/rd_ONE": () => Response.json({ title: "Operator Notes" }),
      "POST /api/auth/logout": () => Response.json({ error: "boom" }, { status: 500 }),
      // The session outlived the failed logout.
      "GET /api/whoami": () => Response.json(readerA),
    });
    const { router, queryClient } = await openTab("/readings/rd_ONE", readerA);
    await screen.findByText("Operator Notes");
    const user = userEvent.setup();
    await user.click(within(nav()).getByText("Account", { selector: "summary *" }));
    await user.click(within(nav()).getByRole("button", { name: "Sign out" }));
    expect(await within(nav()).findByRole("alert")).toHaveTextContent("still signed in");
    expect(router.state.location.href).toBe("/readings/rd_ONE");
    expect(queryClient.getQueryData(whoamiQueryKey)).toEqual(readerA);
    expect(within(nav()).getByRole("group", { name: /a@example\.com/ })).toBeInTheDocument();
  });

  it("signs out when the failed logout left no session behind", async () => {
    stubBackend({
      "POST /api/auth/logout": () => Response.json({ error: "boom" }, { status: 500 }),
      "GET /api/whoami": () => Response.json({ error: "unauthorized" }, { status: 401 }),
      "GET /api/auth/login-options": () => Response.json({ turnstile_site_key: null }),
    });
    await openTab("/", readerA);
    const user = userEvent.setup();
    await user.click(within(nav()).getByText("Account", { selector: "summary *" }));
    await user.click(within(nav()).getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
  });
});

describe("legacy SPA storage", () => {
  it("removes the legacy bearer token at boot", async () => {
    localStorage.setItem(LEGACY_BEARER_TOKEN_KEY, "bearer-from-the-old-spa");
    await openTab("/", readerA);
    expect(localStorage.getItem(LEGACY_BEARER_TOKEN_KEY)).toBeNull();
  });
});

describe("keyboard", () => {
  it("requests a link and redeems it without a pointer", async () => {
    stubBackend({
      "GET /api/auth/login-options": () => Response.json({ turnstile_site_key: null }),
      "POST /api/auth/challenge": () => Response.json({ ok: true }),
      "POST /api/auth/redeem": () => Response.json({ ok: true }),
      "GET /api/whoami": () => Response.json(readerA),
    });
    const user = userEvent.setup();
    const first = await openTab("/login?next=%2Fsave", null);
    await waitFor(() => expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled());
    screen.getByLabelText("Email").focus();
    await user.keyboard("a@example.com{Enter}");
    expect(await screen.findByText(/we sent a short-lived link/)).toBeInTheDocument();
    first.view.unmount();

    const second = await openTab(`/auth/verify#${CREDENTIAL}`, null);
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    screen.getByRole("button", { name: "Continue" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(second.router.state.location.href).toBe("/save"));
  });
});

describe("focus", () => {
  it("moves focus to the page heading after navigation, not on the first load", async () => {
    await openTab("/", readerA);
    expect(screen.getByRole("heading", { level: 1, name: "Library" })).not.toHaveFocus();
    await userEvent.setup().click(screen.getByRole("link", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Save reading" })).toHaveFocus());
  });
});
