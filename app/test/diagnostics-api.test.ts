import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import { fetchDiagnostics } from "../src/api/diagnostics";
import { ApiError } from "../src/api/errors";
import { fetchFile } from "../src/api/files";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";

// The browser paths for the Details section (#373): diagnostics on open, and
// the two files on click, each same-origin with the session cookie and pinned
// like the reading.

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

describe("fetchDiagnostics", () => {
  it("calls the diagnostics endpoint with the session cookie and the tenant pin", async () => {
    stubFetch(Response.json(pack.diagnostics.rd_FXATTENT01));
    const result = await fetchDiagnostics(new QueryClient(), "rd_FXATTENT01", "usr_a");

    const request = lastRequest();
    expect(new URL(request.url).pathname).toBe("/api/readings/rd_FXATTENT01/diagnostics");
    expect(request.method).toBe("GET");
    expect(request.credentials).toBe("include");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
    expect(result.state).toBe("ready");
  });

  it("sends no pin without an identity, and escapes the id", async () => {
    stubFetch(Response.json(pack.diagnostics.rd_FXATTENT01));
    await fetchDiagnostics(new QueryClient(), "rd 1/../two", undefined);
    expect(lastRequest().headers.get(EXPECTED_TENANT_HEADER)).toBeNull();
    expect(new URL(lastRequest().url).pathname).toBe("/api/readings/rd%201%2F..%2Ftwo/diagnostics");
  });

  it("decides from the status when the body is not JSON", async () => {
    stubFetch(new Response("<html>gateway</html>", { status: 502 }));
    const failure = await fetchDiagnostics(new QueryClient(), "rd_1", "usr_a").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).message).toBe("diagnostics returned 502");
  });
});

describe("fetchFile", () => {
  it("fetches the extracted Markdown and the raw capture from their endpoints, pinned", async () => {
    stubFetch(new Response("# Hi", { headers: { "content-type": "text/markdown; charset=utf-8" } }));
    const extracted = await fetchFile(new QueryClient(), "rd_1", "extracted", "usr_a");
    expect(extracted.state).toBe("ready");
    expect(new TextDecoder().decode((extracted as { bytes: ArrayBuffer }).bytes)).toBe("# Hi");
    expect(new URL(lastRequest().url).pathname).toBe("/api/readings/rd_1/content");
    expect(lastRequest().headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
    expect(lastRequest().credentials).toBe("include");
    vi.unstubAllGlobals();

    // Bytes stay bytes: a capture may be a PDF or a legacy encoding.
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00]);
    stubFetch(new Response(pdf, { headers: { "content-type": "application/pdf" } }));
    const raw = await fetchFile(new QueryClient(), "rd_1", "raw", "usr_a");
    expect(raw.state).toBe("ready");
    expect(new Uint8Array((raw as { bytes: ArrayBuffer }).bytes)).toEqual(pdf);
    expect(new URL(lastRequest().url).pathname).toBe("/api/readings/rd_1/content/raw");
  });

  it("maps 404, 403, and 412 to states and throws the rest with the backend's message", async () => {
    stubFetch(Response.json({ error: "not found" }, { status: 404 }));
    await expect(fetchFile(new QueryClient(), "rd_1", "raw", "usr_a")).resolves.toEqual({ state: "unavailable" });
    vi.unstubAllGlobals();
    stubFetch(Response.json({ error: "forbidden" }, { status: 403 }));
    await expect(fetchFile(new QueryClient(), "rd_1", "raw", "usr_a")).resolves.toEqual({ state: "forbidden" });
    vi.unstubAllGlobals();
    stubFetch(Response.json({ error: "mismatch", acting_tenant: "usr_b" }, { status: 412 }));
    await expect(fetchFile(new QueryClient(), "rd_1", "raw", "usr_a")).resolves.toEqual({
      state: "account-changed",
      acting_tenant: "usr_b",
    });
    vi.unstubAllGlobals();
    stubFetch(Response.json({ error: "storage unavailable" }, { status: 503 }));
    const failure = await fetchFile(new QueryClient(), "rd_1", "raw", "usr_a").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).message).toBe("storage unavailable");
  });
});
