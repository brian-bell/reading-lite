// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  HTML_CACHE_CONTROL,
  backendPathResponse,
  isBackendPath,
  withResponsePolicy,
  CONTENT_SECURITY_POLICY,
} from "../src/server/request-policy";

describe("isBackendPath", () => {
  it.each(["/api", "/api/", "/api/readings", "/api/auth/whoami", "/health", "/mcp", "/mcp/", "/mcpx", "/mcp/sse"])(
    "reserves %s for the backend",
    (pathname) => {
      expect(isBackendPath(pathname)).toBe(true);
    },
  );

  it.each(["/", "/apis", "/apiary", "/healthz", "/health/", "/readings/rd_1", "/save", "/m", "/mc", "/terms", "/privacy", "/dmca"])(
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

describe("withResponsePolicy", () => {
  it("marks rendered responses private and uncacheable", async () => {
    const original = new Response("<!doctype html>", {
      status: 200,
      headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=600" },
    });
    const response = withResponsePolicy(original);
    expect(HTML_CACHE_CONTROL).toBe("private, no-store");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<!doctype html>");
  });

  // Design spec, Source content: the policy must allow remote https: images for
  // "Load image", and the issue (#372) says nothing broader. data: is the
  // theme's grain SVG in tokens.css; img-src governs background images too.
  it("allows the page's own, remote https:, and data: images and nothing broader", () => {
    const response = withResponsePolicy(new Response("<!doctype html>"));
    expect(CONTENT_SECURITY_POLICY).toBe("img-src 'self' https: data:");
    expect(response.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/http:|\*/);
  });

  it("preserves redirects", () => {
    const response = withResponsePolicy(new Response(null, { status: 307, headers: { Location: "/" } }));
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/");
  });

  it.each(["/terms", "/privacy", "/dmca"])("leaves %s off private, no-store", (pathname) => {
    const original = new Response("<!doctype html>", {
      headers: { "Content-Type": "text/html", "Cache-Control": "private, no-store" },
    });
    const response = withResponsePolicy(original, pathname);
    expect(response.headers.get("Cache-Control")).toBeNull();
    expect(response.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(response.headers.get("Content-Type")).toBe("text/html");
  });
});
