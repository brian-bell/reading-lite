import { afterEach, describe, expect, it, vi } from "vitest";

import { getLoginOptions, getWhoami, requestLoginLink, submitReading } from "./api";
import type { WhoamiResponse } from "./types";

const staleToken = "cd".repeat(32);
const freshToken = "ab".repeat(32);

function sessionWhoami(token: string): WhoamiResponse {
  return {
    tenant_id: "usr_550e8400-e29b-41d4-a716-446655440000",
    user_id: "usr_550e8400-e29b-41d4-a716-446655440000",
    principal: "session",
    tenant_data_plane: true,
    email: "reader@example.com",
    csrf_token: token
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function csrfHeaderFromSubmit(fetchMock: ReturnType<typeof vi.fn>): string | null {
  const post = fetchMock.mock.calls.find((c) => {
    const req = c[0] as Request;
    return req.method === "POST" && new URL(req.url).pathname === "/api/readings";
  });
  return post ? (post[0] as Request).headers.get("x-csrf-token") : null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getWhoami CSRF races", () => {
  it("does not apply CSRF from a cancelled whoami, so the next mutation keeps the newer HMAC", async () => {
    const held = deferred();
    const started = deferred();
    let whoamiCalls = 0;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        whoamiCalls += 1;
        if (whoamiCalls === 1) return jsonResponse(sessionWhoami(freshToken));
        started.resolve();
        await held.promise;
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      if (request.method === "POST" && url.pathname === "/api/readings") {
        return jsonResponse({ id: "rd_NEW", status: "pending", poll: "/api/readings/rd_NEW" }, 202);
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getWhoami()).toMatchObject({ csrf_token: freshToken });

    const controller = new AbortController();
    const cancelled = getWhoami({ signal: controller.signal });
    await started.promise;
    controller.abort();
    held.resolve();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    await submitReading("https://example.com/new");
    expect(csrfHeaderFromSubmit(fetchMock)).toBe(freshToken);
  });

  it("does not restore a stale whoami 200 over a newer token", async () => {
    const held = deferred();
    const started = deferred();
    let whoamiCalls = 0;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        whoamiCalls += 1;
        if (whoamiCalls === 1) {
          started.resolve();
          await held.promise;
          return jsonResponse(sessionWhoami(staleToken));
        }
        return jsonResponse(sessionWhoami(freshToken));
      }
      if (request.method === "POST" && url.pathname === "/api/readings") {
        return jsonResponse({ id: "rd_NEW", status: "pending", poll: "/api/readings/rd_NEW" }, 202);
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    const stale = getWhoami();
    await started.promise;
    expect(await getWhoami()).toMatchObject({ csrf_token: freshToken });
    held.resolve();
    expect(await stale).toMatchObject({ csrf_token: staleToken });

    await submitReading("https://example.com/new");
    expect(csrfHeaderFromSubmit(fetchMock)).toBe(freshToken);
  });

  it("does not let a stale whoami 401/403 clear a newer token", async () => {
    const held = deferred();
    const started = deferred();
    let whoamiCalls = 0;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") {
        whoamiCalls += 1;
        if (whoamiCalls === 1) {
          started.resolve();
          await held.promise;
          return jsonResponse({ error: "forbidden" }, 403);
        }
        return jsonResponse(sessionWhoami(freshToken));
      }
      if (request.method === "POST" && url.pathname === "/api/readings") {
        return jsonResponse({ id: "rd_NEW", status: "pending", poll: "/api/readings/rd_NEW" }, 202);
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    const stale = getWhoami();
    await started.promise;
    expect(await getWhoami()).toMatchObject({ csrf_token: freshToken });
    held.resolve();
    expect(await stale).toBeNull();

    await submitReading("https://example.com/new");
    expect(csrfHeaderFromSubmit(fetchMock)).toBe(freshToken);
  });
});

describe("login-options and magic-link challenge", () => {
  it("loads login-options same-origin with credentials and a nullable site key", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/auth/login-options") {
        return jsonResponse({ turnstile_site_key: "1x00000000000000000000AA" });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getLoginOptions()).toEqual({ turnstile_site_key: "1x00000000000000000000AA" });
    const req = fetchMock.mock.calls[0]![0] as Request;
    expect(req.method).toBe("GET");
    expect(new URL(req.url).pathname).toBe("/api/auth/login-options");
    expect(req.credentials).toBe("include");
  });

  it("treats a null or blank login-options site key as no widget", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ turnstile_site_key: null }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getLoginOptions()).toEqual({ turnstile_site_key: null });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ turnstile_site_key: "  " })));
    expect(await getLoginOptions()).toEqual({ turnstile_site_key: null });
  });

  it("omits turnstile_token unless a token is provided", async () => {
    const fetchMock = vi.fn(async (_request: Request) => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await requestLoginLink("invited@example.com");
    expect(await (fetchMock.mock.calls[0][0] as Request).clone().json()).toEqual({
      email: "invited@example.com"
    });

    await requestLoginLink("invited@example.com", "widget-ok");
    expect(await (fetchMock.mock.calls[1][0] as Request).clone().json()).toEqual({
      email: "invited@example.com",
      turnstile_token: "widget-ok"
    });
  });
});
