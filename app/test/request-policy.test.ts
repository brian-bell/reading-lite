// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  HTML_CACHE_CONTROL,
  backendPathResponse,
  isBackendPath,
  withNoStore,
} from "../src/server/request-policy";

describe("isBackendPath", () => {
  it.each(["/api", "/api/", "/api/readings", "/api/auth/whoami", "/health", "/mcp", "/mcp/", "/mcpx", "/mcp/sse"])(
    "reserves %s for the backend",
    (pathname) => {
      expect(isBackendPath(pathname)).toBe(true);
    },
  );

  it.each(["/", "/apis", "/apiary", "/healthz", "/health/", "/readings/rd_1", "/save", "/m", "/mc"])(
    "leaves %s to the frontend",
    (pathname) => {
      expect(isBackendPath(pathname)).toBe(false);
    },
  );
});

describe("backendPathResponse", () => {
  it("is an uncached plain-text 404", async () => {
    const response = backendPathResponse();
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(await response.text()).toBe("Not found");
  });
});

describe("withNoStore", () => {
  it("marks rendered responses private and uncacheable", async () => {
    const original = new Response("<!doctype html>", {
      status: 200,
      headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=600" },
    });
    const response = withNoStore(original);
    expect(HTML_CACHE_CONTROL).toBe("private, no-store");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<!doctype html>");
  });

  it("preserves redirects", () => {
    const response = withNoStore(new Response(null, { status: 307, headers: { Location: "/" } }));
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/");
  });
});
