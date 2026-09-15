import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";
import { fetchSource } from "../src/api/source";
import { ApiError } from "../src/api/errors";

// The browser path for the Source view (#372): same-origin GET
// /api/readings/:id/content with the session cookie, pinned like the reading.

function stubFetch(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastRequest(): Request {
  return vi.mocked(fetch).mock.calls[0]![0] as unknown as Request;
}

function markdown(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/markdown; charset=utf-8" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSource", () => {
  it("calls the content endpoint with the session cookie and the tenant pin", async () => {
    stubFetch(markdown("# Hi"));
    await fetchSource(new QueryClient(), "rd_1", "usr_a");

    const request = lastRequest();
    expect(new URL(request.url).pathname).toBe("/api/readings/rd_1/content");
    expect(request.method).toBe("GET");
    expect(request.credentials).toBe("include");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
  });

  it("sends no pin when there is no identity to pin to", async () => {
    stubFetch(markdown("# Hi"));
    await fetchSource(new QueryClient(), "rd_1", undefined);
    expect(lastRequest().headers.get(EXPECTED_TENANT_HEADER)).toBeNull();
  });

  it("escapes the id", async () => {
    stubFetch(markdown("# Hi"));
    await fetchSource(new QueryClient(), "rd 1/../two", "usr_a");
    expect(new URL(lastRequest().url).pathname).toBe("/api/readings/rd%201%2F..%2Ftwo/content");
  });

  it("returns the Markdown as text", async () => {
    stubFetch(markdown("# Title\n\nBody."));
    await expect(fetchSource(new QueryClient(), "rd_1", "usr_a")).resolves.toEqual({
      state: "ready",
      markdown: "# Title\n\nBody.",
    });
  });

  // src/router.ts answers 404 both for a missing reading and for one whose
  // content_status is not "captured": either way there is no source to show.
  it("maps a 404 to the unavailable state", async () => {
    stubFetch(Response.json({ error: "extracted markdown not available" }, { status: 404 }));
    await expect(fetchSource(new QueryClient(), "rd_1", "usr_a")).resolves.toEqual({ state: "unavailable" });
  });

  // The reading's own 403 and 412 have pages of their own (readingFromResponse);
  // the source maps them to values too, because no Retry would change them.
  it("maps 403 and 412 to their states rather than a retryable failure", async () => {
    stubFetch(Response.json({ error: "forbidden" }, { status: 403 }));
    await expect(fetchSource(new QueryClient(), "rd_1", "usr_a")).resolves.toEqual({ state: "forbidden" });
    vi.unstubAllGlobals();
    stubFetch(Response.json({ error: "expected tenant mismatch", acting_tenant: "usr_b" }, { status: 412 }));
    await expect(fetchSource(new QueryClient(), "rd_1", "usr_a")).resolves.toEqual({
      state: "account-changed",
      acting_tenant: "usr_b",
    });
  });

  it("throws the backend's message for any other status", async () => {
    stubFetch(Response.json({ error: "storage unavailable" }, { status: 503 }));
    const failure = await fetchSource(new QueryClient(), "rd_1", "usr_a").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(503);
    expect((failure as ApiError).message).toBe("storage unavailable");
  });

  it("decides from the status when the body is not JSON", async () => {
    stubFetch(new Response("<html>gateway</html>", { status: 502 }));
    const failure = await fetchSource(new QueryClient(), "rd_1", "usr_a").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).message).toBe("source returned 502");
  });
});
