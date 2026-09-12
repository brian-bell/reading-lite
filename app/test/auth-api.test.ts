import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLoginOptions, logoutSession, redeemLoginLink, requestLoginLink } from "../src/api/auth";
import { CSRF_HEADER } from "../src/api/client";
import { ApiError, isUnauthorized } from "../src/api/errors";
import { whoamiQueryKey } from "../src/identity";

function stubFetch(response: () => Response) {
  const calls: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request) => {
      calls.push(input);
      return response();
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getLoginOptions", () => {
  it("returns the Turnstile site key or null", async () => {
    stubFetch(() => Response.json({ turnstile_site_key: " site-key " }));
    await expect(getLoginOptions(new QueryClient())).resolves.toEqual({ turnstile_site_key: "site-key" });
    stubFetch(() => Response.json({ turnstile_site_key: null }));
    await expect(getLoginOptions(new QueryClient())).resolves.toEqual({ turnstile_site_key: null });
  });

  it.each([
    ["an omitted key", {}],
    ["a blank key", { turnstile_site_key: "  " }],
    ["a non-string key", { turnstile_site_key: 1 }],
  ])("fails closed on %s instead of dropping the check", async (_label, body) => {
    stubFetch(() => Response.json(body));
    await expect(getLoginOptions(new QueryClient())).rejects.toThrow("failed to load sign-in options");
  });

  it("reports the backend's error", async () => {
    stubFetch(() => Response.json({ error: "unavailable" }, { status: 503 }));
    await expect(getLoginOptions(new QueryClient())).rejects.toMatchObject({ status: 503, message: "unavailable" });
  });
});

describe("requestLoginLink", () => {
  it("posts the email and a Turnstile token to /api/auth/challenge", async () => {
    const calls = stubFetch(() => Response.json({ ok: true }));
    await requestLoginLink(new QueryClient(), "reader@example.com", " token ");
    expect(calls[0]!.method).toBe("POST");
    expect(new URL(calls[0]!.url).pathname).toBe("/api/auth/challenge");
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    await expect(calls[0]!.json()).resolves.toEqual({ email: "reader@example.com", turnstile_token: "token" });
  });

  it("omits an empty token", async () => {
    const calls = stubFetch(() => Response.json({ ok: true }));
    await requestLoginLink(new QueryClient(), "reader@example.com", null);
    await expect(calls[0]!.json()).resolves.toEqual({ email: "reader@example.com" });
  });

  it("throws the backend's message", async () => {
    stubFetch(() => Response.json({ error: "rate limited" }, { status: 429 }));
    await expect(requestLoginLink(new QueryClient(), "a@example.com")).rejects.toMatchObject({
      status: 429,
      message: "rate limited",
    });
  });
});

describe("redeemLoginLink", () => {
  it("posts the credential and redemption id", async () => {
    const calls = stubFetch(() => Response.json({ ok: true }));
    await redeemLoginLink(new QueryClient(), "ml_secret", "clm_12345678");
    expect(new URL(calls[0]!.url).pathname).toBe("/api/auth/redeem");
    expect(calls[0]!.credentials).toBe("include");
    await expect(calls[0]!.json()).resolves.toEqual({ credential: "ml_secret", redemption_id: "clm_12345678" });
  });

  it("throws with a fallback message for a non-JSON failure", async () => {
    stubFetch(() => new Response("nope", { status: 400 }));
    await expect(redeemLoginLink(new QueryClient(), "ml_secret", "clm_12345678")).rejects.toMatchObject({
      status: 400,
      message: "failed to complete sign-in",
    });
  });
});

describe("logoutSession", () => {
  it("posts with this QueryClient's CSRF token", async () => {
    const calls = stubFetch(() => Response.json({ ok: true }));
    const queryClient = new QueryClient();
    queryClient.setQueryData(whoamiQueryKey, {
      tenant_id: "usr_a",
      user_id: "usr_a",
      principal: "session",
      tenant_data_plane: true,
      email: "a@example.com",
      csrf_token: "csrf-a",
    });
    await logoutSession(queryClient);
    expect(new URL(calls[0]!.url).pathname).toBe("/api/auth/logout");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get(CSRF_HEADER)).toBe("csrf-a");
  });

  it("treats 401 as already signed out", async () => {
    stubFetch(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    await expect(logoutSession(new QueryClient())).resolves.toBeUndefined();
  });

  it("throws for other failures", async () => {
    stubFetch(() => Response.json({ error: "boom" }, { status: 500 }));
    await expect(logoutSession(new QueryClient())).rejects.toBeInstanceOf(ApiError);
  });
});

describe("isUnauthorized", () => {
  it("is true only for an API 401", () => {
    expect(isUnauthorized(new ApiError(401, "x"))).toBe(true);
    expect(isUnauthorized(new ApiError(403, "x"))).toBe(false);
    expect(isUnauthorized(new Error("401"))).toBe(false);
  });
});
