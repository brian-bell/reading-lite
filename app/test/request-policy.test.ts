import { describe, expect, it } from "vitest";
import { httpsRedirect, isBackendPath, withResponsePolicy } from "../src/server/request-policy";

describe("public HTTP", () => {
  it("redirects to the same path and query on https", () => {
    const response = httpsRedirect("http://readinglite.ai/login?next=%2Flibrary&x=1");
    expect(response?.status).toBe(301);
    expect(response?.headers.get("Location")).toBe("https://readinglite.ai/login?next=%2Flibrary&x=1");
  });

  it("leaves localhost, loopback, and the smoke host on http", () => {
    expect(httpsRedirect("http://127.0.0.1:5174/login?next=%2F")).toBeNull();
    expect(httpsRedirect("http://localhost:8787/health")).toBeNull();
    expect(httpsRedirect("http://[::1]/api/auth/login-options")).toBeNull();
    expect(httpsRedirect("http://next.readinglite.test/library?tag=ai")).toBeNull();
    expect(httpsRedirect("https://readinglite.ai/login?next=%2F")).toBeNull();
  });

  it("sends HSTS on public https responses and not on local or http ones", () => {
    const secure = withResponsePolicy(new Response("ok"), "/", "https://readinglite.ai/");
    expect(secure.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
    expect(secure.headers.get("Cache-Control")).toBe("private, no-store");
    expect(secure.headers.get("Content-Security-Policy")).toBe("img-src 'self' https: data:");

    const local = withResponsePolicy(new Response("ok"), "/", "https://127.0.0.1:5174/");
    expect(local.headers.get("Strict-Transport-Security")).toBeNull();

    const smoke = withResponsePolicy(new Response("ok"), "/", "https://next.readinglite.test/");
    expect(smoke.headers.get("Strict-Transport-Security")).toBeNull();

    const plain = withResponsePolicy(new Response("ok"), "/", "http://readinglite.ai/");
    expect(plain.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("answers OAuth discovery from the backend, and leaves other paths to the page", () => {
    for (const path of [
      "/api",
      "/api/whoami",
      "/health",
      "/mcp",
      "/mcp/extra",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/mcp",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      expect(isBackendPath(path), path).toBe(true);
    }
    expect(isBackendPath("/.well-known/security.txt")).toBe(false);
    expect(isBackendPath("/.well-known/oauth-authorization-server-extra")).toBe(false);
    expect(isBackendPath("/library")).toBe(false);
  });
});
