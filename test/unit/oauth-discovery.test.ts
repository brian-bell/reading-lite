import { expect, it } from "vitest";
import type { Env } from "../../src/index";
import { createApp } from "../../src/router";

const OAUTH_DISCOVERY_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/openid-configuration",
  "/.well-known/openid-configuration/mcp",
] as const;

const MCP_AUTH_FALLBACK_PATHS = [
  "/register",
  "/authorize",
  "/token",
  "/sse",
  "/.well-known/mcp.json",
  "/.well-known/oauth-authorization-server.json",
] as const;

const env = { CORS_ALLOWED_ORIGINS: "" } as Env;

it("answers OAuth discovery with a JSON 404 for HTML and JSON clients", async () => {
  const app = createApp();
  for (const path of OAUTH_DISCOVERY_PATHS) {
    for (const accept of ["text/html", "application/json"]) {
      const response = await app.fetch(
        new Request(`https://readinglite.ai${path}`, { headers: { accept } }),
        env,
      );
      expect(response.status, `${accept} ${path}`).toBe(404);
      expect(response.headers.get("content-type"), `${accept} ${path}`).toMatch(/^application\/json\b/);
      expect(await response.json(), `${accept} ${path}`).toEqual({ error: "not found" });
    }
  }
});

it("answers MCP auth fallback paths with a JSON 404 for every method", async () => {
  const app = createApp();
  for (const path of MCP_AUTH_FALLBACK_PATHS) {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const response = await app.fetch(new Request(`https://readinglite.ai${path}`, { method }), env);
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.headers.get("content-type"), `${method} ${path}`).toMatch(/^application\/json\b/);
      expect(await response.json(), `${method} ${path}`).toEqual({ error: "not found" });
    }
  }
});

it("does not claim a neighboring well-known path", async () => {
  const app = createApp();
  for (const path of ["/.well-known/security.txt", "/registered", "/tokens"]) {
    const response = await app.fetch(new Request(`https://readinglite.ai${path}`), env);
    const type = response.headers.get("content-type") ?? "";
    expect(type, path).not.toMatch(/^application\/json\b/);
    expect(await response.text(), path).not.toBe('{"error":"not found"}');
  }
});
