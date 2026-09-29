import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "../src/api/client";
import {
  connectProviderKey,
  fetchProvider,
  fetchProviderUsage,
  removeProviderKey,
  saveProviderPreferences,
} from "../src/api/provider";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";
import { whoamiQueryKey, type Identity } from "../src/identity";

const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

const settings = {
  credential: null,
  effort: "high",
  daily_spend_cap_microdollars: null,
  effective_daily_spend_microdollars: 2_000_000,
  operator_daily_spend_microdollars: 2_000_000,
};

function signedIn(): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(whoamiQueryKey, reader);
  return queryClient;
}

function stubFetch(...responses: Response[]) {
  const queue = [...responses];
  vi.stubGlobal("fetch", vi.fn(async () => queue.shift() ?? Response.json(reader)));
}

function requests(): Request[] {
  return vi.mocked(fetch).mock.calls.map((call) => call[0] as unknown as Request);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider reads", () => {
  it.each([
    ["the settings", fetchProvider, "/api/auth/provider", settings],
    [
      "today's usage",
      fetchProviderUsage,
      "/api/auth/provider/usage",
      { day_key: "2026-09-29", charged_microdollars: 0, effective_daily_spend_microdollars: 1, reset_at_ms: 2, observed_at_ms: 1 },
    ],
  ])("reads %s with the session cookie and the tenant pin, never CSRF", async (_name, read, path, body) => {
    stubFetch(Response.json(body));
    await expect(read(signedIn(), "usr_a")).resolves.toEqual({ state: "ready", value: body });

    const [request] = requests();
    expect(new URL(request!.url).pathname).toBe(path);
    expect(request!.method).toBe("GET");
    expect(request!.credentials).toBe("include");
    expect(request!.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
    expect(request!.headers.get(CSRF_HEADER)).toBeNull();
  });
});

describe("provider writes", () => {
  it("connects with the key in the JSON body, CSRF, and the tenant pin", async () => {
    stubFetch(Response.json({ ...settings, credential: { provider: "openai", last_four: "c0de", status: "active", validated_at_ms: 1 } }));
    await expect(connectProviderKey(signedIn(), "sk-proj-c0de", "usr_a")).resolves.toMatchObject({ kind: "saved" });

    const [request] = requests();
    expect(new URL(request!.url).pathname).toBe("/api/auth/provider");
    expect(request!.method).toBe("POST");
    expect(request!.headers.get("content-type")).toBe("application/json");
    expect(request!.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(request!.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
    await expect(request!.json()).resolves.toEqual({ api_key: "sk-proj-c0de" });
  });

  it("removes with CSRF and the tenant pin", async () => {
    stubFetch(Response.json(settings));
    await expect(removeProviderKey(signedIn(), "usr_a")).resolves.toMatchObject({ kind: "saved" });

    const [request] = requests();
    expect(new URL(request!.url).pathname).toBe("/api/auth/provider");
    expect(request!.method).toBe("DELETE");
    expect(request!.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(request!.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
  });

  it("saves preferences as JSON with CSRF and the tenant pin", async () => {
    stubFetch(Response.json({ ...settings, effort: "low" }));
    await saveProviderPreferences(signedIn(), { effort: "low", daily_spend_cap_microdollars: null }, "usr_a");

    const [request] = requests();
    expect(new URL(request!.url).pathname).toBe("/api/auth/provider/preferences");
    expect(request!.method).toBe("POST");
    expect(request!.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(request!.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
    await expect(request!.json()).resolves.toEqual({ effort: "low", daily_spend_cap_microdollars: null });
  });

  it("asks who is signed in after a plain 403, but not after a step-up 403", async () => {
    const other = { ...reader, tenant_id: "usr_b", user_id: "usr_b" };
    stubFetch(Response.json({ error: "forbidden" }, { status: 403 }), Response.json(other));
    await expect(removeProviderKey(signedIn(), "usr_a")).resolves.toEqual({
      kind: "account-changed",
      actingTenant: "usr_b",
    });
    expect(requests().map((request) => new URL(request.url).pathname)).toEqual(["/api/auth/provider", "/api/whoami"]);

    stubFetch(Response.json({ error: "recent authentication required" }, { status: 403 }));
    await expect(connectProviderKey(signedIn(), "sk-proj-c0de", "usr_a")).resolves.toEqual({ kind: "step-up" });
    expect(requests()).toHaveLength(1);
  });
});
