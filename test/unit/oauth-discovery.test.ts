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

it("does not claim a neighboring well-known path", async () => {
  const app = createApp();
  const response = await app.fetch(new Request("https://readinglite.ai/.well-known/security.txt"), env);
  const type = response.headers.get("content-type") ?? "";
  expect(type).not.toMatch(/^application\/json\b/);
  expect(await response.text()).not.toBe('{"error":"not found"}');
});
