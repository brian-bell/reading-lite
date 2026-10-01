import { QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireSignedIn } from "../src/auth/guards";
import { createQueryClient, hrefOnScreen } from "../src/auth/session";
import { AppFrame } from "../src/components/AppFrame";
import { PageHeading } from "../src/components/PageHeading";
import { ProviderPage } from "../src/components/ProviderPage";
import { SignInPage } from "../src/components/SignInPage";
import { whoamiQueryKey, type Identity } from "../src/identity";
import type { RouterContext } from "../src/router";
import { plainSearch } from "../src/search";

// /account/provider (reading-lite-gh341.8): each key state, connect, replace,
// and remove with their refusals, effort, and the daily limit with today's
// charges. The browser's /api/auth/provider calls are a stubbed fetch;
// identity is seeded as the account page's tests seed it.

const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

const KEY = "sk-proj-0123456789c0de";
const ACTIVE = { provider: "openai", last_four: "c0de", status: "active", validated_at_ms: 1_000 };

const MISSING = {
  credential: null,
  effort: "high",
  daily_spend_cap_microdollars: null,
  effective_daily_spend_microdollars: 2_000_000,
  operator_daily_spend_microdollars: 2_000_000,
};
const CONNECTED = { ...MISSING, credential: ACTIVE };
const INVALID = { ...MISSING, credential: { ...ACTIVE, status: "invalid" } };

const USAGE = {
  day_key: "2026-09-29",
  charged_microdollars: 120_000,
  effective_daily_spend_microdollars: 2_000_000,
  reset_at_ms: Date.parse("2026-09-30T00:00:00Z"),
  observed_at_ms: 1,
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
const providerRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/account/provider",
  component: ProviderPage,
});
const routeTree = rootRoute.addChildren([indexRoute, loginRoute, authedRoute.addChildren([providerRoute])]);

function asRequest(input: RequestInfo | URL): Request {
  return input instanceof Request ? input : new Request(String(input));
}

type Answer = Response | ((body: Record<string, unknown>) => Response);

function mockApi(options: {
  settings?: unknown;
  settingsStatus?: number;
  usage?: () => Response;
  onConnect?: Answer;
  onRemove?: () => Response;
  onPreferences?: Answer;
} = {}) {
  let stored = (options.settings ?? MISSING) as Record<string, unknown>;
  const answer = (given: Answer | undefined, body: Record<string, unknown>, fallback: () => Response) =>
    given === undefined ? fallback() : typeof given === "function" ? given(body) : given;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const request = asRequest(input);
    const path = new URL(request.url).pathname;
    if (path === "/api/whoami") return Response.json(reader);
    if (path === "/api/auth/login-options") return Response.json({ turnstile_site_key: null });
    if (path === "/api/auth/provider/usage") return options.usage?.() ?? Response.json(USAGE);
    if (path === "/api/auth/provider" && request.method === "GET") {
      return Response.json(stored, { status: options.settingsStatus ?? 200 });
    }
    if (path === "/api/auth/provider" && request.method === "POST") {
      const body = (await request.clone().json()) as Record<string, unknown>;
      return answer(options.onConnect, body, () => {
        stored = { ...stored, credential: { ...ACTIVE, last_four: String(body.api_key).slice(-4) } };
        return Response.json(stored);
      });
    }
    if (path === "/api/auth/provider" && request.method === "DELETE") {
      if (options.onRemove) return options.onRemove();
      stored = { ...stored, credential: null };
      return Response.json(stored);
    }
    if (path === "/api/auth/provider/preferences" && request.method === "POST") {
      const body = (await request.clone().json()) as Record<string, unknown>;
      return answer(options.onPreferences, body, () => {
        const cap = body.daily_spend_cap_microdollars as number | null | undefined;
        stored = {
          ...stored,
          ...(body.effort === undefined ? {} : { effort: body.effort }),
          ...(cap === undefined
            ? {}
            : {
                daily_spend_cap_microdollars: cap,
                effective_daily_spend_microdollars: cap ?? stored.operator_daily_spend_microdollars,
              }),
        };
        return Response.json(stored);
      });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestsOf(fetchMock: ReturnType<typeof vi.fn>, method: string, path: string): Request[] {
  return fetchMock.mock.calls
    .map((call) => asRequest(call[0] as RequestInfo | URL))
    .filter((request) => request.method === method && new URL(request.url).pathname === path);
}

async function openProvider(identity: Identity | null = reader) {
  const queryClient = createQueryClient(() => hrefOnScreen(router));
  queryClient.setQueryData(whoamiQueryKey, identity);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    ...plainSearch,
    history: createMemoryHistory({ initialEntries: ["/account/provider"] }),
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.status).toBe("idle"));
  await screen.findByRole("heading", { level: 1 });
  return { router, queryClient };
}

/** A paragraph by its whole text, across the <strong> that sets off a key's last four. */
const paragraph = (text: RegExp) => (_: string, element: Element | null) =>
  element?.tagName === "P" && text.test(element.textContent ?? "");

const keySection = () => screen.getByRole("region", { name: "OpenAI" });
const spendingSection = () => screen.getByRole("region", { name: "Daily spending limit" });

async function connectWith(key: string) {
  const user = userEvent.setup();
  const field = await within(keySection()).findByLabelText(/API key/);
  await user.clear(field);
  if (key !== "") await user.type(field, key);
  await user.click(within(keySection()).getByRole("button", { name: /(Connect|Replace) key/ }));
  return user;
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  cleanup();
});

describe("the provider page", () => {
  it("sends a signed-out reader to sign in and back", async () => {
    mockApi();
    const { router } = await openProvider(null);
    expect(router.state.location.href).toBe("/login?next=%2Faccount%2Fprovider");
  });

  it.each([
    ["missing", MISSING, "Not connected", /Connect your OpenAI API key/, "Connect key"],
    ["connected", CONNECTED, "Connected", /Key ending in c0de, checked/, "Replace key"],
    ["invalid", INVALID, "Key not accepted", /OpenAI no longer accepts the key ending in c0de/, "Replace key"],
  ])("shows a %s key", async (_state, settings, status, text, action) => {
    mockApi({ settings });
    await openProvider();
    const section = keySection();
    expect(await within(section).findByText(status)).toBeInTheDocument();
    expect(within(section).getByText(paragraph(text))).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: action })).toBeEnabled();
    expect(within(section).queryByRole("button", { name: "Remove key…" }) !== null).toBe(settings !== MISSING);
    expect(within(section).getByText(/billed to your OpenAI account/)).toBeInTheDocument();
    expect(within(section).getByText(/hosting limits/)).toBeInTheDocument();
  });

  it("connects a key, then shows only its last four and forgets the field", async () => {
    const fetchMock = mockApi();
    const { queryClient } = await openProvider();
    await connectWith(`  ${KEY}  `);

    expect(await within(keySection()).findByText("Connected")).toBeInTheDocument();
    expect(within(keySection()).getByText(paragraph(/Key ending in c0de/))).toBeInTheDocument();
    expect(within(keySection()).getByLabelText("New API key")).toHaveValue("");
    const [post] = requestsOf(fetchMock, "POST", "/api/auth/provider");
    await expect(post!.json()).resolves.toEqual({ api_key: KEY });
    const stored = [...Object.values({ ...localStorage }), ...Object.values({ ...sessionStorage })].join("\n");
    expect(stored).not.toContain(KEY);
    const mutations = queryClient.getMutationCache().getAll().map((mutation) => mutation.state);
    expect(JSON.stringify(mutations)).not.toContain(KEY);
    // Connecting may move the limit, so today's charges are read again.
    await waitFor(() => expect(requestsOf(fetchMock, "GET", "/api/auth/provider/usage")).toHaveLength(2));
  });

  // Onboarding (reading-lite-gh341.11): the key was what saving waited for.
  it("offers a first save once a reader who needed a key connects one", async () => {
    mockApi();
    const { queryClient } = await openProvider({ ...reader, needs_provider_key: true });
    expect(screen.queryByRole("link", { name: "Save a reading" })).toBeNull();
    await connectWith(KEY);

    const next = await screen.findByRole("complementary", { name: "Next step" });
    expect(within(next).getByRole("link", { name: "Save a reading" })).toHaveAttribute("href", "/save");
    expect(queryClient.getQueryData<Identity>(whoamiQueryKey)?.needs_provider_key).toBe(false);
  });

  it("offers no first save to a reader who could already save", async () => {
    mockApi();
    await openProvider();
    await connectWith(KEY);

    expect(await within(keySection()).findByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Save a reading" })).toBeNull();
  });

  it.each([
    ["an empty field", "", "Enter your OpenAI API key."],
    ["a key with a space", "sk-proj abc", "Paste the whole key, with no spaces."],
  ])("refuses %s before any request, under the field", async (_case, key, error) => {
    const fetchMock = mockApi();
    await openProvider();
    await connectWith(key);

    const field = within(keySection()).getByLabelText("API key");
    expect(within(keySection()).getByText(error)).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveFocus();
    expect(requestsOf(fetchMock, "POST", "/api/auth/provider")).toHaveLength(0);
  });

  it.each([
    ["invalid_key", "invalid key", /OpenAI didn't accept this key/],
    ["model_access", "model access", /can't use the models Reading Lite needs/],
  ])("shows OpenAI's %s refusal under the field and keeps the key there", async (code, error, text) => {
    mockApi({ onConnect: Response.json({ error, code }, { status: 400 }) });
    await openProvider();
    await connectWith(KEY);

    expect(await within(keySection()).findByText(text)).toBeInTheDocument();
    expect(within(keySection()).getByLabelText("API key")).toHaveValue(KEY);
    expect(within(keySection()).getByText("Not connected")).toBeInTheDocument();
  });

  it("says OpenAI could not be reached, and nothing was saved", async () => {
    mockApi({
      onConnect: Response.json({ error: "provider unavailable", code: "provider_unavailable" }, { status: 503 }),
    });
    await openProvider();
    await connectWith(KEY);

    expect(await within(keySection()).findByRole("alert")).toHaveTextContent(
      "We couldn't reach OpenAI to check your key, so it wasn't saved.",
    );
  });

  it("asks for a fresh sign-in that returns here when connecting needs one", async () => {
    mockApi({ onConnect: Response.json({ error: "recent authentication required" }, { status: 403 }) });
    await openProvider();
    await connectWith(KEY);

    const alert = await within(keySection()).findByRole("alert");
    expect(alert).toHaveTextContent("Recent sign-in required. Your key wasn't saved.");
    expect(within(alert).getByRole("link", { name: "Request a fresh sign-in link" })).toHaveAttribute(
      "href",
      "/login?step_up=1&next=%2Faccount%2Fprovider",
    );
  });

  it("confirms a removal, says what it may still cost, then what stays", async () => {
    const fetchMock = mockApi({ settings: CONNECTED });
    await openProvider();
    const user = userEvent.setup();
    await user.click(await within(keySection()).findByRole("button", { name: "Remove key…" }));

    const dialog = screen.getByRole("dialog", { name: "Remove your OpenAI key?" });
    expect(dialog).toHaveTextContent("Requests already sent to OpenAI may still finish and be charged");
    expect(requestsOf(fetchMock, "DELETE", "/api/auth/provider")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Remove key" }));

    expect(await within(keySection()).findByText("Removed")).toBeInTheDocument();
    expect(within(keySection()).getByText(/Your readings, their sources, and search stay as they are/)).toBeInTheDocument();
    expect(within(keySection()).getByRole("button", { name: "Connect key" })).toBeEnabled();
    expect(within(keySection()).queryByRole("button", { name: "Remove key…" })).toBeNull();
    expect(requestsOf(fetchMock, "DELETE", "/api/auth/provider")).toHaveLength(1);
  });

  it("asks for a fresh sign-in when removing needs one, and keeps the key", async () => {
    mockApi({
      settings: CONNECTED,
      onRemove: () => Response.json({ error: "recent authentication required" }, { status: 403 }),
    });
    await openProvider();
    const user = userEvent.setup();
    await user.click(await within(keySection()).findByRole("button", { name: "Remove key…" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove key" }));

    expect(await within(keySection()).findByRole("alert")).toHaveTextContent("Your key wasn't removed.");
    expect(within(keySection()).getByText("Connected")).toBeInTheDocument();
  });

  it("saves a new effort as it is chosen", async () => {
    const fetchMock = mockApi();
    await openProvider();
    const effort = await screen.findByRole("combobox", { name: "Effort" });
    expect(effort).toHaveValue("high");
    await userEvent.setup().selectOptions(effort, "low");

    await waitFor(() => expect(requestsOf(fetchMock, "POST", "/api/auth/provider/preferences")).toHaveLength(1));
    await expect(requestsOf(fetchMock, "POST", "/api/auth/provider/preferences")[0]!.json()).resolves.toEqual({
      effort: "low",
    });
    await waitFor(() => expect(effort).toBeEnabled());
    expect(effort).toHaveValue("low");
  });

  it("shows today's charges against the limit", async () => {
    mockApi();
    await openProvider();
    expect(await within(spendingSection()).findByText(/Today:/)).toHaveTextContent("Today: $0.12 of your $2.00 limit.");
  });

  it("keeps the limit usable when today's charges are unavailable", async () => {
    mockApi({ usage: () => Response.json({ error: "usage unavailable" }, { status: 503 }) });
    await openProvider();
    expect(await within(spendingSection()).findByText("Today's charges aren't available right now.")).toBeInTheDocument();
    expect(within(spendingSection()).getByRole("button", { name: "Save limit" })).toBeEnabled();
  });

  it("lowers the limit, then puts Reading Lite's back", async () => {
    const fetchMock = mockApi();
    await openProvider();
    const user = userEvent.setup();
    const field = await within(spendingSection()).findByLabelText("Daily limit in US dollars");
    expect(field).toHaveValue("2.00");
    expect(within(spendingSection()).queryByRole("button", { name: "Use Reading Lite's limit" })).toBeNull();
    await user.clear(field);
    await user.type(field, "0.5");
    await user.click(within(spendingSection()).getByRole("button", { name: "Save limit" }));

    expect(await within(spendingSection()).findByRole("status")).toHaveTextContent("Daily limit saved: $0.50.");
    expect(field).toHaveValue("0.50");
    await user.click(within(spendingSection()).getByRole("button", { name: "Use Reading Lite's limit" }));
    await waitFor(() => expect(field).toHaveValue("2.00"));

    const bodies = await Promise.all(
      requestsOf(fetchMock, "POST", "/api/auth/provider/preferences").map((request) => request.json()),
    );
    expect(bodies).toEqual([{ daily_spend_cap_microdollars: 500_000 }, { daily_spend_cap_microdollars: null }]);
  });

  it.each([
    ["above Reading Lite's", "2.50", /can't be higher than Reading Lite's daily limit of \$2\.00/],
    ["zero", "0", "Enter an amount more than $0."],
    ["not an amount", "two", "Enter an amount in dollars, like 1.50."],
  ])("refuses a limit %s before any request", async (_case, value, error) => {
    const fetchMock = mockApi();
    await openProvider();
    const user = userEvent.setup();
    const field = await within(spendingSection()).findByLabelText("Daily limit in US dollars");
    await user.clear(field);
    await user.type(field, value);
    await user.click(within(spendingSection()).getByRole("button", { name: "Save limit" }));

    expect(within(spendingSection()).getByText(error)).toBeInTheDocument();
    expect(field).toHaveFocus();
    expect(requestsOf(fetchMock, "POST", "/api/auth/provider/preferences")).toHaveLength(0);
  });

  it("shows the backend's refusal of a limit above a newly lowered default", async () => {
    mockApi({
      onPreferences: Response.json(
        { error: "cap above operator default", code: "cap_above_operator_default" },
        { status: 400 },
      ),
    });
    await openProvider();
    const user = userEvent.setup();
    const field = await within(spendingSection()).findByLabelText("Daily limit in US dollars");
    await user.clear(field);
    await user.type(field, "1");
    await user.click(within(spendingSection()).getByRole("button", { name: "Save limit" }));

    expect(await within(spendingSection()).findByText(/can't be higher than Reading Lite's daily limit/)).toBeInTheDocument();
  });

  it("retries putting Reading Lite's limit back, not the lowered one", async () => {
    let fail = true;
    const fetchMock = mockApi({
      settings: { ...MISSING, daily_spend_cap_microdollars: 500_000, effective_daily_spend_microdollars: 500_000 },
      onPreferences: (body) => {
        if (fail) {
          fail = false;
          return Response.json({ error: "internal" }, { status: 500 });
        }
        return Response.json({ ...MISSING, ...body });
      },
    });
    await openProvider();
    const user = userEvent.setup();
    await user.click(await within(spendingSection()).findByRole("button", { name: "Use Reading Lite's limit" }));
    await user.click(await within(spendingSection()).findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(requestsOf(fetchMock, "POST", "/api/auth/provider/preferences")).toHaveLength(2));
    const bodies = await Promise.all(
      requestsOf(fetchMock, "POST", "/api/auth/provider/preferences").map((request) => request.json()),
    );
    expect(bodies).toEqual([{ daily_spend_cap_microdollars: null }, { daily_spend_cap_microdollars: null }]);
  });

  it("reads today's charges again when the page is visited again", async () => {
    const fetchMock = mockApi();
    const { router } = await openProvider();
    await within(spendingSection()).findByText(/Today:/);
    await router.navigate({ to: "/" });
    await router.navigate({ to: "/account/provider" });

    await waitFor(() => expect(requestsOf(fetchMock, "GET", "/api/auth/provider/usage")).toHaveLength(2));
  });

  it.each([
    [403, { error: "forbidden" }, "You don't have access to this."],
    [412, { error: "expected tenant mismatch", acting_tenant: "usr_b" }, "This tab is signed in to a different account than the page expects."],
    [500, { error: "internal" }, "Something went wrong on our side."],
  ])("shows the page's state for a %i read", async (status, body, heading) => {
    mockApi({ settings: body, settingsStatus: status });
    await openProvider();
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(heading));
  });

  it("shows the page's refused state when a write is refused for the account", async () => {
    mockApi({ onPreferences: Response.json({ error: "expected tenant mismatch", acting_tenant: "usr_b" }, { status: 412 }) });
    await openProvider();
    await userEvent.setup().selectOptions(await screen.findByRole("combobox", { name: "Effort" }), "medium");
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "This tab is signed in to a different account than the page expects.",
      ),
    );
  });
});
