import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "../src/api/client";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";
import { fetchSessions, revokeAllSessions, revokeSession } from "../src/api/sessions";
import { whoamiQueryKey, type Identity } from "../src/identity";

const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

const listed = {
  sessions: [
    {
      id: "ses_1",
      current: true,
      authenticated_at_ms: 1,
      last_seen_at_ms: 2,
      revoked_at_ms: null,
      revocation_reason: null,
      user_agent_label: "Firefox",
      usable: true,
    },
  ],
  session_cap_warning: null,
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

describe("fetchSessions", () => {
  it("calls the sessions endpoint with the session cookie and the tenant pin", async () => {
    stubFetch(Response.json(listed));
    await fetchSessions(signedIn(), "usr_a");

    const request = lastRequest();
    expect(new URL(request.url).pathname).toBe("/api/auth/sessions");
    expect(request.method).toBe("GET");
    expect(request.credentials).toBe("include");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
  });

  it("sends no pin when there is no identity to pin to", async () => {
    stubFetch(Response.json(listed));
    await fetchSessions(signedIn(), undefined);
    expect(lastRequest().headers.get(EXPECTED_TENANT_HEADER)).toBeNull();
  });
});

describe("revokeSession", () => {
  it("deletes the session with CSRF and the tenant pin", async () => {
    stubFetch(Response.json({ ok: true }));
    await revokeSession(signedIn(), "ses_1", "usr_a");

    const request = lastRequest();
    expect(new URL(request.url).pathname).toBe("/api/auth/sessions/ses_1");
    expect(request.method).toBe("DELETE");
    expect(request.credentials).toBe("include");
    expect(request.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
  });

  it("escapes the id", async () => {
    stubFetch(Response.json({ ok: true }));
    await revokeSession(signedIn(), "ses 1/../two", "usr_a");
    expect(new URL(lastRequest().url).pathname).toBe("/api/auth/sessions/ses%201%2F..%2Ftwo");
  });
});

describe("revokeAllSessions", () => {
  it("posts an empty JSON body with CSRF and the tenant pin", async () => {
    stubFetch(Response.json({ ok: true }));
    await revokeAllSessions(signedIn(), "usr_a");

    const request = lastRequest();
    expect(new URL(request.url).pathname).toBe("/api/auth/sessions/revoke-all");
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
    await expect(request.json()).resolves.toEqual({});
  });
});
