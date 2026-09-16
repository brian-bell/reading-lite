import { QueryClient, onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER, apiFetch, fetchIdentity } from "../src/api/client";
import { NetworkError } from "../src/api/errors";
import { whoamiQueryKey, type Identity } from "../src/identity";

function identity(csrf: string): Identity {
  return {
    tenant_id: "usr_a",
    user_id: "usr_a",
    principal: "session",
    tenant_data_plane: true,
    email: "a@example.com",
    csrf_token: csrf,
  };
}

function stubFetch(response: Response = new Response("{}", { status: 200 })) {
  const calls: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request) => {
      calls.push(input);
      return response.clone();
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Browser calls go to same-origin /api/* with the session cookie and the CSRF
// token from whoami, as web/src/api.ts does (ADR 0003, Browser requests).
describe("apiFetch", () => {
  it("sends same-origin requests with credentials", async () => {
    const calls = stubFetch();
    await apiFetch(new QueryClient(), "/api/readings");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${window.location.origin}/api/readings`);
    expect(calls[0]!.credentials).toBe("include");
    expect(calls[0]!.headers.get(CSRF_HEADER)).toBeNull();
  });

  it.each(["POST", "DELETE"])("adds the cached whoami CSRF token to %s", async (method) => {
    const calls = stubFetch();
    const queryClient = new QueryClient();
    queryClient.setQueryData(whoamiQueryKey, identity("csrf-a"));
    await apiFetch(queryClient, "/api/auth/logout", { method });
    expect(calls[0]!.headers.get(CSRF_HEADER)).toBe("csrf-a");
  });

  it("never reads another QueryClient's token", async () => {
    const calls = stubFetch();
    const a = new QueryClient();
    const b = new QueryClient();
    a.setQueryData(whoamiQueryKey, identity("csrf-a"));
    b.setQueryData(whoamiQueryKey, identity("csrf-b"));
    await apiFetch(b, "/api/auth/logout", { method: "POST" });
    await apiFetch(new QueryClient(), "/api/auth/logout", { method: "POST" });
    expect(calls.map((call) => call.headers.get(CSRF_HEADER))).toEqual(["csrf-b", null]);
  });

  // A fetch that never got a response says whether the browser was offline
  // when it failed, so a page can show offline for it after the browser is
  // back and the query is still carrying the error (#416).
  it.each([true, false])("names a failed fetch a NetworkError, recording offline=%s at the time", async (offline) => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    onlineManager.setOnline(!offline);
    try {
      const failure = await apiFetch(new QueryClient(), "/api/readings").catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(NetworkError);
      expect(failure).toMatchObject({ message: "Failed to fetch", offline });
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it.each(["https://evil.example/api/whoami", "//evil.example/api/whoami", "/health", "api/whoami"])(
    "refuses %s",
    async (path) => {
      const calls = stubFetch();
      await expect(apiFetch(new QueryClient(), path)).rejects.toThrow(/same-origin \/api/);
      expect(calls).toHaveLength(0);
    },
  );
});

describe("fetchIdentity", () => {
  it("reads same-origin /api/whoami with credentials", async () => {
    const calls = stubFetch(Response.json(identity("csrf-a")));
    await expect(fetchIdentity()).resolves.toEqual(identity("csrf-a"));
    expect(calls[0]!.url).toBe(`${window.location.origin}/api/whoami`);
    expect(calls[0]!.credentials).toBe("include");
  });

  it("returns null for 401", async () => {
    stubFetch(Response.json({ error: "unauthorized" }, { status: 401 }));
    await expect(fetchIdentity()).resolves.toBeNull();
  });

  it("throws for 403", async () => {
    stubFetch(Response.json({ error: "forbidden" }, { status: 403 }));
    await expect(fetchIdentity()).rejects.toThrow();
  });
});
