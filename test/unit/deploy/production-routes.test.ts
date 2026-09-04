import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Route = { pattern: string; zone_name: string };

/**
 * Collect the `[[<table>]]` route blocks from wrangler.toml. Deliberately a
 * small hand parser: the repo has no TOML dependency, and the assertion we
 * care about is the exact set of (pattern, zone) pairs per environment.
 */
function routesFor(toml: string, table: string): Route[] {
  const lines = toml.split("\n");
  const routes: Route[] = [];
  let current: Partial<Route> | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      if (current?.pattern && current.zone_name) {
        routes.push({ pattern: current.pattern, zone_name: current.zone_name });
      }
      current = line === `[[${table}]]` ? {} : null;
      continue;
    }
    if (!current) continue;
    const match = /^(pattern|zone_name)\s*=\s*"([^"]*)"$/.exec(line);
    if (match) current[match[1] as keyof Route] = match[2];
  }
  if (current?.pattern && current.zone_name) {
    routes.push({ pattern: current.pattern, zone_name: current.zone_name });
  }
  return routes;
}

const wrangler = readFileSync("wrangler.toml", "utf8");

describe("production worker routes", () => {
  const routes = routesFor(wrangler, "env.production.routes");

  it("keeps the reading-lite.bbell.dev routes while dual-serving", () => {
    expect(routes).toEqual(
      expect.arrayContaining([
        { pattern: "reading-lite.bbell.dev/api/*", zone_name: "bbell.dev" },
        { pattern: "reading-lite.bbell.dev/health", zone_name: "bbell.dev" },
        { pattern: "reading-lite.bbell.dev/mcp*", zone_name: "bbell.dev" },
      ]),
    );
  });

  it("serves the same three path sets on bbookmarks.com", () => {
    expect(routes).toEqual(
      expect.arrayContaining([
        { pattern: "bbookmarks.com/api/*", zone_name: "bbookmarks.com" },
        { pattern: "bbookmarks.com/health", zone_name: "bbookmarks.com" },
        { pattern: "bbookmarks.com/mcp*", zone_name: "bbookmarks.com" },
      ]),
    );
  });

  it("routes exactly those six patterns and nothing else", () => {
    // `www` is handled by a Cloudflare redirect rule, not by a worker route.
    expect(routes).toHaveLength(6);
    expect(routes.some((route) => route.pattern.startsWith("www."))).toBe(false);
  });
});

describe("staging worker routes", () => {
  it("stays on bbell.dev, untouched by the production domain move", () => {
    expect(routesFor(wrangler, "env.staging.routes")).toEqual([
      { pattern: "reading-lite-staging.bbell.dev/api/*", zone_name: "bbell.dev" },
      { pattern: "reading-lite-staging.bbell.dev/health", zone_name: "bbell.dev" },
      { pattern: "reading-lite-staging.bbell.dev/mcp*", zone_name: "bbell.dev" },
    ]);
  });
});
