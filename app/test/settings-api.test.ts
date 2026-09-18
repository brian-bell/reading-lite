import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "../src/api/client";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";
import { fetchSettings, saveSettings } from "../src/api/settings";
import { whoamiQueryKey, type Identity } from "../src/identity";

const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

const row = {
  notify_immediate: true,
  digest_cadence: "off",
  time_zone: "UTC",
  digest_hour_local: 8,
  digest_weekday: 1,
};

function signedIn(): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(whoamiQueryKey, reader);
  return queryClient;
}

function stubFetch(response: Response) {
  vi.stubGlobal("fetch", vi.fn(async () => response));
}

function lastRequest(): Request {
  return vi.mocked(fetch).mock.calls[0]![0] as unknown as Request;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSettings", () => {
  it("reads the settings with the session cookie and the tenant pin", async () => {
    stubFetch(Response.json(row));
    await fetchSettings(signedIn(), "usr_a");

    const request = lastRequest();
    expect(new URL(request.url).pathname).toBe("/api/auth/settings");
    expect(request.method).toBe("GET");
    expect(request.credentials).toBe("include");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
  });
});

describe("saveSettings", () => {
  it("posts the body as JSON with CSRF and the tenant pin", async () => {
    stubFetch(Response.json({ ...row, notify_immediate: false }));
    await saveSettings(signedIn(), { notify_immediate: false }, "usr_a");

    const request = lastRequest();
    expect(new URL(request.url).pathname).toBe("/api/auth/settings");
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
    await expect(request.json()).resolves.toEqual({ notify_immediate: false });
  });
});
