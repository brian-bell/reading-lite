import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";
import { fetchTokens } from "../src/api/tokens";

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
