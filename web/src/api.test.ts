import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getAuthSettings,
  getLoginOptions,
  getWhoami,
  requestLoginLink,
  submitReading,
  updateAuthSettings
} from "./api";
import type { UserSettingsResponse, WhoamiResponse } from "./types";

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

  it("treats a null login-options site key as no widget", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ turnstile_site_key: null }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getLoginOptions()).toEqual({ turnstile_site_key: null });
  });

  it("rejects a 200 login-options body that omits or mangles turnstile_site_key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}))
    );
    await expect(getLoginOptions()).rejects.toThrow("failed to load sign-in options");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ turnstile_site_key: 1 }))
    );
    await expect(getLoginOptions()).rejects.toThrow("failed to load sign-in options");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ turnstile_site_key: "" }))
    );
    await expect(getLoginOptions()).rejects.toThrow("failed to load sign-in options");
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

const settingsRow: UserSettingsResponse = {
  user_id: "usr_550e8400-e29b-41d4-a716-446655440000",
  schema_version: 1,
  notify_immediate: true,
  digest_cadence: "off",
  time_zone: "UTC",
  digest_hour_local: 9,
  digest_weekday: 1,
  created_at_ms: 1,
  updated_at_ms: 2
};

describe("GET/POST /api/auth/settings", () => {
  it("loads the full settings row same-origin with credentials", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/auth/settings" && request.method === "GET") {
        return jsonResponse(settingsRow);
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getAuthSettings()).toEqual(settingsRow);
    const req = fetchMock.mock.calls[0]![0] as Request;
    expect(req.method).toBe("GET");
    expect(new URL(req.url).pathname).toBe("/api/auth/settings");
    expect(req.credentials).toBe("include");
    expect(req.headers.get("x-csrf-token")).toBeNull();
  });

  it("rejects a 200 settings body that omits or mangles notify_immediate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ...settingsRow, notify_immediate: 1 }))
    );
    await expect(getAuthSettings()).rejects.toThrow("failed to load settings");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ...settingsRow, digest_cadence: "monthly" }))
    );
    await expect(getAuthSettings()).rejects.toThrow("failed to load settings");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ readings: [] }))
    );
    await expect(getAuthSettings()).rejects.toThrow("failed to load settings");
  });

  it("surfaces GET 404 as ApiError without treating the body as a row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "not found" }, 404))
    );
    await expect(getAuthSettings()).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "not found"
    });
  });

  it("POSTs notify_immediate only with the whoami CSRF HMAC", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami(freshToken));
      if (url.pathname === "/api/auth/settings" && request.method === "POST") {
        return jsonResponse({ ...settingsRow, notify_immediate: false, updated_at_ms: 3 });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getWhoami()).toMatchObject({ csrf_token: freshToken });
    expect(await updateAuthSettings({ notify_immediate: false })).toEqual({
      ...settingsRow,
      notify_immediate: false,
      updated_at_ms: 3
    });
    const post = fetchMock.mock.calls.find((c) => {
      const req = c[0] as Request;
      return req.method === "POST" && new URL(req.url).pathname === "/api/auth/settings";
    });
    expect(post).toBeDefined();
    const req = post![0] as Request;
    expect(req.credentials).toBe("include");
    expect(req.headers.get("x-csrf-token")).toBe(freshToken);
    expect(await req.clone().json()).toEqual({ notify_immediate: false });
  });

  it("does not treat POST 403 as success", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami(freshToken));
      if (url.pathname === "/api/auth/settings" && request.method === "POST") {
        return jsonResponse({ error: "forbidden" }, 403);
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    await getWhoami();
    await expect(updateAuthSettings({ notify_immediate: true })).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
      message: "forbidden"
    });
  });

  it("POSTs digest schedule fields with CSRF and still requires notify_immediate", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami(freshToken));
      if (url.pathname === "/api/auth/settings" && request.method === "POST") {
        return jsonResponse({
          ...settingsRow,
          digest_cadence: "weekly",
          time_zone: "America/New_York",
          digest_hour_local: 8,
          digest_weekday: 5,
          updated_at_ms: 4
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    await getWhoami();
    expect(
      await updateAuthSettings({
        notify_immediate: true,
        digest_cadence: "weekly",
        time_zone: "America/New_York",
        digest_hour_local: 8,
        digest_weekday: 5
      })
    ).toMatchObject({
      digest_cadence: "weekly",
      time_zone: "America/New_York",
      digest_hour_local: 8,
      digest_weekday: 5
    });
    const post = fetchMock.mock.calls.find((c) => {
      const req = c[0] as Request;
      return req.method === "POST" && new URL(req.url).pathname === "/api/auth/settings";
    });
    expect(post).toBeDefined();
    const req = post![0] as Request;
    expect(req.credentials).toBe("include");
    expect(req.headers.get("x-csrf-token")).toBe(freshToken);
    expect(await req.clone().json()).toEqual({
      notify_immediate: true,
      digest_cadence: "weekly",
      time_zone: "America/New_York",
      digest_hour_local: 8,
      digest_weekday: 5
    });
  });

  it("POSTs cadence off with hour, weekday, and time zone still in the body", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/whoami") return jsonResponse(sessionWhoami(freshToken));
      if (url.pathname === "/api/auth/settings" && request.method === "POST") {
        return jsonResponse({
          ...settingsRow,
          digest_cadence: "off",
          time_zone: "Europe/London",
          digest_hour_local: 0,
          digest_weekday: 7,
          updated_at_ms: 5
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    await getWhoami();
    await updateAuthSettings({
      notify_immediate: false,
      digest_cadence: "off",
      time_zone: "Europe/London",
      digest_hour_local: 0,
      digest_weekday: 7
    });
    const post = fetchMock.mock.calls.find((c) => {
      const req = c[0] as Request;
      return req.method === "POST" && new URL(req.url).pathname === "/api/auth/settings";
    });
    expect(await (post![0] as Request).clone().json()).toEqual({
      notify_immediate: false,
      digest_cadence: "off",
      time_zone: "Europe/London",
      digest_hour_local: 0,
      digest_weekday: 7
    });
  });
});
