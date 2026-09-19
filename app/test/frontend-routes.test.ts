// @vitest-environment node
import { unstable_readConfig } from "wrangler";
import { describe, expect, it } from "vitest";
import type { EnvironmentLabel } from "../config/backend-bindings";

// ADR 0003 (amended 2026-09-13): the frontend owns `host/*` on one preview host
// per environment, and the backend of the same environment keeps the more
// specific /api/* and /health routes on that host. Without those, /api/* on the
// host would reach this Worker and 404, so a frontend route is only valid when
// its own backend already routes the API there. Staging switched at Phase 4
// parity (#339, 2026-09-16), so the staging frontend also owns both staging
// hosts. Production switched the same way at the Phase 5 cutover
// (reading-lite-gh340.4, 2026-09-19) and also owns both apex hosts.

type Route = { pattern: string; zone_name?: string };

function routes(configPath: string, env: string | undefined): Route[] {
  const config: { routes?: Array<string | Route> } = unstable_readConfig(
    { config: configPath, env },
    { hideWarnings: true },
  );
  return (config.routes ?? []).map((route) => (typeof route === "string" ? { pattern: route } : route));
}

const HOSTS: Record<Exclude<EnvironmentLabel, "local">, Route[]> = {
  staging: [
    { pattern: "next-staging.readinglite.ai/*", zone_name: "readinglite.ai" },
    { pattern: "staging.readinglite.ai/*", zone_name: "readinglite.ai" },
    { pattern: "staging.readinglite.app/*", zone_name: "readinglite.app" },
  ],
  production: [
    { pattern: "next.readinglite.ai/*", zone_name: "readinglite.ai" },
    { pattern: "readinglite.ai/*", zone_name: "readinglite.ai" },
    { pattern: "readinglite.app/*", zone_name: "readinglite.app" },
  ],
};

describe("frontend Worker routes", () => {
  it("attach nothing to the local config", () => {
    expect(routes("wrangler.jsonc", undefined)).toEqual([]);
  });

  it.each(["staging", "production"] as const)("attach the %s frontend to exactly its own hosts", (label) => {
    expect(routes("wrangler.jsonc", label)).toEqual(HOSTS[label]);
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
      // The other environment's backend never serves this environment's hosts.
      const other = label === "staging" ? "production" : "staging";
      const otherBackend = routes("../wrangler.toml", other).map(({ pattern }) => pattern);
      for (const { pattern } of HOSTS[label]) {
        const host = pattern.replace(/\/\*$/, "");
        expect(otherBackend.some((backendPattern) => backendPattern.startsWith(`${host}/`))).toBe(false);
      }
    },
  );
});
