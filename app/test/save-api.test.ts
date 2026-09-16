import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors";
import { CSRF_HEADER } from "../src/api/client";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";
import { submitReading } from "../src/api/save";
import { whoamiQueryKey, type Identity } from "../src/identity";

// The browser path: same-origin POST /api/readings with the session cookie,
// the CSRF token from the cached whoami, and the tenant pin.

const ACCEPTED = {
  id: "rd_FXPENDNG01",
  status: "pending",
  poll: "/api/readings/rd_FXPENDNG01",
  attempt_id: "att_1",
};

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

function stubFetch(response: Response) {
  vi.stubGlobal("fetch", vi.fn(async () => response));
}

function lastRequest(): Request {
  return vi.mocked(fetch).mock.calls[0]![0] as unknown as Request;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submitReading", () => {
  it("posts the URL as JSON with the session cookie, the CSRF token, and the tenant pin", async () => {
    stubFetch(Response.json(ACCEPTED, { status: 202 }));
    await submitReading(signedIn(), "https://example.com/a", "usr_a");

    const request = lastRequest();
    expect(new URL(request.url).pathname).toBe("/api/readings");
    expect(request.method).toBe("POST");
    expect(request.credentials).toBe("include");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
    await expect(request.json()).resolves.toEqual({ url: "https://example.com/a" });
  });

  it("sends no pin when there is no identity to pin to", async () => {
    stubFetch(Response.json(ACCEPTED, { status: 202 }));
    await submitReading(signedIn(), "https://example.com/a", undefined);

    expect(lastRequest().headers.get(EXPECTED_TENANT_HEADER)).toBeNull();
  });

  it("maps a 202 to the accepted reading", async () => {
    stubFetch(Response.json(ACCEPTED, { status: 202 }));

    await expect(submitReading(signedIn(), "https://example.com/a", "usr_a")).resolves.toEqual({
      kind: "accepted",
      id: "rd_FXPENDNG01",
    });
  });

  it("maps a 400 to the backend's rejection", async () => {
    stubFetch(Response.json({ error: "url rejected: host is not allowed", code: "unsupported_url" }, { status: 400 }));

    await expect(submitReading(signedIn(), "https://blocked.example/a", "usr_a")).resolves.toEqual({
      kind: "invalid",
      message: "url rejected: host is not allowed",
    });
  });

  // A 401 has to reach the caller as an ApiError: the mutation cache is what
  // turns it into the session-ended page (auth/session.ts).
  it("throws an ApiError for a 401", async () => {
    stubFetch(Response.json({ error: "unauthorized" }, { status: 401 }));

    await expect(submitReading(signedIn(), "https://example.com/a", "usr_a")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });

  // The CSRF check runs before the tenant pin (src/middleware.ts), so the
  // cross-tab account switch answers 403, never the 412 the pin would give.
  // Only whoever is signed in now tells the two apart.
  describe("on a 403", () => {
    const readerB: Identity = { ...reader, tenant_id: "usr_b", user_id: "usr_b", email: "b@example.com" };

    function stubByPath(whoami: Response) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: Request) =>
          new URL(request.url).pathname === "/api/whoami"
            ? whoami
            : Response.json({ error: "forbidden" }, { status: 403 }),
        ),
      );
    }

    it("is the account-changed state when another account is signed in now", async () => {
      stubByPath(Response.json(readerB));

      await expect(submitReading(signedIn(), "https://example.com/a", "usr_a")).resolves.toEqual({
        kind: "account-changed",
        actingTenant: "usr_b",
      });
    });

    it("stays forbidden when the same account is signed in", async () => {
      stubByPath(Response.json(reader));

      await expect(submitReading(signedIn(), "https://example.com/a", "usr_a")).resolves.toEqual({
        kind: "forbidden",
      });
    });

    it("stays forbidden when identity cannot be read", async () => {
      stubByPath(new Response("<html>gateway</html>", { status: 502 }));

      await expect(submitReading(signedIn(), "https://example.com/a", "usr_a")).resolves.toEqual({
        kind: "forbidden",
      });
    });

    it("is the ended session when nobody is signed in now", async () => {
      stubByPath(Response.json({ error: "unauthorized" }, { status: 401 }));

      await expect(submitReading(signedIn(), "https://example.com/a", "usr_a")).rejects.toMatchObject({
        name: "ApiError",
        status: 401,
      });
    });
  });

  it("decides from the status when the body is not JSON", async () => {
    stubFetch(new Response("<html>gateway</html>", { status: 502 }));

    await expect(submitReading(signedIn(), "https://example.com/a", "usr_a")).rejects.toBeInstanceOf(ApiError);
  });
});
