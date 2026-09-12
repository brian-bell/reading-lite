import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPECTED_TENANT_HEADER, fetchReading } from "../src/api/readings";
import { ApiError } from "../src/api/errors";

// The browser path: same-origin GET /api/readings/:id with the session cookie,
// pinned to the account the page was rendered for.

const READY = { id: "rd_1", url: "https://example.com/a", status: "ready" };

function stubFetch(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastRequest(): Request {
  return vi.mocked(fetch).mock.calls[0]![0] as unknown as Request;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchReading", () => {
  it("calls the reading endpoint with the session cookie and the tenant pin", async () => {
    stubFetch(Response.json(READY));
    await fetchReading(new QueryClient(), "rd_1", "usr_a");

    const request = lastRequest();
    expect(new URL(request.url).pathname).toBe("/api/readings/rd_1");
    expect(request.method).toBe("GET");
    expect(request.credentials).toBe("include");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
  });

  it("sends no pin when there is no identity to pin to", async () => {
    stubFetch(Response.json(READY));
    await fetchReading(new QueryClient(), "rd_1", undefined);

    expect(lastRequest().headers.get(EXPECTED_TENANT_HEADER)).toBeNull();
  });

  // Reading ids come off the URL, so the path is built rather than concatenated.
  it("escapes the id", async () => {
    stubFetch(Response.json(READY));
    await fetchReading(new QueryClient(), "rd 1/../two", "usr_a");

    expect(new URL(lastRequest().url).pathname).toBe("/api/readings/rd%201%2F..%2Ftwo");
  });

  it("maps the response the same way the server render does", async () => {
    stubFetch(Response.json({ error: "not found" }, { status: 404 }));
    await expect(fetchReading(new QueryClient(), "rd_1", undefined)).resolves.toEqual({ state: "not-found" });
  });

  it("decides from the status when the body is not JSON", async () => {
    stubFetch(new Response("<html>gateway</html>", { status: 502 }));
    await expect(fetchReading(new QueryClient(), "rd_1", undefined)).rejects.toBeInstanceOf(ApiError);
  });
});
