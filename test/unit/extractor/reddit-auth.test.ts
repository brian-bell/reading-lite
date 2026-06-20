import { describe, expect, it } from "vitest";
import { BadStatusError, FetchTimeoutError, OversizedResponseError } from "../../../src/modules/extractor";
import { fetchRedditToken } from "../../../src/modules/extractor/reddit-auth";

describe("fetchRedditToken", () => {
  it("posts client credentials grant with Basic auth and a descriptive user-agent", async () => {
    let recorded: { url: string; init?: RequestInit } | undefined;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      recorded = { url, init };
      return new Response(JSON.stringify({ access_token: "token-123" }), {
        headers: { "content-type": "application/json" },
      });
    };

    const token = await fetchRedditToken({
      fetch: fetchFn,
      clientId: "client-id",
      clientSecret: "client-secret",
      userAgent: "web:reading-lite:test (by /u/tester)",
    });

    expect(token).toBe("token-123");
    expect(recorded?.url).toBe("https://www.reddit.com/api/v1/access_token");
    expect(recorded?.init?.method).toBe("POST");
    const headers = new Headers(recorded?.init?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${btoa("client-id:client-secret")}`);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(headers.get("user-agent")).toBe("web:reading-lite:test (by /u/tester)");
    expect(recorded?.init?.body).toBe("grant_type=client_credentials");
  });

  it("throws BadStatusError for non-ok token responses", async () => {
    const fetchFn = async (): Promise<Response> => new Response("nope", { status: 401 });

    await expect(
      fetchRedditToken({ fetch: fetchFn, clientId: "client-id", clientSecret: "client-secret" }),
    ).rejects.toBeInstanceOf(BadStatusError);
  });

  it("throws RateLimitedError for 429 token responses", async () => {
    const fetchFn = async (): Promise<Response> =>
      new Response("slow down", { status: 429, headers: { "retry-after": "3" } });

    await expect(
      fetchRedditToken({
        fetch: fetchFn,
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
    ).rejects.toMatchObject({ name: "RateLimitedError", retryAfterMs: 3_000 });
  });

  it("applies timeout and maxBytes bounds to token responses", async () => {
    const neverFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });

    await expect(
      fetchRedditToken({
        fetch: neverFetch,
        clientId: "client-id",
        clientSecret: "client-secret",
        timeoutMs: 1,
      }),
    ).rejects.toBeInstanceOf(FetchTimeoutError);

    const tooBigFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ access_token: "token-123" }), {
        headers: { "content-length": "1000" },
      });

    await expect(
      fetchRedditToken({
        fetch: tooBigFetch,
        clientId: "client-id",
        clientSecret: "client-secret",
        maxBytes: 10,
      }),
    ).rejects.toBeInstanceOf(OversizedResponseError);
  });
});
