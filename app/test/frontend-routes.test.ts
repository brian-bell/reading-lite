// @vitest-environment node
import { unstable_readConfig } from "wrangler";
import { describe, expect, it } from "vitest";
import type { EnvironmentLabel } from "../config/backend-bindings";

// ADR 0003 (amended 2026-09-13): the frontend owns `host/*` on one preview host
// per environment, and the backend of the same environment keeps the more
// specific /api/* and /health routes on that host. Without those, /api/* on the
// host would reach this Worker and 404, so a frontend route is only valid when
// its own backend already routes the API there.

type Route = { pattern: string; zone_name?: string };

function routes(configPath: string, env: string | undefined): Route[] {
  const config: { routes?: Array<string | Route> } = unstable_readConfig(
    { config: configPath, env },
    { hideWarnings: true },
  );
  return (config.routes ?? []).map((route) => (typeof route === "string" ? { pattern: route } : route));
}

const PREVIEW_HOST: Record<Exclude<EnvironmentLabel, "local">, string> = {
  staging: "next-staging.readinglite.ai",
  production: "next.readinglite.ai",
};

describe("frontend Worker routes", () => {
  it("attach nothing to the local config", () => {
    expect(routes("wrangler.jsonc", undefined)).toEqual([]);
  });

  it.each(["staging", "production"] as const)("attach the %s frontend to its preview host only", (label) => {
    expect(routes("wrangler.jsonc", label)).toEqual([
      { pattern: `${PREVIEW_HOST[label]}/*`, zone_name: "readinglite.ai" },
    ]);
  });

  it.each(["staging", "production"] as const)(
    "sit behind %s backend API and health routes on the same host",
    (label) => {
      const env = label;
      const backend = routes("../wrangler.toml", env).map(({ pattern }) => pattern);
      for (const { pattern } of routes("wrangler.jsonc", env)) {
        const host = pattern.replace(/\/\*$/, "");
        expect(backend).toContain(`${host}/api/*`);
        expect(backend).toContain(`${host}/health`);
      }
      // The other environment's backend never serves this environment's host.
      const other = label === "staging" ? "production" : "staging";
      const otherBackend = routes("../wrangler.toml", other).map(({ pattern }) => pattern);
      expect(otherBackend.some((pattern) => pattern.startsWith(`${PREVIEW_HOST[label]}/`))).toBe(false);
    },
  );
});
