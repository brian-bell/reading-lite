import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import { ApiError } from "../src/api/errors";
import { fetchLibrary } from "../src/api/library";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";
import { libraryFromResponse, libraryQueryKey, readLibraryFromBackend } from "../src/library";
import type { BackendReads } from "../src/server/backend-reads";

// The library's list read (#413): the mapping both paths share, the server
// render's entrypoint call, and the browser's same-origin request.

const ROW = { id: "rd_1", url: "https://example.com/a", status: "ready", key_prefix: "readings/2026/09/rd_1" };
const PAGE = { readings: [ROW], limit: 20, offset: 0, has_more: false };

describe("libraryFromResponse", () => {
  it("passes a page through, with fields this app never reads untouched", () => {
    expect(libraryFromResponse(200, PAGE)).toEqual({ state: "ready", page: PAGE });
  });

  it("accepts every fixture-pack list row", () => {
    const readings = pack.list_index.items;
    const result = libraryFromResponse(200, { readings, limit: 20, offset: 0, has_more: false });
    expect(result.state === "ready" && result.page.readings.map((row) => row.id)).toEqual(
      readings.map((row) => row.id),
    );
  });

  it("reads an optional source_date on a row and treats null as absent", () => {
    const dated = libraryFromResponse(200, { ...PAGE, readings: [{ ...ROW, source_date: "2024-03-15" }] });
    expect(dated.state === "ready" && dated.page.readings[0]!.source_date).toBe("2024-03-15");
    const cleared = libraryFromResponse(200, { ...PAGE, readings: [{ ...ROW, source_date: null }] });
    expect(cleared.state === "ready" && cleared.page.readings[0]!.source_date).toBeUndefined();
  });

  it("normalises a null field to an absent one", () => {
    const result = libraryFromResponse(200, { ...PAGE, readings: [{ ...ROW, title: null, tags: null }] });
    expect(result.state === "ready" && result.page.readings[0]).not.toHaveProperty("title", null);
    expect(result.state === "ready" && result.page.readings[0]!.title).toBeUndefined();
  });

  it.each([
    ["a body that is not a page", { readings: "none" }],
    ["a row without a url", { ...PAGE, readings: [{ id: "rd_1", status: "ready" }] }],
    ["a row with an unknown status", { ...PAGE, readings: [{ ...ROW, status: "archived" }] }],
  ])("rejects %s", (_label, body) => {
    expect(() => libraryFromResponse(200, body)).toThrow(ApiError);
  });

  it("turns 403 and 412 into states", () => {
    expect(libraryFromResponse(403, { error: "forbidden" })).toEqual({ state: "forbidden" });
    expect(libraryFromResponse(412, { error: "expected tenant mismatch", acting_tenant: "usr_b" })).toEqual({
      state: "account-changed",
      acting_tenant: "usr_b",
    });
  });

  it("throws a 401 so the session-ended machinery sees it", () => {
    const error = catchError(() => libraryFromResponse(401, { error: "unauthorized" }));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
  });

  it("throws anything unexpected, keeping the backend's message", () => {
    expect(() => libraryFromResponse(400, { error: "invalid query" })).toThrow("invalid query");
    expect(() => libraryFromResponse(503, null)).toThrow("library returned 503");
  });
});

describe("libraryQueryKey", () => {
  it("treats empty filters as none", () => {
    expect(libraryQueryKey({ q: "", tag: "", offset: 0 })).toEqual(libraryQueryKey({ offset: 0 }));
  });

  it("keeps different pages and filters apart", () => {
    const keys = [{ offset: 0 }, { offset: 20 }, { q: "rust", offset: 0 }, { tag: "rust", offset: 0 }].map((params) =>
      JSON.stringify(libraryQueryKey(params)),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("readLibraryFromBackend", () => {
  type ListInput = Parameters<BackendReads["list"]>[0];

  function backendReturning(result: { status: number; body: unknown }) {
    return {
      whoami: vi.fn(),
      reading: vi.fn(),
      list: vi.fn(async (_input: ListInput) => result),
    } satisfies BackendReads;
  }

  const request = new Request("https://app.example/?q=ignored", { headers: { cookie: "__Host-session=abc" } });

  it("forwards this request's cookie and host, the parameters, and the pin", async () => {
    const backend = backendReturning({ status: 200, body: PAGE });
    await readLibraryFromBackend(backend, request, { q: "rust", tag: "lang", offset: 20 }, "usr_a");

    expect(backend.list).toHaveBeenCalledWith({
      cookie: "__Host-session=abc",
      host: "app.example",
      q: "rust",
      tag: "lang",
      offset: 20,
      expectedTenant: "usr_a",
    });
  });

  // The entrypoint's input schema is strict, so absent values must be absent,
  // not explicit undefineds.
  it("omits empty filters and a missing pin entirely", async () => {
    const backend = backendReturning({ status: 200, body: PAGE });
    await readLibraryFromBackend(backend, request, { q: "", offset: 0 }, undefined);

    expect(backend.list.mock.calls[0]![0]).toEqual({ cookie: "__Host-session=abc", host: "app.example", offset: 0 });
  });

  it("maps the entrypoint's result the same way the browser maps a response", async () => {
    const backend = backendReturning({ status: 403, body: { error: "forbidden" } });
    await expect(readLibraryFromBackend(backend, request, { offset: 0 }, undefined)).resolves.toEqual({
      state: "forbidden",
    });
  });

  it("turns an unreachable binding into an error", async () => {
    const backend = {
      whoami: vi.fn(),
      reading: vi.fn(),
      list: vi.fn(async (_input: ListInput) => {
        throw new Error("binding is down");
      }),
    } satisfies BackendReads;

    await expect(readLibraryFromBackend(backend, request, { offset: 0 }, undefined)).rejects.toThrow(
      /binding is down/,
    );
  });
});

describe("fetchLibrary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(response: Response) {
    const fetchMock = vi.fn(async (_request: Request) => response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("calls the list endpoint with the session cookie, the parameters, and the tenant pin", async () => {
    const fetchMock = stubFetch(Response.json(PAGE));
    await fetchLibrary(new QueryClient(), { q: "slow reading", tag: "lang", offset: 20 }, "usr_a");

    const request = fetchMock.mock.calls[0]![0];
    const url = new URL(request.url);
    expect(url.pathname).toBe("/api/readings");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "slow reading", tag: "lang", offset: "20" });
    expect(request.method).toBe("GET");
    expect(request.credentials).toBe("include");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
  });

  it("leaves out empty filters, the page size, and a missing pin", async () => {
    const fetchMock = stubFetch(Response.json(PAGE));
    await fetchLibrary(new QueryClient(), { q: "", tag: "", offset: 0 }, undefined);

    const request = fetchMock.mock.calls[0]![0];
    expect(new URL(request.url).search).toBe("?offset=0");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBeNull();
  });

  it("decides from the status when the body is not JSON", async () => {
    stubFetch(new Response("<html>gateway</html>", { status: 502 }));
    await expect(fetchLibrary(new QueryClient(), { offset: 0 }, undefined)).rejects.toBeInstanceOf(ApiError);
  });
});

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
