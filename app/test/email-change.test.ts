import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "../src/api/client";
import { requestEmailChange } from "../src/api/email-change";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";
import { emailChangeFromResponse } from "../src/email-change";
import { whoamiQueryKey, type Identity } from "../src/identity";

// What POST /api/auth/email-change answers (#340.6.2), and the request the
// browser sends. The page's rendering of each outcome is account-page's.

const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

function signedIn(): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(whoamiQueryKey, reader);
  return queryClient;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("emailChangeFromResponse", () => {
  it.each([
    [200, { ok: true }, { kind: "sent" }],
    [400, { error: "invalid body" }, { kind: "invalid" }],
    [401, { error: "unauthorized" }, { kind: "step-up" }],
    [403, { error: "recent authentication required" }, { kind: "step-up" }],
    [412, { error: "expected tenant mismatch", acting_tenant: "usr_b" }, { kind: "account-changed", actingTenant: "usr_b" }],
  ])("maps %i to its outcome", (status, body, outcome) => {
    expect(emailChangeFromResponse(status, body)).toEqual(outcome);
  });

  it("throws a 5xx with the backend's message, or the SPA's fallback", () => {
    expect(() => emailChangeFromResponse(500, { error: "auth misconfigured" })).toThrow(
      expect.objectContaining({ status: 500, message: "auth misconfigured" }),
    );
    expect(() => emailChangeFromResponse(502, null)).toThrow(
      expect.objectContaining({ status: 502, message: "failed to request email change" }),
    );
  });
});

describe("requestEmailChange", () => {
  it("posts the address with CSRF and the tenant pin", async () => {
    const fetchMock = vi.fn(async (_request: Request) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestEmailChange(signedIn(), "new@example.com", "usr_a")).resolves.toEqual({ kind: "sent" });

    const request = fetchMock.mock.calls[0]![0];
    expect(new URL(request.url).pathname).toBe("/api/auth/email-change");
    expect(request.method).toBe("POST");
    expect(request.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
    await expect(request.json()).resolves.toEqual({ email: "new@example.com" });
  });

  it.each([
    ["the same reader, so it is the recent-auth gate", reader, { kind: "step-up" }],
    [
      "another account, signed in from another tab",
      { ...reader, tenant_id: "usr_b", user_id: "usr_b" },
      { kind: "account-changed", actingTenant: "usr_b" },
    ],
  ])("reads a 403 by who is signed in now: %s", async (_case, now, outcome) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request) =>
        new URL(input.url).pathname === "/api/whoami"
          ? Response.json(now)
          : Response.json({ error: "forbidden" }, { status: 403 }),
      ),
    );

    await expect(requestEmailChange(signedIn(), "new@example.com", "usr_a")).resolves.toEqual(outcome);
  });
});
