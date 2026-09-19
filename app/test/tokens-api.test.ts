import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "../src/api/client";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";
import { fetchTokens, revokeToken } from "../src/api/tokens";
import { whoamiQueryKey } from "../src/identity";

function lastRequest(): Request {
  return vi.mocked(fetch).mock.calls[0]![0] as unknown as Request;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTokens", () => {
  it.each([
    ["the tenant pin", "usr_a", "usr_a"],
    ["no pin when there is no identity to pin to", undefined, null],
  ])("calls the tokens endpoint with the session cookie and %s", async (_, expected, header) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tokens: [] })));
    await fetchTokens(new QueryClient(), expected);

    const request = lastRequest();
    expect(new URL(request.url).pathname).toBe("/api/auth/tokens");
    expect(request.method).toBe("GET");
    expect(request.credentials).toBe("include");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe(header);
  });
});

describe("revokeToken", () => {
  it("deletes the token with CSRF and the tenant pin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
    const queryClient = new QueryClient();
    queryClient.setQueryData(whoamiQueryKey, { csrf_token: "csrf-a" });

    await expect(revokeToken(queryClient, "tok_1", "usr_a")).resolves.toEqual({ kind: "revoked" });

    const request = lastRequest();
    expect(new URL(request.url).pathname).toBe("/api/auth/tokens/tok_1");
    expect(request.method).toBe("DELETE");
    expect(request.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
  });
});
