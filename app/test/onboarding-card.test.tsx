import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchIdentity } from "../src/api/client";
import { Onboarding } from "../src/components/Onboarding";
import { needsProviderKey, whoamiQueryKey, type Identity } from "../src/identity";
import { deskModeOf } from "../src/onboarding";
import { providerQueryKey, type ProviderSettings } from "../src/provider";

const LIMITS = {
  effort: "high" as const,
  daily_spend_cap_microdollars: null,
  effective_daily_spend_microdollars: 2_000_000,
  operator_daily_spend_microdollars: 2_000_000,
};

const MISSING: ProviderSettings = { ...LIMITS, credential: null };
const CONNECTED: ProviderSettings = {
  ...LIMITS,
  credential: { provider: "openai", last_four: "c0de", status: "active", validated_at_ms: 1 },
};

function reader(needsKey: boolean): Identity {
  return {
    tenant_id: "usr_a",
    user_id: "usr_a",
    principal: "session",
    tenant_data_plane: true,
    needs_provider_key: needsKey,
    email: "a@example.com",
    csrf_token: "csrf-a",
  };
}

function installDialog() {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(returnValue?: string) {
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}

async function renderCard(identity: Identity = reader(true)) {
  installDialog();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(whoamiQueryKey, identity);
  queryClient.setQueryData(providerQueryKey("usr_a"), { state: "ready", value: MISSING });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: Card,
  });
  const samplesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/samples",
    component: () => <p>Samples</p>,
  });
  const saveRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/save",
    component: () => <p>Save</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, samplesRoute, saveRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { queryClient, ...view };
}

function Card() {
  const { data: identity } = useQuery({
    queryKey: whoamiQueryKey,
    queryFn: ({ signal }) => fetchIdentity(signal),
    staleTime: Infinity,
    retry: false,
  });
  if (!identity) return null;
  const mode = deskModeOf({
    keyNeeded: needsProviderKey(identity),
    shownThisMount: true,
    library: "empty",
  });
  if (mode.kind !== "onboarding") return <p>Ordinary desk</p>;
  return <Onboarding keyStep={mode.keyStep} identity={identity} />;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("new reader card", () => {
  it("clears the connected step when the key is removed and whoami cannot be reread", async () => {
    const user = userEvent.setup();
    const whoami: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request) => {
        const request = input instanceof Request ? input : new Request(input);
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path === "/api/auth/provider") {
          return Response.json(CONNECTED);
        }
        if (request.method === "DELETE" && path === "/api/auth/provider") {
          return Response.json(MISSING);
        }
        if (request.method === "GET" && path === "/api/whoami") {
          whoami.push("error");
          return new Response("nope", { status: 500 });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    const { queryClient } = await renderCard();
    await user.type(screen.getByLabelText("API key"), "sk-testkey");
    await user.click(screen.getByRole("button", { name: "Connect key" }));
    await screen.findByRole("link", { name: "Save a reading" });

    await user.click(screen.getByRole("button", { name: "Remove key…" }));
    await user.click(screen.getByRole("button", { name: "Remove key" }));

    await waitFor(() => {
      expect(whoami).toEqual(["error"]);
      expect(screen.getByRole("button", { name: "Save a reading" })).toHaveAttribute("aria-disabled", "true");
    });
    expect(screen.queryByRole("link", { name: "Save a reading" })).not.toBeInTheDocument();
    expect(screen.queryByText("Your key is connected. You can save readings now.")).not.toBeInTheDocument();
    expect(screen.getByText("Connect your OpenAI key").closest("li")).not.toHaveClass("onboarding-done");
    expect(queryClient.getQueryData<Identity>(whoamiQueryKey)?.needs_provider_key).toBe(false);
    expect(queryClient.getQueryData<Identity>(whoamiQueryKey)?.provider_key_provider).toBe(null);
  });

  it("keeps an Anthropic gate when an OpenAI key connects", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request) => {
        const request = input instanceof Request ? input : new Request(input);
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path === "/api/auth/provider") {
          return Response.json(CONNECTED);
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    const { queryClient } = await renderCard({ ...reader(true), provider_key_provider: "anthropic" });
    await user.type(screen.getByLabelText("API key"), "sk-testkey");
    await user.click(screen.getByRole("button", { name: "Connect key" }));
    await screen.findByRole("button", { name: "Replace key" });

    const cached = queryClient.getQueryData<Identity>(whoamiQueryKey);
    expect(cached?.needs_provider_key).toBe(true);
    expect(cached?.provider_key_provider).toBe("anthropic");
    expect(screen.queryByRole("link", { name: "Save a reading" })).not.toBeInTheDocument();
  });
});
